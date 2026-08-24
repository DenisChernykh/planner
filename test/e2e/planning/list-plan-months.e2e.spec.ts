import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { configureApi } from '@/bootstrap/api/configure-api'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { startRedisContainer } from '@test/integration/support/redis-container'
import {
  LIST_PLAN_MONTH_FIXTURES,
  seedListPlanMonthsFixture,
} from '@test/support/planning/list-plan-months-fixture'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const outsiderUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const sessionKeySecret = Buffer.alloc(32, 71)
const csrfSecret = Buffer.alloc(32, 72)

interface MonthIndexItem {
  readonly targetMonth: string
  readonly phase: string
  readonly lifecycle: {
    readonly planMonthId: string
    readonly status: string
    readonly mode: string
    readonly revision: string
  }
  readonly draft: { readonly revision: string }
  readonly publication: {
    readonly publicationId: string
    readonly revision: string
    readonly activeLocalDate: string
    readonly isActive: boolean
  } | null
  readonly report: {
    readonly reportRevisionId: string
    readonly revision: string
    readonly status: string
  } | null
  readonly allowedActions: Record<string, boolean>
}

interface MonthIndexPage {
  readonly schemaVersion?: string
  readonly items: readonly MonthIndexItem[]
  readonly nextCursor: string | null
}

function cursor(targetMonth: string, planMonthId: string): string {
  return `v1.${Buffer.from(
    JSON.stringify({ v: 1, targetMonth, planMonthId }),
    'utf8',
  ).toString('base64url')}`
}

