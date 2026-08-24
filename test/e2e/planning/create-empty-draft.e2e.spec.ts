import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
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
const userId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const outsiderUserId = '66666666-6666-4666-8666-666666666666'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const sessionKeySecret = Buffer.alloc(32, 61)
const csrfSecret = Buffer.alloc(32, 62)

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

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('F03 authenticated HTTP creates empty planner drafts', () => {
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
  let secondCsrf: string
  let outsiderCookie: string
  let outsiderCsrf: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f03_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'), ('${secondUserId}'), ('${outsiderUserId}');
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}', 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}', '${spaceId}', '${userId}', 1),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2);
    `)

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
      issue.execute(userId, Date.now()),
      issue.execute(secondUserId, Date.now()),
      issue.execute(outsiderUserId, Date.now()),
    ])
    firstCookie = `planner-session=${first.rawToken}`
    firstCsrf = first.csrfToken
    secondCookie = `planner-session=${second.rawToken}`
    secondCsrf = second.csrfToken
    outsiderCookie = `planner-session=${outsider.rawToken}`
    outsiderCsrf = outsider.csrfToken

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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 63).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'f03-e2e-secret-long',
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
    ])
      delete process.env[key]
  })

  async function post(
    value: object,
    cookie = firstCookie,
    csrfToken = firstCsrf,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/planning/drafts/empty`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        ...headers,
      },
      body: JSON.stringify(value),
    })
  }

  async function state(): Promise<Record<string, string>> {
    const result = await admin.query<Record<string, string>>(`
      SELECT
        (SELECT count(*)::text FROM plan_months) months,
        (SELECT count(*)::text FROM plan_drafts) drafts,
        (SELECT count(*)::text FROM planning_action_groups) history,
        (SELECT count(*)::text FROM command_receipts) receipts
    `)
    return result.rows[0]!
  }

  it('documents exact body, 201 response, typed existing conflict and security', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
    }
    const operation = document.paths['/planning/drafts/empty']?.post as {
      security?: unknown
      requestBody?: {
        content?: Record<string, { schema?: Record<string, unknown> }>
      }
      responses?: Record<string, unknown>
    }
    expect(operation.security).toEqual([{ sessionCookie: [], csrfToken: [] }])
    const bodySchema =
      operation.requestBody?.content?.['application/json']?.schema
    expect(bodySchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['commandId', 'targetMonth', 'focus'],
    })
    const bodyProperties = bodySchema?.['properties'] as
      Record<string, Record<string, unknown>> | undefined
    expect(bodyProperties?.['targetMonth']?.['pattern']).toEqual(
      expect.stringContaining('0[1-9]'),
    )
    expect(bodyProperties?.['focus']).toMatchObject({
      pattern: '^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$',
      maxLength: 500,
    })
    expect(operation.responses).toHaveProperty('201')
    expect(JSON.stringify(operation.responses)).toContain(
      'PLAN_MONTH_ALREADY_EXISTS',
    )
    expect(JSON.stringify(operation.responses)).toContain('existingRef')
    expect(JSON.stringify(operation.responses)).toContain('open-existing-month')
  })

  it('requires session and CSRF and rejects forged fields with zero writes', async () => {
    const value = {
      commandId: randomUUID(),
      targetMonth: '2035-04',
      focus: 'April focus',
    }
    expect((await post(value, '')).status).toBe(401)
    expect((await post(value, firstCookie, 'wrong')).status).toBe(403)
    for (const invalid of [
      { ...value, actor: memberId },
      { ...value, spaceId },
      { ...value, expectedRevision: '1' },
      { ...value, focus: '   ' },
      { ...value, focus: 'safe\u0000unsafe' },
      { ...value, targetMonth: '2035-4' },
      { ...value, focus: 'x'.repeat(501) },
    ]) {
      const response = await post(invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect((await post(value, outsiderCookie, outsiderCsrf)).status).toBe(403)
    expect(await state()).toEqual({
      months: '0',
      drafts: '0',
      history: '0',
      receipts: '0',
    })
  })

  it('creates through either pair member, preserves focus and records session actor', async () => {
    const firstCommandId = randomUUID()
    const firstRequest = {
      commandId: firstCommandId,
      targetMonth: '2035-04',
      focus: '  April focus  ',
    }
    const first = await post(firstRequest)
    expect(first.status).toBe(201)
    const firstBody = await json(first)
    expect(firstBody).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: '1',
    })
    const editor = await fetch(
      `${baseUrl}/planning/drafts?targetMonth=2035-04`,
      { headers: { cookie: firstCookie } },
    )
    expect(editor.status).toBe(200)
    expect(await json(editor)).toMatchObject({ focus: '  April focus  ' })
    const second = await post(
      { commandId: randomUUID(), targetMonth: '2035-05', focus: 'May focus' },
      secondCookie,
      secondCsrf,
    )
    expect(second.status).toBe(201)

    const rows = await admin.query<{
      readonly actor_kind: string
      readonly member_id: string
      readonly action_kind: string
      readonly after_revision: string
    }>(
      `SELECT actor_kind, member_id::text, action_kind, after_revision::text
         FROM planning_action_groups
        WHERE action_kind = 'draft_created'
        ORDER BY occurred_at, id`,
    )
    expect(rows.rows).toEqual([
      {
        actor_kind: 'member',
        member_id: memberId,
        action_kind: 'draft_created',
        after_revision: '1',
      },
      {
        actor_kind: 'member',
        member_id: secondMemberId,
        action_kind: 'draft_created',
        after_revision: '1',
      },
    ])
    expect(String(firstBody['aggregateId'])).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('replays exactly, rejects fingerprint changes, and returns safe existingRef', async () => {
    const commandId = randomUUID()
    const request = { commandId, targetMonth: '2035-04', focus: 'April focus' }
    const first = await post(request)
    expect(first.status).toBe(409)
    const existing = await json(first)
    expect(existing).toMatchObject({
      code: 'PLAN_MONTH_ALREADY_EXISTS',
      conflict: {
        existingRef: {
          kind: 'planning.plan-draft.v1',
          aggregateRevision: '1',
        },
        nextAction: 'open-existing-month',
      },
    })
    expect(JSON.stringify(existing)).not.toMatch(/spaceId|userId/u)

    const createdCommand = randomUUID()
    const createdRequest = {
      commandId: createdCommand,
      targetMonth: '2035-07',
      focus: 'July focus',
    }
    const created = await post(createdRequest)
    expect(created.status).toBe(201)
    const createdBody = await json(created)
    const replay = await post(createdRequest)
    expect(replay.status).toBe(201)
    expect(await json(replay)).toEqual(createdBody)
    const fingerprint = await post({ ...createdRequest, focus: 'other' })
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
  })

  it('serializes competing commands into one month and one history/receipt', async () => {
    const before = await state()
    const [left, right] = await Promise.all([
      post({ commandId: randomUUID(), targetMonth: '2035-08', focus: 'left' }),
      post(
        { commandId: randomUUID(), targetMonth: '2035-08', focus: 'right' },
        secondCookie,
        secondCsrf,
      ),
    ])
    expect([left.status, right.status].sort()).toEqual([201, 409])
    const conflict = left.status === 409 ? left : right
    expect(await json(conflict)).toMatchObject({
      code: 'PLAN_MONTH_ALREADY_EXISTS',
      conflict: {
        existingRef: {
          kind: 'planning.plan-draft.v1',
          aggregateRevision: '1',
        },
        nextAction: 'open-existing-month',
      },
    })
    const after = await state()
    expect(Number(after.months)).toBe(Number(before.months) + 1)
    expect(Number(after.drafts)).toBe(Number(before.drafts) + 1)
    expect(Number(after.history)).toBe(Number(before.history) + 1)
    expect(Number(after.receipts)).toBe(Number(before.receipts) + 1)
  })
})
