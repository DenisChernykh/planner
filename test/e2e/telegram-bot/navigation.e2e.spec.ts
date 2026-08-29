import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { configureApi } from '@/bootstrap/api/configure-api'
import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const sessionKeySecret = Buffer.alloc(32, 101)
const csrfSecret = Buffer.alloc(32, 102)

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

describe('F09 authenticated Telegram bot navigation HTTP adapter', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let sessionCookie: string
  let runtime: ApiRuntime | undefined

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f09_navigation')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    const databaseUrl = postgres.getConnectionUri()
    deployMigrations(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl })
    await pool.query('INSERT INTO users (id) VALUES ($1::uuid)', [userId])
    await pool.end()

    const databaseConfig = {
      database: {
        url: databaseUrl,
        poolMax: 2,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 1_000,
        transactionMaxWaitMs: 3_000,
        transactionTimeoutMs: 30_000,
      },
    }
    provider = new PrismaClientProvider(
      databaseConfig,
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
    const session = await new IssueSessionUseCase(
      new PrismaLocalUserRepository(provider),
      new RedisSessionStore(
        connection.commandExecutor,
        new NodeAuthCryptoAdapter(),
        {
          keyPrefix: 'planner',
          sessionKeySecret,
          csrfSecret,
          idleTimeoutMs: 604_800_000,
          absoluteTimeoutMs: 2_592_000_000,
          touchIntervalMs: 300_000,
        },
      ),
    ).execute(userId, Date.now())
    sessionCookie = `planner-session=${session.rawToken}`
  })

  afterEach(async () => {
    await runtime?.stop()
    runtime = undefined
  })

  afterAll(async () => {
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await Promise.all([postgres?.stop(), redis?.stop()])
  })

  async function start(configuredUrl?: string): Promise<string> {
    const port = await reservePort()
    const origin = `http://127.0.0.1:${port}`
    const config = buildApiRuntimeConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: port,
      DATABASE_URL: postgres.getConnectionUri(),
      DATABASE_POOL_MAX: 2,
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: sessionKeySecret.toString('base64url'),
      AUTH_CSRF_SECRET: csrfSecret.toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 103).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'f09-e2e-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
      TELEGRAM_INGRESS_MODE: 'disabled',
      TELEGRAM_BOT_TOKEN: '123456789:f09-must-never-be-returned',
      ...(configuredUrl === undefined
        ? {}
        : { TELEGRAM_BOT_URL: configuredUrl }),
    })
    runtime = new ApiRuntime(() => configureApi(config))
    await runtime.start()
    return origin
  }

  it('returns configured navigation while ingress is disabled and rejects anonymous access', async () => {
    const origin = await start('https://t.me/planner_pair_bot')
    const anonymous = await fetch(`${origin}/telegram/navigation`)
    expect(anonymous.status).toBe(401)

    const response = await fetch(`${origin}/telegram/navigation`, {
      headers: { cookie: sessionCookie },
    })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({
      schemaVersion: 'telegram.navigation.v1',
      capability: 'open_bot',
      status: 'available',
      url: 'https://t.me/planner_pair_bot',
    })
    expect(JSON.stringify(body)).not.toMatch(
      /token|start=|telegramId|chatId|memberId|userId/u,
    )
  })

  it.each([
    [undefined, 'disabled'],
    ['http://t.me/planner_pair_bot?start=member-id', 'misconfigured'],
  ] as const)(
    'returns %s configuration as %s without leaking it',
    async (url, status) => {
      const origin = await start(url)
      const response = await fetch(`${origin}/telegram/navigation`, {
        headers: { cookie: sessionCookie },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        schemaVersion: 'telegram.navigation.v1',
        capability: 'open_bot',
        status,
        url: null,
      })
    },
  )
})
