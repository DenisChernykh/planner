import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
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
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const outsiderUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const firstTelegramId = '9007199254740993'
const secondTelegramId = '9007199254740995'
const sessionKeySecret = Buffer.alloc(32, 71)
const csrfSecret = Buffer.alloc(32, 72)

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
  if (address === null || typeof address === 'string') throw new Error('port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('F01 current workspace presentation context', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let firstCookie: string
  let firstCsrf: string
  let secondCookie: string
  let outsiderCookie: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f01_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query('INSERT INTO users (id) VALUES ($1), ($2), ($3)', [
      firstUserId,
      secondUserId,
      outsiderUserId,
    ])
    await admin.query('INSERT INTO spaces (id, singleton_key) VALUES ($1, 1)', [
      spaceId,
    ])
    await admin.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $2, $3, 1)`,
      [firstMemberId, spaceId, firstUserId],
    )

    provider = new PrismaClientProvider(
      {
        database: {
          url: postgres.getConnectionUri(),
          poolMax: 4,
          connectionTimeoutMs: 2_000,
          idleTimeoutMs: 5_000,
          healthTimeoutMs: 1_000,
          transactionMaxWaitMs: 2_000,
          transactionTimeoutMs: 20_000,
        },
      },
      new PrismaTransactionContext(),
    )
    await provider.connect(AbortSignal.timeout(3_000))
    const connection = new RedisAuthConnectionManager(
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
    issuerRedis = new RedisLifecycle(connection, 1_000)
    await issuerRedis.connect(AbortSignal.timeout(2_000))
    issuerExecutor = connection.commandExecutor
    const issue = new IssueSessionUseCase(
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
    const [first, second, outsider] = await Promise.all([
      issue.execute(firstUserId, Date.now()),
      issue.execute(secondUserId, Date.now()),
      issue.execute(outsiderUserId, Date.now()),
    ])
    firstCookie = `planner-session=${first.rawToken}`
    firstCsrf = first.csrfToken
    secondCookie = `planner-session=${second.rawToken}`
    outsiderCookie = `planner-session=${outsider.rawToken}`

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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 73).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'f01-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    await runtime?.stop()
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
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
    ]) {
      delete process.env[key]
    }
  })

  async function current(cookie: string): Promise<Response> {
    return fetch(`${baseUrl}/workspace/current`, { headers: { cookie } })
  }

  async function addSecondMember(): Promise<void> {
    await admin.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $2, $3, 2)`,
      [secondMemberId, spaceId, secondUserId],
    )
  }

  it('publishes the exact protected OpenAPI operation', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    const operation = document.paths['/workspace/current']?.['get'] as {
      operationId?: string
      security?: unknown
      responses?: Record<string, unknown>
    }
    expect(operation.operationId).toBe('WorkspaceController_current')
    expect(operation.security).toEqual([{ sessionCookie: [] }])
    for (const status of ['200', '401', '403', '409', '503']) {
      expect(operation.responses).toHaveProperty(status)
    }
    expect(
      document.components.schemas.WorkspaceCurrentResponseV1,
    ).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'spaceId',
        'timeZone',
        'currentMemberId',
        'personaMappingState',
        'members',
      ],
    })
  })

  it('returns authentication, membership and inconsistent-pair boundaries', async () => {
    expect((await current('')).status).toBe(401)
    const incomplete = await current(firstCookie)
    expect(incomplete.status).toBe(409)
    const incompleteBody = await json(incomplete)
    expect(incompleteBody).toMatchObject({
      code: 'WORKSPACE_STATE_CONFLICT',
      status: 409,
    })
    expect(JSON.stringify(incompleteBody)).not.toContain(firstMemberId)

    await addSecondMember()
    const outsider = await current(outsiderCookie)
    expect(outsider.status).toBe(403)
    expect(await json(outsider)).toMatchObject({
      code: 'WORKSPACE_AUTHORIZATION_DENIED',
      status: 403,
    })
  })

  it('returns relative labels before binding and stable persona mapping after seed binding', async () => {
    const beforeFirst = await current(firstCookie)
    const beforeSecond = await current(secondCookie)
    expect(beforeFirst.status).toBe(200)
    expect(beforeSecond.status).toBe(200)
    const firstBody = await json(beforeFirst)
    const secondBody = await json(beforeSecond)
    expect(firstBody).toMatchObject({
      schemaVersion: 'workspace.current.v1',
      spaceId,
      timeZone: 'Asia/Yekaterinburg',
      currentMemberId: firstMemberId,
      personaMappingState: 'unbound',
      members: [
        {
          memberId: firstMemberId,
          relation: 'current',
          displayName: 'Вы',
          persona: null,
        },
        {
          memberId: secondMemberId,
          relation: 'partner',
          displayName: 'Партнёр',
          persona: null,
        },
      ],
    })
    expect(secondBody).toMatchObject({
      currentMemberId: secondMemberId,
      personaMappingState: 'unbound',
      members: [
        {
          memberId: secondMemberId,
          relation: 'current',
          displayName: 'Вы',
          persona: null,
        },
        {
          memberId: firstMemberId,
          relation: 'partner',
          displayName: 'Партнёр',
          persona: null,
        },
      ],
    })
    for (const body of [firstBody, secondBody]) {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain(firstUserId)
      expect(serialized).not.toContain(secondUserId)
      expect(serialized).not.toContain(firstTelegramId)
      expect(serialized).not.toContain(secondTelegramId)
      expect(serialized).not.toContain('slot')
    }

    const seed = await fetch(`${baseUrl}/planning/drafts/from-seed`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        targetMonth: '2035-04',
        actorPersona: 'memberA',
      }),
    })
    expect(seed.status).toBe(201)

    const afterFirst = await current(firstCookie)
    const afterSecond = await current(secondCookie)
    expect(afterFirst.status).toBe(200)
    expect(afterSecond.status).toBe(200)
    expect(await json(afterFirst)).toMatchObject({
      personaMappingState: 'bound',
      members: [
        {
          memberId: firstMemberId,
          relation: 'current',
          displayName: 'Участник А',
          persona: 'memberA',
        },
        {
          memberId: secondMemberId,
          relation: 'partner',
          displayName: 'Участник Б',
          persona: 'memberB',
        },
      ],
    })
    expect(await json(afterSecond)).toMatchObject({
      personaMappingState: 'bound',
      members: [
        {
          memberId: secondMemberId,
          relation: 'current',
          displayName: 'Участник Б',
          persona: 'memberB',
        },
        {
          memberId: firstMemberId,
          relation: 'partner',
          displayName: 'Участник А',
          persona: 'memberA',
        },
      ],
    })
  })

  it('maps database loss to safe 503', async () => {
    await runtime.currentResources?.database.close(AbortSignal.timeout(2_000))
    const response = await current(firstCookie)
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    })
  })
})
