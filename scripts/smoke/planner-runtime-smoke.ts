import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const COMPOSE_FILE = resolve('docker-compose.yml')
const FAKE_TOKEN_PREFIX = 'o01-smoke-token-'
const SERVICE_NAMES = [
  'postgres',
  'redis-auth',
  'migrator',
  'api',
  'planner-worker',
]
const MAX_RUNTIME_MS = 600_000
const workAbortController = new AbortController()
let interruptSignal: NodeJS.Signals | undefined

type ComposeService = {
  image?: string
  command?: string[]
  depends_on?: Record<string, { condition?: string }>
  restart?: string
  stop_grace_period?: string
  healthcheck?: { test?: string[] }
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>
  volumes?: Array<{ type?: string; source?: string; target?: string }>
}

type ComposeConfig = { services?: Record<string, ComposeService> }
type Container = {
  Id: string
  Name: string
  Config: { Labels?: Record<string, string> }
  RestartCount: number
  State: {
    Status: string
    Running: boolean
    ExitCode: number
    OOMKilled: boolean
    StartedAt: string
    FinishedAt: string
    Health?: { Status: string }
  }
}

class HostBindCollisionError extends Error {}

class CommandError extends Error {
  public constructor(
    public readonly command: string,
    public readonly exitCode: number | undefined,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    super(`${command} exited with ${exitCode ?? 'unknown'}`)
  }
}

type CommandOptions = {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  nonAbortable?: boolean
}

