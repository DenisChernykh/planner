import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { AuthenticateSessionUseCase } from '@/modules/auth/application/authenticate-session.use-case'
import {
  AuthDependencyUnavailableError,
  AuthenticationRequiredError,
} from '@/modules/auth/application/auth-errors'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { RevokeSessionUseCase } from '@/modules/auth/application/revoke-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import { toUserId } from '@/modules/auth/domain/user-id'
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
const unknownUserId = '7b93f4d8-b86b-4f68-ac4b-3d9ff0408c88'
const sessionKeySecret = new Uint8Array(Buffer.alloc(32, 11))
const csrfSecret = new Uint8Array(Buffer.alloc(32, 12))

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

async function scanRedisStrings(
  executor: RedisCommandExecutorPort,
): Promise<readonly { readonly key: string; readonly value: string | null }[]> {
  const entries: { key: string; value: string | null }[] = []
  let cursor = '0'
  do {
    const page = await executor.execute('test-scan', (client) =>
      client.sendCommand<readonly [string, readonly string[]]>([
        'SCAN',
        cursor,
        'COUNT',
        '100',
      ]),
    )
    cursor = page[0]
    for (const key of page[1]) {
      const value = await executor.execute('test-scan-get', (client) =>
        client.sendCommand<string | null>(['GET', key]),
      )
      entries.push({ key, value })
    }
  } while (cursor !== '0')
  return entries.sort(({ key: left }, { key: right }) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
}

describe('S04 opaque session with real PostgreSQL and Redis', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let lifecycle: RedisLifecycle
  let executor: RedisCommandExecutorPort
  let store: RedisSessionStore
  let issue: IssueSessionUseCase
  let authenticate: AuthenticateSessionUseCase
  let revoke: RevokeSessionUseCase
  let redisSuspended = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_session_test')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
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
    const connection = new RedisAuthConnectionManager(
      new RedisClientFactory({
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 500,
      }),
      {
        authUrl: redis.getConnectionUrl(),
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 500,
      },
    )
    lifecycle = new RedisLifecycle(connection, 1_000)
    await lifecycle.connect(AbortSignal.timeout(2_000))
    executor = connection.commandExecutor
    store = new RedisSessionStore(executor, new NodeAuthCryptoAdapter(), {
      keyPrefix: 'planner',
      sessionKeySecret,
      csrfSecret,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
      touchIntervalMs: 100,
    })
    const users = new PrismaLocalUserRepository(provider)
    issue = new IssueSessionUseCase(users, store)
    authenticate = new AuthenticateSessionUseCase(users, store)
    revoke = new RevokeSessionUseCase(store)
  })

  beforeEach(async () => {
    await admin.query('DELETE FROM public.users')
    await executor.execute('test-flush', (client) =>
      client.sendCommand<string>(['FLUSHDB']),
    )
    await admin.query('INSERT INTO public.users (id) VALUES ($1)', [userId])
  })

  afterAll(async () => {
    if (redisSuspended) await resumeRedis(redis)
    await lifecycle?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await Promise.all([postgres?.stop(), redis?.stop()])
  })

  it('deploys only the minimal User table for this slice', async () => {
    const columns = await admin.query<{
      column_name: string
      data_type: string
    }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
        ORDER BY ordinal_position`,
    )
    expect(columns.rows).toEqual([
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ])
  })

  it('issues independent sessions, stores no raw token and keeps finite bounded TTLs', async () => {
    const now = Date.now()
    const first = await issue.execute(userId, now)
    const second = await issue.execute(userId, now + 1)
    const digest = new NodeAuthCryptoAdapter().hmac(
      sessionKeySecret,
      first.rawToken,
    )
    const key = `planner:auth:v1:session:${digest}`
    const secondDigest = new NodeAuthCryptoAdapter().hmac(
      sessionKeySecret,
      second.rawToken,
    )
    const secondKey = `planner:auth:v1:session:${secondDigest}`
    const [payload, ttl] = await executor.execute(
      'test-inspect',
      async (client) =>
        Promise.all([
          client.sendCommand<string | null>(['GET', key]),
          client.sendCommand<number>(['PTTL', key]),
        ]),
    )

    expect(first.rawToken).not.toBe(second.rawToken)
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(key).not.toContain(first.rawToken)
    expect(payload).not.toContain(first.rawToken)
    const redisStrings = await scanRedisStrings(executor)
    const serializedRedis = JSON.stringify(redisStrings)
    expect(redisStrings.map(({ key }) => key)).toEqual([key, secondKey].sort())
    expect(serializedRedis).not.toContain(first.rawToken)
    expect(serializedRedis).not.toContain(second.rawToken)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1_000)
    const stored = JSON.parse(payload!) as {
      readonly sessionId: string
      readonly csrfSeed: string
    }
    expect(first.csrfToken).toBe(
      createHmac('sha256', csrfSecret)
        .update(`${stored.sessionId}.${stored.csrfSeed}`)
        .digest('base64url'),
    )
    const firstPrincipal = {
      userId,
      sessionId: first.sessionId,
    }
    const secondPrincipal = {
      userId,
      sessionId: second.sessionId,
    }
    await expect(
      authenticate.execute(first.rawToken, now + 50),
    ).resolves.toEqual(firstPrincipal)
    await expect(
      authenticate.execute(second.rawToken, now + 51),
    ).resolves.toEqual(secondPrincipal)

    await revoke.execute(
      { userId: toUserId(userId), sessionId: first.sessionId },
      first.rawToken,
    )
    await expect(
      authenticate.execute(first.rawToken, now + 52),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError)
    await expect(
      authenticate.execute(second.rawToken, now + 53),
    ).resolves.toEqual(secondPrincipal)
  })

  it('touches within the absolute bound, deletes corruption and never resurrects after revoke', async () => {
    const now = Date.now()
    const issuedSession = await issue.execute(userId, now)
    const digest = new NodeAuthCryptoAdapter().hmac(
      sessionKeySecret,
      issuedSession.rawToken,
    )
    const key = `planner:auth:v1:session:${digest}`
    const untouched = await store.readAndTouch(issuedSession.rawToken, now + 50)
    const touched = await store.readAndTouch(issuedSession.rawToken, now + 150)
    expect(untouched?.lastSeenAtMs).toBe(now)
    expect(touched?.lastSeenAtMs).toBe(now + 150)
    expect(touched?.absoluteExpiresAtMs).toBe(now + 5_000)

    for (const offset of [900, 1_800, 2_700, 3_600, 4_500]) {
      await expect(
        store.readAndTouch(issuedSession.rawToken, now + offset),
      ).resolves.toBeDefined()
    }
    const nearAbsoluteTtl = await executor.execute(
      'test-near-absolute-ttl',
      (client) => client.sendCommand<number>(['PTTL', key]),
    )
    expect(nearAbsoluteTtl).toBeGreaterThan(0)
    expect(nearAbsoluteTtl).toBeLessThanOrEqual(500)

    for (let iteration = 0; iteration < 16; iteration += 1) {
      const raced = await issue.execute(userId, now + 5_000 + iteration)
      const racedKey = `planner:auth:v1:session:${new NodeAuthCryptoAdapter().hmac(
        sessionKeySecret,
        raced.rawToken,
      )}`
      await Promise.allSettled([
        store.readAndTouch(raced.rawToken, now + 5_200 + iteration),
        revoke.execute(
          { userId: toUserId(userId), sessionId: raced.sessionId },
          raced.rawToken,
        ),
      ])
      await expect(
        store.readAndTouch(raced.rawToken, now + 5_300 + iteration),
      ).resolves.toBeUndefined()
      await expect(
        executor.execute('test-race-exists', (client) =>
          client.sendCommand<number>(['EXISTS', racedKey]),
        ),
      ).resolves.toBe(0)
    }

    await revoke.execute(
      { userId: toUserId(userId), sessionId: issuedSession.sessionId },
      issuedSession.rawToken,
    )
    await expect(
      store.readAndTouch(issuedSession.rawToken, now + 5_400),
    ).resolves.toBeUndefined()

    const corrupt = await issue.execute(userId, now + 400)
    const corruptDigest = new NodeAuthCryptoAdapter().hmac(
      sessionKeySecret,
      corrupt.rawToken,
    )
    const corruptKey = `planner:auth:v1:session:${corruptDigest}`
    await executor.execute('test-corrupt', (client) =>
      client.sendCommand<string>(['SET', corruptKey, '{', 'PX', '1000']),
    )
    await expect(
      store.readAndTouch(corrupt.rawToken, now + 450),
    ).resolves.toBeUndefined()
    await expect(
      executor.execute('test-exists', (client) =>
        client.sendCommand<number>(['EXISTS', corruptKey]),
      ),
    ).resolves.toBe(0)

    const primitive = await issue.execute(userId, now + 500)
    const primitiveDigest = new NodeAuthCryptoAdapter().hmac(
      sessionKeySecret,
      primitive.rawToken,
    )
    const primitiveKey = `planner:auth:v1:session:${primitiveDigest}`
    await executor.execute('test-corrupt-primitive', (client) =>
      client.sendCommand<string>(['SET', primitiveKey, '1', 'PX', '1000']),
    )
    await expect(
      store.readAndTouch(primitive.rawToken, now + 550),
    ).resolves.toBeUndefined()
    await expect(
      executor.execute('test-primitive-exists', (client) =>
        client.sendCommand<number>(['EXISTS', primitiveKey]),
      ),
    ).resolves.toBe(0)
    expect(key).not.toBe(corruptKey)
  })

  it('does not create a User or Redis session for an unknown User', async () => {
    const before = await executor.execute('test-dbsize-before', (client) =>
      client.sendCommand<number>(['DBSIZE']),
    )
    await expect(
      issue.execute(unknownUserId, Date.now()),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError)
    const after = await executor.execute('test-dbsize-after', (client) =>
      client.sendCommand<number>(['DBSIZE']),
    )
    const users = await admin.query<{ count: string }>(
      'SELECT count(*) FROM public.users',
    )
    expect(after).toBe(before)
    expect(users.rows).toEqual([{ count: '1' }])
  })

  it('fails closed during Redis loss without mutating PostgreSQL', async () => {
    const issuedSession = await issue.execute(userId, Date.now())
    await suspendRedis(redis)
    redisSuspended = true
    await expect(
      authenticate.execute(issuedSession.rawToken, Date.now() + 1),
    ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    const users = await admin.query<{ count: string }>(
      'SELECT count(*) FROM public.users',
    )
    expect(users.rows).toEqual([{ count: '1' }])
    await resumeRedis(redis)
    redisSuspended = false
  })
})
