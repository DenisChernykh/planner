import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { GracefulShutdownCoordinator } from '@/bootstrap/api/graceful-shutdown'
import {
  installProcessSignalHandlers,
  type ProcessSignalSource,
} from '@/bootstrap/api/process-signals'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import { startRedisContainer } from '@test/integration/support/redis-container'

const execFileAsync = promisify(execFile)
const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const sessionKeySecret = Buffer.alloc(32, 41).toString('base64url')
const csrfSecret = Buffer.alloc(32, 42).toString('base64url')

class TestSignalSource implements ProcessSignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>()

  public on(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(signal, listeners)
  }

  public off(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener)
  }

  public emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) listener()
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('TCP port reservation failed')
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Condition deadline exceeded')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function suspendPostgres(
  container: StartedPostgreSqlContainer,
): Promise<void> {
  const stopped = await container.exec([
    'sh',
    '-c',
    'pkill -STOP -u postgres -x postgres',
  ])
  if (stopped.exitCode !== 0) throw new Error('PostgreSQL STOP failed')
  try {
    await execFileAsync('docker', ['pause', container.getId()])
  } catch (error: unknown) {
    await container.exec(['sh', '-c', 'pkill -CONT -u postgres -x postgres'])
    throw error
  }
}

async function resumePostgres(
  container: StartedPostgreSqlContainer,
): Promise<void> {
  await execFileAsync('docker', ['unpause', container.getId()])
  const continued = await container.exec([
    'sh',
    '-c',
    'pkill -CONT -u postgres -x postgres',
  ])
  if (continued.exitCode !== 0) throw new Error('PostgreSQL CONT failed')
}