function token(): string {
  return `${FAKE_TOKEN_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isBindCollision(error: unknown): boolean {
  return (
    error instanceof CommandError &&
    /port is already allocated|address already in use|bind.*failed/i.test(
      `${error.stderr}\n${error.stdout}`,
    )
  )
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const rendered = [command, ...args].join(' ')
  const signal = options.nonAbortable
    ? undefined
    : (options.signal ?? workAbortController.signal)
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolvePromise, rejectPromise) => {
      let child: ReturnType<typeof execFile> | undefined
      let callbackDone = false
      let closeDone = false
      let callbackError: { code?: number | string | null } | null = null
      let callbackStdout = ''
      let callbackStderr = ''
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const cleanupListeners = (): void => {
        signal?.removeEventListener('abort', onAbort)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      }

      const finish = (): void => {
        if (!callbackDone || !closeDone || settled) return
        settled = true
        cleanupListeners()
        if (callbackError !== null) {
          rejectPromise(
            new CommandError(
              rendered,
              typeof callbackError.code === 'number'
                ? callbackError.code
                : undefined,
              callbackStderr,
              callbackStdout,
            ),
          )
          return
        }
        resolvePromise({ stdout: callbackStdout, stderr: callbackStderr })
      }

      const terminateChild = (): void => {
        if (child === undefined || closeDone) return
        child.kill('SIGTERM')
        if (killTimer === undefined) {
          killTimer = setTimeout(() => {
            if (!closeDone) child?.kill('SIGKILL')
            killTimer = undefined
          }, 1_000)
        }
      }

      const onAbort = (): void => {
        terminateChild()
      }

      try {
        child = execFile(
          command,
          args,
          {
            cwd: process.cwd(),
            env: options.env ?? process.env,
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            callbackDone = true
            callbackError = error
            callbackStdout = stdout
            callbackStderr = stderr
            finish()
          },
        )
        child.once('error', (error: { code?: number | string | null }) => {
          if (!callbackDone) {
            callbackDone = true
            callbackError = error
          }
          if (child?.pid === undefined) {
            // No process was spawned, so there can be no close event.
            closeDone = true
            finish()
          }
        })
        child.once('close', () => {
          closeDone = true
          finish()
        })
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
        timeoutTimer = setTimeout(terminateChild, options.timeoutMs ?? 30_000)
      } catch (error: unknown) {
        cleanupListeners()
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    },
  )
}

async function delay(
  ms: number,
  signal = workAbortController.signal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('operation aborted')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      rejectPromise(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('operation aborted'),
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function composeArgs(project: string, args: string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, '--project-name', project, ...args]
}

function runtimeEnv(
  project: string,
  ports: { postgres: number; redis: number; api: number },
  image: string,
  fakeToken: string,
): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.TELEGRAM_BOT_TOKEN
  env.TELEGRAM_BOT_TOKEN = fakeToken
  env.PLANNER_RUNTIME_IMAGE = image
  env.POSTGRES_PORT = String(ports.postgres)
  env.REDIS_AUTH_PORT = String(ports.redis)
  env.API_PORT = String(ports.api)
  env.COMPOSE_PROJECT_NAME = project
  return env
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise())
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  )
  return port
}

async function ports(): Promise<{
  postgres: number
  redis: number
  api: number
}> {
  const values = await Promise.all([freePort(), freePort(), freePort()])
  return { postgres: values[0], redis: values[1], api: values[2] }
}

function projectName(): string {
  return `planner-o01-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function imageTag(project: string): string {
  return `planner:o01-${project.slice('planner-o01-'.length)}`
}

async function composeConfig(env: NodeJS.ProcessEnv): Promise<ComposeConfig> {
  const result = await runCommand(
    'docker',
    composeArgs('planner-o01-static', ['config', '--format', 'json']),
    { env },
  )
  return JSON.parse(result.stdout) as ComposeConfig
}

function expectDependsOn(
  service: ComposeService,
  expected: Record<string, string>,
): void {
  const actual = Object.fromEntries(
    Object.entries(service.depends_on ?? {}).map(([name, value]) => [
      name,
      value.condition,
    ]),
  )
  assert.deepEqual(actual, expected)
}

async function staticPreflight(): Promise<void> {
  const env = { ...process.env }
  delete env.TELEGRAM_BOT_TOKEN
  env.TELEGRAM_BOT_TOKEN = `${FAKE_TOKEN_PREFIX}static-preflight-token`
  const config = await composeConfig(env)
  const services = config.services ?? {}
  assert.deepEqual(Object.keys(services).sort(), [...SERVICE_NAMES].sort())
  assert.deepEqual(services['planner-worker']?.command, [
    'node',
    'dist/bootstrap/planner-worker/main.js',
  ])
  const composeText = await readFile(COMPOSE_FILE, 'utf8')
  assert.match(
    composeText,
    /image:\s+\$\{PLANNER_RUNTIME_IMAGE:-planner:local\}/,
  )
  assert.equal(services.api?.restart, 'unless-stopped')
  assert.equal(services['planner-worker']?.restart, 'unless-stopped')
  assert.equal(services.api?.stop_grace_period, '15s')
  assert.equal(services['planner-worker']?.stop_grace_period, '15s')
  assert.equal(services.migrator?.restart, 'no')
  assert.equal(
    services.postgres?.image?.startsWith('postgres:18.4-trixie@sha256:'),
    true,
  )
  assert.equal(
    services['redis-auth']?.image?.startsWith('redis:8.8.0-trixie@sha256:'),
    true,
  )
  assert.equal(services['redis-auth']?.ports?.length ?? 0, 1)
  assert.equal(services.postgres?.ports?.length ?? 0, 1)
  assert.equal(services.api?.ports?.length ?? 0, 1)
  assert.equal(services.api?.ports?.[0]?.host_ip, '127.0.0.1')
  assert.equal(services.postgres?.ports?.[0]?.host_ip, '127.0.0.1')
  assert.equal(services['redis-auth']?.ports?.[0]?.host_ip, '127.0.0.1')
  expectDependsOn(services.migrator ?? {}, {
    postgres: 'service_healthy',
  })
  expectDependsOn(services.api ?? {}, {
    migrator: 'service_completed_successfully',
    'redis-auth': 'service_healthy',
  })
  expectDependsOn(services['planner-worker'] ?? {}, {
    migrator: 'service_completed_successfully',
  })
  assert.equal('queue-redis' in services, false)
  assert.match(
    services.api?.healthcheck?.test?.join(' ') ?? '',
    /health\/ready/,
  )
  assert.match(services.api?.healthcheck?.test?.join(' ') ?? '', /fetch/)
  assert.equal(services['planner-worker']?.healthcheck, undefined)
  const imageEnv = {
    ...env,
    PLANNER_RUNTIME_IMAGE: 'planner:o01-static-contract',
  }
  const resolved = await composeConfig(imageEnv)
  for (const serviceName of ['migrator', 'api', 'planner-worker']) {
    assert.equal(
      resolved.services?.[serviceName]?.image,
      imageEnv.PLANNER_RUNTIME_IMAGE,
    )
  }
  assert.equal(
    resolved.services?.postgres?.image,
    'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a',
  )
  assert.equal(
    resolved.services?.['redis-auth']?.image,
    'redis:8.8.0-trixie@sha256:234c902a2db49461a129e2d4aeff85b28cf20187ed274a67f6e50995fa713c7b',
  )
  assert.deepEqual(resolved.services?.postgres?.volumes, [
    {
      type: 'volume',
      source: 'postgres-data',
      target: '/var/lib/postgresql',
      volume: {},
    },
  ])
  assert.deepEqual(resolved.services?.['redis-auth']?.volumes, [
    { type: 'volume', source: 'redis-auth-data', target: '/data', volume: {} },
  ])
  console.log('static preflight: PASS')
}

async function inspectContainer(container: string): Promise<Container> {
  const result = await runCommand('docker', ['inspect', container])
  const value = JSON.parse(result.stdout) as Container[]
  assert.equal(value.length, 1)
  const containerState = value[0]
  assert(containerState !== undefined)
  return containerState
}

async function serviceContainer(
  project: string,
  service: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runCommand(
    'docker',
    composeArgs(project, ['ps', '-aq', service]),
    { env },
  )
  const id = result.stdout.trim().split('\n')[0]
  assert(id !== undefined)
  assert.match(id, /^[0-9a-f]+$/)
  return id
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    if (workAbortController.signal.aborted)
      throw workAbortController.signal.reason ?? new Error('operation aborted')
    try {
      if (await predicate()) return
    } catch (error: unknown) {
      lastError = error
    }
    await delay(1_000)
  }
  const detail = lastError instanceof Error ? lastError.message : ''
  throw new Error(`timeout waiting for ${description}: ${detail}`)
}

