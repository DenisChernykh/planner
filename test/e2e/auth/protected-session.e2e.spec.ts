import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import {
  resumeRedis,
  suspendRedis,
} from '@test/integration/support/redis-outage'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '0f739752-52a2-45bc-aa9f-3de43f47f47b'
const sessionKeySecret = Buffer.alloc(32, 21)
const csrfSecret = Buffer.alloc(32, 22)

function deployMigrations(databaseUrl: string): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`)
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Port reservation failed')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
}

async function waitForStatus(
  url: string,
  status: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status === status) return
    } catch {
      // The dependency or listener may still be transitioning.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${status} from ${url}`)
}

async function problem(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get('content-type')).toContain(
    'application/problem+json',
  )
  return response.json() as Promise<Record<string, unknown>>
}

interface ExpectedProblem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly code: string
}

async function expectExactProblem(
  response: Response,
  expected: ExpectedProblem,
): Promise<Record<string, unknown>> {
  const body = await problem(response)
  const requestId = response.headers.get('x-request-id')
  expect(requestId).toMatch(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/u,
  )
  expect(Object.keys(body).sort()).toEqual([
    'code',
    'detail',
    'instance',
    'requestId',
    'status',
    'title',
    'type',
  ])
  expect(body).toEqual({
    ...expected,
    instance: `urn:request:${requestId}`,
    requestId,
  })
  return body
}

const authenticationProblem: ExpectedProblem = {
  type: 'https://planner.invalid/problems/authentication-required',
  title: 'Authentication required',
  status: 401,
  detail: 'A valid browser session is required.',
  code: 'AUTHENTICATION_REQUIRED',
}

const authorizationProblem: ExpectedProblem = {
  type: 'https://planner.invalid/problems/authorization-denied',
  title: 'Authorization denied',
  status: 403,
  detail: 'The request did not satisfy browser authorization controls.',
  code: 'AUTHORIZATION_DENIED',
}

const unsupportedMediaProblem: ExpectedProblem = {
  type: 'https://planner.invalid/problems/unsupported-media-type',
  title: 'Unsupported media type',
  status: 415,
  detail: 'The request content type is not supported.',
  code: 'UNSUPPORTED_MEDIA_TYPE',
}

const dependencyProblem: ExpectedProblem = {
  type: 'https://planner.invalid/problems/dependency-unavailable',
  title: 'Dependency unavailable',
  status: 503,
  detail: 'A required service is temporarily unavailable.',
  code: 'DEPENDENCY_UNAVAILABLE',
}