describe('Planner foundation API health and shutdown', () => {
  let container: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let runtime: ApiRuntime | undefined
  let baseUrl: string
  let suspended = false

  beforeAll(async () => {
    ;[container, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_health_test')
        .withUsername('planner_runtime')
        .withPassword('runtime-password-for-test-only')
        .start(),
      startRedisContainer(),
    ])
    const port = await reservePort()
    baseUrl = `http://127.0.0.1:${port}`
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      DATABASE_URL: container.getConnectionUri(),
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: sessionKeySecret,
      AUTH_CSRF_SECRET: csrfSecret,
      AUTH_CSRF_ORIGINS: baseUrl,
    })
  })

  afterAll(async () => {
    if (suspended) await resumePostgres(container)
    await runtime?.stop()
    await Promise.all([container?.stop(), redis?.stop()])
    for (const key of [
      'NODE_ENV',
      'API_HOST',
      'API_PORT',
      'DATABASE_URL',
      'REDIS_AUTH_URL',
      'REDIS_KEY_PREFIX',
      'AUTH_SESSION_KEY_SECRET',
      'AUTH_CSRF_SECRET',
      'AUTH_CSRF_ORIGINS',
    ]) {
      delete process.env[key]
    }
  })

  it('exposes liveness and starting readiness before PostgreSQL startup completes', async () => {
    await suspendPostgres(container)
    suspended = true
    runtime = new ApiRuntime()
    const startup = runtime.start()

    await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/health/live`)).status === 200
      } catch {
        return false
      }
    }, 3_000)
    await expect(fetch(`${baseUrl}/health/live`)).resolves.toMatchObject({
      status: 200,
    })
    await expect(
      fetch(`${baseUrl}/health/startup`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({ status: 503, body: { status: 'starting' } })
    await expect(fetch(`${baseUrl}/health/ready`)).resolves.toMatchObject({
      status: 503,
    })

    await resumePostgres(container)
    suspended = false
    await startup
  })

  it('latches startup, reports PostgreSQL outages, and never applies migrations', async () => {
    await expect(
      fetch(`${baseUrl}/health/startup`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({ status: 200, body: { status: 'ok' } })
    await expect(
      fetch(`${baseUrl}/health/ready`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({ status: 200, body: { status: 'ok' } })

    const pool = new Pool({ connectionString: container.getConnectionUri() })
    try {
      const migrations = await pool.query<{ migrations: string | null }>(
        "SELECT to_regclass('public._prisma_migrations')::text AS migrations",
      )
      expect(migrations.rows).toEqual([{ migrations: null }])
    } finally {
      await pool.end()
    }

    await suspendPostgres(container)
    suspended = true
    await waitFor(
      async () => (await fetch(`${baseUrl}/health/ready`)).status === 503,
      2_000,
    )
    await expect(fetch(`${baseUrl}/health/live`)).resolves.toMatchObject({
      status: 200,
    })
    await expect(fetch(`${baseUrl}/health/startup`)).resolves.toMatchObject({
      status: 200,
    })
    await resumePostgres(container)
    suspended = false
    await waitFor(
      async () => (await fetch(`${baseUrl}/health/ready`)).status === 200,
      3_000,
    )
  })

  it('keeps liveness/startup stable during drain and closes cleanly once', async () => {
    runtime?.cancelStartup()
    await expect(
      fetch(`${baseUrl}/health/live`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({ status: 200, body: { status: 'ok' } })
    await expect(
      fetch(`${baseUrl}/health/startup`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ).resolves.toEqual({ status: 200, body: { status: 'ok' } })
    await expect(fetch(`${baseUrl}/health/ready`)).resolves.toMatchObject({
      status: 503,
    })

    const coordinator = new GracefulShutdownCoordinator(runtime as ApiRuntime)
    await expect(
      Promise.all([
        coordinator.shutdown('SIGTERM'),
        coordinator.shutdown('SIGINT'),
      ]),
    ).resolves.toEqual([
      { exitCode: 0, forced: false },
      { exitCode: 0, forced: false },
    ])
    await expect(
      fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(200) }),
    ).rejects.toBeDefined()
  })

  it('installs idempotent signal handlers and exits zero after clean SIGTERM shutdown', async () => {
    const source = new TestSignalSource()
    const reasons: string[] = []
    const exits: number[] = []
    let watchdogMilliseconds = 0
    let watchdogCancelled = false
    const uninstall = installProcessSignalHandlers(
      {
        shutdown: (reason: string) => {
          reasons.push(reason)
          return Promise.resolve({ exitCode: 0, forced: false })
        },
      },
      10_000,
      (code) => exits.push(code),
      source,
      (_expire, milliseconds) => {
        watchdogMilliseconds = milliseconds
        return {
          cancel: () => {
            watchdogCancelled = true
          },
        }
      },
    )
    try {
      source.emit('SIGTERM')
      source.emit('SIGINT')
      await waitFor(() => Promise.resolve(exits.length === 1), 1_000)

      expect(reasons).toEqual(['SIGTERM'])
      expect(exits).toEqual([0])
      expect(watchdogMilliseconds).toBe(10_000)
      expect(watchdogCancelled).toBe(true)
    } finally {
      uninstall()
    }
  })

  it('uses one 10000 ms watchdog and exits one when SIGINT cleanup never settles', async () => {
    const source = new TestSignalSource()
    const exits: number[] = []
    let watchdogMilliseconds = 0
    let expireWatchdog = (): void => undefined
    let watchdogCancelled = false
    const uninstall = installProcessSignalHandlers(
      {
        shutdown: () => new Promise(() => undefined),
      },
      10_000,
      (code) => exits.push(code),
      source,
      (expire, milliseconds) => {
        watchdogMilliseconds = milliseconds
        expireWatchdog = expire
        return {
          cancel: () => {
            watchdogCancelled = true
          },
        }
      },
    )
    try {
      source.emit('SIGINT')
      source.emit('SIGTERM')
      await Promise.resolve()
      expect(watchdogMilliseconds).toBe(10_000)
      expect(exits).toEqual([])
      expireWatchdog()
      expect(exits).toEqual([1])
      source.emit('SIGINT')
      expect(exits).toEqual([1])
      expect(watchdogCancelled).toBe(false)
    } finally {
      uninstall()
    }
  })

  it('forces active transport at 6000 ms and reserves 4000 ms for cleanup', async () => {
    const lifecycle = new ApplicationLifecycleState()
    const tracker = new ActiveRequestTracker()
    const response = new EventEmitter()
    tracker.middleware()(
      { path: '/in-flight' } as never,
      response as never,
      () => undefined,
    )
    const deadlines: number[] = []
    let listenerObservedDrain = false
    let forcedConnections = 0
    const runtime = new ApiRuntime(() =>
      Promise.resolve({
        lifecycle,
        requestTracker: tracker,
        httpDrainTimeoutMs: 6_000,
        shutdownGraceMs: 10_000,
        database: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        redis: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        application: {
          listen: () => Promise.resolve(),
          closeListener: () => {
            listenerObservedDrain = lifecycle.phase === 'draining'
            return Promise.resolve()
          },
          closeIdleConnections: () => undefined,
          closeAllConnections: () => {
            forcedConnections += 1
            response.emit('close')
          },
          close: () => Promise.resolve(),
          address: () => null,
        },
      }),
    )
    await runtime.start()
    const coordinator = new GracefulShutdownCoordinator(
      runtime,
      (milliseconds) => {
        deadlines.push(milliseconds)
        return AbortSignal.abort()
      },
    )

    await expect(coordinator.shutdown('SIGTERM')).resolves.toEqual({
      exitCode: 1,
      forced: true,
    })
    expect(listenerObservedDrain).toBe(true)
    expect(forcedConnections).toBe(1)
    expect(deadlines).toEqual([6_000, 4_000])
  })
})