async function health(
  url: string,
  signal = workAbortController.signal,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal })
  return { status: response.status, body: await response.json() }
}

async function assertHealth(
  url: string,
  status: number,
  body: unknown,
): Promise<void> {
  const actual = await health(url)
  assert.equal(actual.status, status)
  assert.deepEqual(actual.body, body)
}

async function migrationInventory(
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const result = await runCommand(
    'docker',
    composeArgs(project, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'planner',
      '-d',
      'planner',
      '-At',
      '-c',
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    ]),
    { env },
  )
  return result.stdout.trim() === ''
    ? []
    : result.stdout.trim().split('\n').sort()
}

async function localMigrationInventory(): Promise<string[]> {
  const names = await readdir(resolve('prisma/migrations'), {
    withFileTypes: true,
  })
  return names
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function notificationAttemptCount(
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const result = await runCommand(
    'docker',
    composeArgs(project, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'planner',
      '-d',
      'planner',
      '-At',
      '-c',
      'SELECT count(*) FROM notification_attempts',
    ]),
    { env },
  )
  return Number(result.stdout.trim())
}

async function readyWorkerEventCount(container: string): Promise<number> {
  const result = await runCommand('docker', ['logs', '--timestamps', container])
  return result.stdout
    .split('\n')
    .filter((line) =>
      line.endsWith('{"event":"planner_worker_ready","module":"bootstrap"}'),
    ).length
}

async function assertContainerPid1(
  container: string,
  expectedCommand: string,
): Promise<void> {
  const result = await runCommand('docker', [
    'exec',
    container,
    'node',
    '-e',
    "const fs=require('node:fs'); process.stdout.write(fs.readFileSync('/proc/1/cmdline','utf8').replaceAll('\\u0000',' '))",
  ])
  assert.match(result.stdout, /node/)
  assert.equal(result.stdout.includes(expectedCommand), true)
}

async function terminateContainerPid1(container: string): Promise<void> {
  try {
    await runCommand('docker', [
      'exec',
      '--user',
      'node',
      container,
      '/bin/sh',
      '-c',
      'kill -TERM 1',
    ])
  } catch (error: unknown) {
    if (!(error instanceof CommandError)) throw error
  }
}

async function assertProjectContainers(project: string): Promise<void> {
  const result = await runCommand('docker', [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Names}}',
  ])
  const names =
    result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n').sort()
  assert.deepEqual(
    names,
    SERVICE_NAMES.map((service) => `${project}-${service}-1`).sort(),
  )
}