describe('S04 protected opaque-session HTTP contract', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let postgresControl: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let issue: IssueSessionUseCase
  let redisSuspended = false
  let postgresUnavailable = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_session_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    admin.on('error', () => undefined)
    const controlUrl = new URL(postgres.getConnectionUri())
    controlUrl.pathname = '/postgres'
    postgresControl = new Pool({ connectionString: controlUrl.toString() })
    await admin.query('INSERT INTO public.users (id) VALUES ($1)', [userId])

    provider = new PrismaClientProvider(
      {
        database: {
          url: postgres.getConnectionUri(),
          poolMax: 2,
          connectionTimeoutMs: 2_000,
          idleTimeoutMs: 5_000,
          healthTimeoutMs: 1_000,
          transactionMaxWaitMs: 1_000,
          transactionTimeoutMs: 2_000,
        },
      },
      new PrismaTransactionContext(),
    )
    await provider.connect(AbortSignal.timeout(3_000))
    const issuerConnection = new RedisAuthConnectionManager(
      new RedisClientFactory({
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 1_000,
      }),
      {
        authUrl: redis.getConnectionUrl(),
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 1_000,
      },
    )
    issuerRedis = new RedisLifecycle(issuerConnection, 1_000)
    await issuerRedis.connect(AbortSignal.timeout(2_000))
    issuerExecutor = issuerConnection.commandExecutor
    issue = new IssueSessionUseCase(
      new PrismaLocalUserRepository(provider),
      new RedisSessionStore(issuerExecutor, new NodeAuthCryptoAdapter(), {
        keyPrefix: 'planner',
        sessionKeySecret,
        csrfSecret,
        idleTimeoutMs: 604_800_000,
        absoluteTimeoutMs: 2_592_000_000,
        touchIntervalMs: 300_000,
      }),
    )

    const port = await reservePort()
    origin = `http://127.0.0.1:${port}`
    baseUrl = origin
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: sessionKeySecret.toString('base64url'),
      AUTH_CSRF_SECRET: csrfSecret.toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 23).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'session-e2e-telegram-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (redisSuspended) await resumeRedis(redis)
    if (postgresUnavailable) {
      await postgresControl.query(
        'ALTER DATABASE planner_session_e2e WITH ALLOW_CONNECTIONS true',
      )
    }
    await runtime?.stop()
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await postgresControl?.end()
    await Promise.all([postgres?.stop(), redis?.stop()])
    for (const key of [
      'NODE_ENV',
      'API_HOST',
      'API_PORT',
      'DATABASE_URL',
      'REDIS_AUTH_URL',
      'REDIS_KEY_PREFIX',
      'AUTH_SESSION_KEY_SECRET',
      'AUTH_CSRF_SECRET',
      'AUTH_OIDC_STATE_KEY_SECRET',
      'AUTH_CSRF_ORIGINS',
      'TELEGRAM_OIDC_CLIENT_ID',
      'TELEGRAM_OIDC_CLIENT_SECRET',
      'TELEGRAM_OIDC_CALLBACK_URL',
    ])
      delete process.env[key]
  })

  it('returns exact 401 Problems for missing and malformed session cookies', async () => {
    for (const headers of [{}, { cookie: 'planner-session=malformed' }]) {
      const response = await fetch(`${baseUrl}/auth/me`, { headers })
      expect(response.status).toBe(401)
      await expectExactProblem(response, authenticationProblem)
    }
  })

  it('rejects an expired session and a session whose local User was deleted', async () => {
    const expiredIssue = new IssueSessionUseCase(
      new PrismaLocalUserRepository(provider),
      new RedisSessionStore(issuerExecutor, new NodeAuthCryptoAdapter(), {
        keyPrefix: 'planner',
        sessionKeySecret,
        csrfSecret,
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 2_000,
        touchIntervalMs: 100,
      }),
    )
    const expired = await expiredIssue.execute(userId, Date.now() - 2_001)
    const expiredResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: `planner-session=${expired.rawToken}` },
    })
    expect(expiredResponse.status).toBe(401)
    await expectExactProblem(expiredResponse, authenticationProblem)

    const deletedUserSession = await issue.execute(userId, Date.now())
    await admin.query('DELETE FROM public.users WHERE id = $1', [userId])
    try {
      const deletedUserResponse = await fetch(`${baseUrl}/auth/me`, {
        headers: {
          cookie: `planner-session=${deletedUserSession.rawToken}`,
        },
      })
      expect(deletedUserResponse.status).toBe(401)
      await expectExactProblem(deletedUserResponse, authenticationProblem)
    } finally {
      await admin.query('INSERT INTO public.users (id) VALUES ($1)', [userId])
    }
  })

  it('returns the exact principal and session-bound CSRF token', async () => {
    const session = await issue.execute(userId, Date.now())
    const cookie = `planner-session=${session.rawToken}`

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toEqual({
      userId,
      sessionId: session.sessionId,
    })

    const csrf = await fetch(`${baseUrl}/auth/csrf`, { headers: { cookie } })
    expect(csrf.status).toBe(200)
    await expect(csrf.json()).resolves.toEqual({ csrfToken: session.csrfToken })
  })

  it('returns 415 before Origin checks, then exact 403 Problems for Origin or CSRF failures', async () => {
    const session = await issue.execute(userId, Date.now())
    const cookie = `planner-session=${session.rawToken}`
    const unsupported = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin },
    })
    expect(unsupported.status).toBe(415)
    await expectExactProblem(unsupported, unsupportedMediaProblem)

    for (const headers of [
      {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      { cookie, origin, 'content-type': 'application/json' },
    ]) {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      expect(response.status).toBe(403)
      await expectExactProblem(response, authorizationProblem)
    }
  })

  it('revokes one session, clears the matching cookie and rejects its reuse', async () => {
    const session = await issue.execute(userId, Date.now())
    const cookie = `planner-session=${session.rawToken}`
    const response = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: '{}',
    })
    expect(response.status).toBe(204)
    const clearedCookie = response.headers.get('set-cookie')
    expect(clearedCookie).toMatch(/^planner-session=;/u)
    expect(clearedCookie).toContain('Path=/')
    expect(clearedCookie).toContain('HttpOnly')
    expect(clearedCookie).toContain('SameSite=Lax')
    expect(clearedCookie).not.toContain('Domain=')
    expect(clearedCookie).not.toContain('Secure')

    const reused = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
    expect(reused.status).toBe(401)
    await expectExactProblem(reused, authenticationProblem)
  })

  it('fails closed on PostgreSQL loss and recovers without reissuing the session', async () => {
    const session = await issue.execute(userId, Date.now())
    const cookie = `planner-session=${session.rawToken}`
    await postgresControl.query(
      'ALTER DATABASE planner_session_e2e WITH ALLOW_CONNECTIONS false',
    )
    postgresUnavailable = true
    await postgresControl.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = 'planner_session_e2e'
          AND pid <> pg_backend_pid()`,
    )

    const unavailable = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie },
    })
    expect(unavailable.status).toBe(503)
    await expectExactProblem(unavailable, dependencyProblem)

    await postgresControl.query(
      'ALTER DATABASE planner_session_e2e WITH ALLOW_CONNECTIONS true',
    )
    postgresUnavailable = false
    await waitForStatus(`${baseUrl}/health/ready`, 200, 5_000)
    const recovered = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie },
    })
    expect(recovered.status).toBe(200)
    await expect(recovered.json()).resolves.toEqual({
      userId,
      sessionId: session.sessionId,
    })
  })

  it('fails closed on Redis loss while liveness/startup stay latched and readiness recovers', async () => {
    const session = await issue.execute(userId, Date.now())
    const cookie = `planner-session=${session.rawToken}`
    await suspendRedis(redis)
    redisSuspended = true
    await waitForStatus(`${baseUrl}/health/ready`, 503, 4_000)

    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/health/startup`)).status).toBe(200)
    const response = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
    expect(response.status).toBe(503)
    const body = await expectExactProblem(response, dependencyProblem)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(session.rawToken)
    expect(serialized).not.toContain(redis.getConnectionUrl())
    expect(serialized).not.toContain(sessionKeySecret.toString('base64url'))
    expect(serialized).not.toContain(csrfSecret.toString('base64url'))

    await resumeRedis(redis)
    redisSuspended = false
    await waitForStatus(`${baseUrl}/health/ready`, 200, 5_000)
    const recovered = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
    expect(recovered.status).toBe(200)
    await expect(recovered.json()).resolves.toEqual({
      userId,
      sessionId: session.sessionId,
    })
  })
})