function migrate(databaseUrl: string): void {
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

async function port(): Promise<number> {
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

describe('F02 plan month discovery HTTP', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let cookie: string
  let outsiderCookie: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f02_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    migrate(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query('INSERT INTO users (id) VALUES ($1), ($2)', [
      userId,
      outsiderUserId,
    ])
    await admin.query('INSERT INTO spaces (id, singleton_key) VALUES ($1, 1)', [
      spaceId,
    ])
    await admin.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $2, $3, 1)`,
      [memberId, spaceId, userId],
    )
    await seedListPlanMonthsFixture(admin, { spaceId, memberId })

    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 4,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 1_000,
        transactionMaxWaitMs: 2_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const transactionContext = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, transactionContext)
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
    const first = await issue.execute(userId, Date.now())
    const outsider = await issue.execute(outsiderUserId, Date.now())
    cookie = `planner-session=${first.rawToken}`
    outsiderCookie = `planner-session=${outsider.rawToken}`
    const apiPort = await port()
    baseUrl = `http://127.0.0.1:${apiPort}`
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: sessionKeySecret.toString('base64url'),
      AUTH_CSRF_SECRET: csrfSecret.toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 73).toString('base64url'),
      AUTH_CSRF_ORIGINS: baseUrl,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'f02-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${baseUrl}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime(() =>
      configureApi(
        undefined,
        new FakeProductClock(new Date('2031-03-15T10:00:00.000Z')),
      ),
    )
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

  it('serializes populated lifecycle pages and enforces HTTP security', async () => {
    const unauthenticated = await fetch(`${baseUrl}/planning/months`)
    expect(unauthenticated.status).toBe(401)
    const invalid = await fetch(`${baseUrl}/planning/months?limit=0`, {
      headers: { cookie },
    })
    expect(invalid.status).toBe(422)

    const expectValidationProblem = async (
      response: Response,
    ): Promise<void> => {
      expect(response.status).toBe(422)
      expect(response.headers.get('content-type')).toContain(
        'application/problem+json',
      )
      const requestId = response.headers.get('x-request-id')
      expect(requestId).toMatch(
        /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/u,
      )
      const body = (await response.json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        'code',
        'detail',
        'errors',
        'instance',
        'requestId',
        'status',
        'title',
        'type',
      ])
      expect(body).toMatchObject({
        type: 'https://planner.invalid/problems/validation-failed',
        title: 'Validation failed',
        status: 422,
        detail: 'One or more request fields are invalid.',
        instance: `urn:request:${requestId}`,
        requestId,
        code: 'VALIDATION_FAILED',
      })
      expect(Array.isArray(body.errors)).toBe(true)
    }

    await expectValidationProblem(
      await fetch(
        `${baseUrl}/planning/months?cursor=${encodeURIComponent(
          'v1.not-base64',
        )}`,
        { headers: { cookie } },
      ),
    )
    const unknownVersionCursor = `v2.${Buffer.from(
      JSON.stringify({
        v: 2,
        targetMonth: '2031-03',
        planMonthId: LIST_PLAN_MONTH_FIXTURES.active.planMonthId,
      }),
      'utf8',
    ).toString('base64url')}`
    await expectValidationProblem(
      await fetch(
        `${baseUrl}/planning/months?cursor=${encodeURIComponent(
          unknownVersionCursor,
        )}`,
        { headers: { cookie } },
      ),
    )

    const outsider = await fetch(`${baseUrl}/planning/months`, {
      headers: { cookie: outsiderCookie },
    })
    expect(outsider.status).toBe(403)

    const response = await fetch(`${baseUrl}/planning/months?limit=3`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as MonthIndexPage & {
      readonly schemaVersion: string
    }
    expect(body.schemaVersion).toBe('planning.month-index.v1')
    expect(body.items).toHaveLength(3)
    expect(body.items.map((item) => item.targetMonth)).toEqual([
      '2031-04',
      '2031-03',
      '2031-02',
    ])
    expect(body.items[0]).toMatchObject({
      targetMonth: LIST_PLAN_MONTH_FIXTURES.future.targetMonth,
      phase: 'future',
      lifecycle: {
        planMonthId: LIST_PLAN_MONTH_FIXTURES.future.planMonthId,
        status: 'published',
        mode: 'ordinary',
        revision: '2',
      },
      draft: { revision: '1' },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.future.publicationId,
        revision: '1',
        activeLocalDate: '2031-04-01',
        isActive: true,
      },
      report: null,
      allowedActions: {
        openDraft: false,
        openPublication: true,
        copySource: true,
        cancel: true,
        reopen: false,
        reclose: false,
      },
    })
    expect(body.items[1]).toMatchObject({
      targetMonth: '2031-03',
      phase: 'active',
      lifecycle: { status: 'published', revision: '2' },
      publication: { isActive: true },
      report: null,
      allowedActions: { cancel: false },
    })
    expect(body.items[2]).toMatchObject({
      targetMonth: '2031-02',
      phase: 'draft',
      lifecycle: {
        planMonthId: LIST_PLAN_MONTH_FIXTURES.cancelled.planMonthId,
        status: 'draft',
        mode: 'ordinary',
        revision: '3',
      },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.cancelled.publicationId,
        revision: '1',
        activeLocalDate: '2031-02-01',
        isActive: false,
      },
      report: null,
      allowedActions: {
        openDraft: true,
        openPublication: true,
        copySource: true,
        cancel: false,
        reopen: false,
        reclose: false,
      },
    })
    expect(body.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u)

    const secondResponse = await fetch(
      `${baseUrl}/planning/months?limit=3&cursor=${encodeURIComponent(
        body.nextCursor!,
      )}`,
      { headers: { cookie } },
    )
    expect(secondResponse.status).toBe(200)
    const second = (await secondResponse.json()) as MonthIndexPage
    expect(second.items.map((item) => item.targetMonth)).toEqual([
      '2031-01',
      '2030-12',
      '2030-11',
    ])
    expect(second.items[0]).toMatchObject({
      phase: 'grace',
      lifecycle: { status: 'grace', mode: 'ordinary', revision: '3' },
      report: null,
      allowedActions: { reclose: false },
    })
    expect(second.items[1]).toMatchObject({
      phase: 'grace',
      lifecycle: { status: 'grace', mode: 'reopened', revision: '5' },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.graceReopened.reportRevisionId,
        revision: '1',
        status: 'original',
      },
      allowedActions: { reclose: true },
    })
    expect(second.items[2]).toMatchObject({
      phase: 'closed',
      lifecycle: { status: 'closed', mode: 'ordinary', revision: '4' },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.closedOrdinary.reportRevisionId,
        revision: '1',
        status: 'original',
      },
      allowedActions: { reopen: true, reclose: false },
    })
    expect(second.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u)

    const thirdResponse = await fetch(
      `${baseUrl}/planning/months?limit=3&cursor=${encodeURIComponent(
        second.nextCursor!,
      )}`,
      { headers: { cookie } },
    )
    expect(thirdResponse.status).toBe(200)
    const third = (await thirdResponse.json()) as MonthIndexPage
    expect(third.items).toHaveLength(1)
    expect(third.items[0]).toMatchObject({
      targetMonth: '2030-10',
      phase: 'closed',
      lifecycle: { status: 'closed', mode: 'reopened', revision: '6' },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.closedReopened.publicationId,
        revision: '1',
        isActive: true,
      },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.closedReopened.reportRevisionId,
        revision: '2',
        status: 'revised',
      },
      allowedActions: { reopen: true, reclose: false },
    })
    expect(third.nextCursor).toBeNull()
    const allItems = [...body.items, ...second.items, ...third.items]
    expect(
      new Set(allItems.map((item) => item.lifecycle.planMonthId)).size,
    ).toBe(allItems.length)
    for (const item of allItems) {
      expect(typeof item.lifecycle.revision).toBe('string')
      expect(typeof item.draft.revision).toBe('string')
    }

    const empty = await fetch(
      `${baseUrl}/planning/months?limit=1&cursor=${encodeURIComponent(
        cursor('2000-01', '00000000-0000-4000-8000-000000000000'),
      )}`,
      { headers: { cookie } },
    )
    expect(empty.status).toBe(200)
    await expect(empty.json()).resolves.toMatchObject({
      schemaVersion: 'planning.month-index.v1',
      items: [],
      nextCursor: null,
    })
  })
})