async function diagnostics(
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const ps = await runCommand(
      'docker',
      [
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.Names}} {{.Status}}',
      ],
      { nonAbortable: true },
    )
    console.error(`safe diagnostics ps:\n${ps.stdout.slice(0, 4_000)}`)
    const logs = await runCommand(
      'docker',
      composeArgs(project, ['logs', '--no-color', '--tail', '80']),
      { env, nonAbortable: true },
    )
    console.error(`safe diagnostics logs:\n${logs.stdout.slice(0, 12_000)}`)
  } catch {
    console.error('safe diagnostics unavailable')
  }
}

async function cleanup(
  project: string,
  image: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runCommand('docker', composeArgs(project, ['unpause', 'redis-auth']), {
    env,
    timeoutMs: 10_000,
    nonAbortable: true,
  }).catch(() => undefined)
  await runCommand(
    'docker',
    composeArgs(project, ['down', '--volumes', '--remove-orphans']),
    { env, timeoutMs: 30_000, nonAbortable: true },
  ).catch(() => undefined)
  await runCommand('docker', ['image', 'rm', image], {
    env,
    timeoutMs: 30_000,
    nonAbortable: true,
  }).catch(() => undefined)
  const containers = await runCommand(
    'docker',
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
    { nonAbortable: true },
  )
  const volumes = await runCommand(
    'docker',
    [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    { nonAbortable: true },
  )
  const networks = await runCommand(
    'docker',
    [
      'network',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    { nonAbortable: true },
  )
  let imageCheck = true
  try {
    await runCommand('docker', ['image', 'inspect', image], {
      nonAbortable: true,
    })
  } catch (error: unknown) {
    if (error instanceof CommandError) {
      const detail = `${error.stderr}\n${error.stdout}`
      if (/No such image/i.test(detail)) imageCheck = false
      else throw error
    } else {
      throw error
    }
  }
  assert.equal(containers.stdout.trim(), '')
  assert.equal(volumes.stdout.trim(), '')
  assert.equal(networks.stdout.trim(), '')
  assert.equal(imageCheck, false)
}

async function runtimeSmoke(): Promise<void> {
  let retried = false
  for (;;) {
    const project = projectName()
    const image = imageTag(project)
    const allocatedPorts = await ports()
    const fakeToken = token()
    const env = runtimeEnv(project, allocatedPorts, image, fakeToken)
    const apiBase = `http://127.0.0.1:${allocatedPorts.api}`
    let failure: unknown
    console.log(`smoke project: ${project}`)
    console.log(
      `recovery command: TELEGRAM_BOT_TOKEN='o01-smoke-token-recovery-only' PLANNER_RUNTIME_IMAGE='${image}' POSTGRES_PORT=${allocatedPorts.postgres} REDIS_AUTH_PORT=${allocatedPorts.redis} API_PORT=${allocatedPorts.api} docker compose -f docker-compose.yml --project-name '${project}' down --volumes --remove-orphans`,
    )
    console.log(`recovery image removal: docker image rm '${image}'`)
    try {
      await runCommand(
        'docker',
        ['compose', '-f', COMPOSE_FILE, '--project-name', project, 'build'],
        { env, timeoutMs: 120_000 },
      )
      await runCommand(
        'docker',
        composeArgs(project, ['up', '-d', '--wait', '--wait-timeout', '120']),
        { env, timeoutMs: 150_000 },
      ).catch((error: unknown) => {
        if (isBindCollision(error))
          throw new HostBindCollisionError('host port collision')
        throw error
      })
      await assertProjectContainers(project)
      const postgres = await serviceContainer(project, 'postgres', env)
      const redis = await serviceContainer(project, 'redis-auth', env)
      const migrator = await serviceContainer(project, 'migrator', env)
      const api = await serviceContainer(project, 'api', env)
      const worker = await serviceContainer(project, 'planner-worker', env)
      for (const [name, id] of [
        ['postgres', postgres],
        ['redis-auth', redis],
      ] as const) {
        const inspected = await inspectContainer(id)
        assert.equal(
          inspected.State.Health?.Status,
          'healthy',
          `${name} must be healthy`,
        )
      }
      const migratorState = await inspectContainer(migrator)
      assert.equal(migratorState.State.Status, 'exited')
      assert.equal(migratorState.State.ExitCode, 0)
      assert.equal(migratorState.RestartCount, 0)
      const migratorTimes = {
        started: migratorState.State.StartedAt,
        finished: migratorState.State.FinishedAt,
        restart: migratorState.RestartCount,
      }
      const apiState = await inspectContainer(api)
      const workerState = await inspectContainer(worker)
      assert.equal(apiState.State.Health?.Status, 'healthy')
      assert.equal(workerState.State.Running, true)
      assert.equal(
        apiState.Config.Labels?.['com.docker.compose.project'],
        project,
      )
      assert.equal(
        workerState.Config.Labels?.['com.docker.compose.project'],
        project,
      )
      assert.equal(apiState.State.Status, 'running')
      assert.equal(workerState.State.Status, 'running')
      assert.equal(
        apiState.Config.Labels?.['com.docker.compose.service'],
        'api',
      )
      assert.equal(
        workerState.Config.Labels?.['com.docker.compose.service'],
        'planner-worker',
      )
      await assertContainerPid1(api, 'dist/bootstrap/api/main.js')
      await assertContainerPid1(worker, 'dist/bootstrap/planner-worker/main.js')
      assert.equal((await readyWorkerEventCount(worker)) >= 1, true)
      await assertHealth(`${apiBase}/health/live`, 200, { status: 'ok' })
      await assertHealth(`${apiBase}/health/startup`, 200, { status: 'ok' })
      await assertHealth(`${apiBase}/health/ready`, 200, { status: 'ok' })
      assert.deepEqual(
        await migrationInventory(project, env),
        await localMigrationInventory(),
      )
      assert.equal(await notificationAttemptCount(project, env), 0)
      await runCommand('docker', ['pause', redis])
      await assertHealth(`${apiBase}/health/live`, 200, { status: 'ok' })
      await assertHealth(`${apiBase}/health/startup`, 200, { status: 'ok' })
      await waitFor(
        'ready unavailable while redis is paused',
        async () => {
          const current = await health(`${apiBase}/health/ready`)
          return (
            current.status === 503 &&
            JSON.stringify(current.body) ===
              JSON.stringify({ status: 'unavailable' })
          )
        },
        15_000,
      )
      await runCommand('docker', ['unpause', redis])
      await waitFor('ready after redis unpause', async () => {
        const current = await health(`${apiBase}/health/ready`)
        return (
          current.status === 200 &&
          JSON.stringify(current.body) === JSON.stringify({ status: 'ok' })
        )
      })
      await delay(10_000)
      const apiBefore = await inspectContainer(api)
      const workerBefore = await inspectContainer(worker)
      const workerEventsBefore = await readyWorkerEventCount(worker)
      assert.equal(
        Date.now() - Date.parse(apiBefore.State.StartedAt) >= 10_000,
        true,
      )
      assert.equal(
        Date.now() - Date.parse(workerBefore.State.StartedAt) >= 10_000,
        true,
      )
      await terminateContainerPid1(api)
      await waitFor(
        'api restart',
        async () =>
          (await inspectContainer(api)).RestartCount > apiBefore.RestartCount &&
          (await inspectContainer(api)).State.Running,
      )
      await waitFor(
        'api ready after crash',
        async () => (await health(`${apiBase}/health/ready`)).status === 200,
      )
      await terminateContainerPid1(worker)
      await waitFor(
        'worker restart',
        async () =>
          (await inspectContainer(worker)).RestartCount >
            workerBefore.RestartCount &&
          (await inspectContainer(worker)).State.Running,
      )
      await waitFor(
        'worker readiness after crash',
        async () => (await readyWorkerEventCount(worker)) > workerEventsBefore,
      )
      const workerAfter = await inspectContainer(worker)
      assert.equal(
        Date.parse(workerAfter.State.StartedAt) >
          Date.parse(workerBefore.State.StartedAt),
        true,
      )
      const migratorAfterCrash = await inspectContainer(migrator)
      assert.deepEqual(
        {
          started: migratorAfterCrash.State.StartedAt,
          finished: migratorAfterCrash.State.FinishedAt,
          restart: migratorAfterCrash.RestartCount,
        },
        migratorTimes,
      )
      const stopStarted = Date.now()
      await runCommand(
        'docker',
        composeArgs(project, ['stop', 'api', 'planner-worker']),
        { env, timeoutMs: 30_000 },
      )
      const stopElapsed = Date.now() - stopStarted
      assert.equal(
        stopElapsed < 15_000,
        true,
        `graceful stop took ${stopElapsed}ms`,
      )
      for (const id of [api, worker]) {
        const stopped = await inspectContainer(id)
        assert.equal(stopped.State.Running, false)
        assert.equal(stopped.State.ExitCode, 0)
        assert.equal(stopped.State.OOMKilled, false)
      }
      await delay(2_000)
      assert.equal((await inspectContainer(api)).State.Running, false)
      assert.equal((await inspectContainer(worker)).State.Running, false)
      const stoppedWorkerEvents = await readyWorkerEventCount(worker)
      await runCommand(
        'docker',
        composeArgs(project, ['start', 'api', 'planner-worker']),
        { env },
      )
      await waitFor('api readiness after manual start', async () => {
        const current = await health(`${apiBase}/health/ready`)
        return (
          current.status === 200 &&
          JSON.stringify(current.body) === JSON.stringify({ status: 'ok' })
        )
      })
      await assertHealth(`${apiBase}/health/ready`, 200, { status: 'ok' })
      await waitFor(
        'worker readiness after manual start',
        async () => (await readyWorkerEventCount(worker)) > stoppedWorkerEvents,
      )
      assert.deepEqual(
        await migrationInventory(project, env),
        await localMigrationInventory(),
      )
      assert.equal(await notificationAttemptCount(project, env), 0)
      console.log(`runtime smoke: PASS (graceful stop ${stopElapsed}ms)`)
    } catch (error: unknown) {
      failure = error
      if (!interruptSignal) await diagnostics(project, env)
    }
    let cleanupFailure: unknown
    try {
      await cleanup(project, image, env)
    } catch (error: unknown) {
      cleanupFailure = error
    }
    if (cleanupFailure !== undefined) {
      if (failure === undefined) failure = cleanupFailure
      else
        failure = new AggregateError(
          [failure, cleanupFailure],
          'runtime smoke and cleanup failed',
        )
    }
    if (interruptSignal !== undefined) {
      const interruptFailure = new Error(`interrupted by ${interruptSignal}`)
      if (failure === undefined) failure = interruptFailure
      else
        failure = new AggregateError(
          [failure, interruptFailure],
          'runtime smoke interrupted',
        )
    }
    if (failure !== undefined) {
      if (
        failure instanceof HostBindCollisionError &&
        !interruptSignal &&
        !retried
      ) {
        retried = true
        console.log(
          'confirmed host bind collision; retrying once with new project and ports',
        )
        continue
      }
      throw failure instanceof Error
        ? failure
        : new Error(JSON.stringify(failure) ?? 'unknown failure')
    }
    return
  }
}

const signalHandlers = new Map<NodeJS.Signals, () => void>()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  const handler = (): void => {
    if (interruptSignal !== undefined) return
    interruptSignal = signal
    workAbortController.abort(new Error(`interrupted by ${signal}`))
  }
  signalHandlers.set(signal, handler)
  process.on(signal, handler)
}

function reportFailure(error: unknown): void {
  if (error instanceof AggregateError) {
    console.error(error.message)
    for (const nested of error.errors) reportFailure(nested)
    return
  }
  if (error instanceof CommandError) {
    console.error(`${error.message}\n${error.stderr.slice(0, 4_000)}`)
    return
  }
  if (error instanceof Error) {
    console.error(error.stack ?? error.message)
    return
  }
  console.error(error)
}

async function main(): Promise<void> {
  const started = Date.now()
  await staticPreflight()
  await runtimeSmoke()
  assert.equal(Date.now() - started <= MAX_RUNTIME_MS, true)
}

main()
  .catch((error: unknown) => {
    reportFailure(error)
    process.exitCode = interruptSignal === undefined ? 1 : 130
  })
  .finally(() => {
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler)
    if (interruptSignal !== undefined) process.exitCode = 130
  })
