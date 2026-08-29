import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { ApiModule } from '@/bootstrap/api/api.module'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import {
  TELEGRAM_INGRESS_LIFECYCLE,
  type TelegramIngressLifecycle,
} from '@/modules/telegram-bot'
import {
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace/application/workspace-member-resolver.port'
import { createApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { DatabaseLifecycle } from '@/platform/database/database.contracts'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { DATABASE_LIFECYCLE } from '@/platform/database/database.tokens'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { RequestContext } from '@/platform/http/context/request-context'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import type { RedisLifecyclePort } from '@/platform/redis/redis-lifecycle'
import { REDIS_LIFECYCLE } from '@/platform/redis/redis.tokens'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const outsiderUserId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'
const memberId = '55555555-5555-4555-8555-555555555555'
const secondMemberId = '66666666-6666-4666-8666-666666666666'
const foreignSpaceId = '77777777-7777-4777-8777-777777777777'
const sessionKeySecret = Buffer.alloc(32, 81)
const csrfSecret = Buffer.alloc(32, 82)

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const read = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${read('year')}-${read('month')}`
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

type ForeignResolverHarness = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

async function createForeignResolverHarness(): Promise<ForeignResolverHarness> {
  const resolver: WorkspaceMemberResolver = {
    resolveUser: (resolvedUserId) =>
      Promise.resolve({
        spaceId: foreignSpaceId,
        memberId,
        userId: resolvedUserId,
      }),
    resolveTelegramId: () =>
      Promise.resolve({ spaceId: foreignSpaceId, memberId, userId }),
    resolveMember: (resolvedMemberId) =>
      Promise.resolve({
        spaceId: foreignSpaceId,
        memberId: resolvedMemberId,
        userId,
      }),
  }
  const port = await reservePort()
  const baseConfig = createApiRuntimeConfig()
  const config = { ...baseConfig, http: { ...baseConfig.http, port } }
  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule.forRoot(config)],
  })
    .overrideProvider(WORKSPACE_MEMBER_RESOLVER)
    .useValue(resolver)
    .compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  })
  const lifecycle = app.get(ApplicationLifecycleState)
  const database = app.get<DatabaseLifecycle>(DATABASE_LIFECYCLE)
  const redisLifecycle = app.get<RedisLifecyclePort>(REDIS_LIFECYCLE)
  const requestTracker = app.get(ActiveRequestTracker)
  configureHttpApplication(
    app,
    lifecycle,
    requestTracker,
    app.get(RequestContext),
    app.get<StructuredLogger>(STRUCTURED_LOGGER),
  )
  await app.init()
  await Promise.all([
    database.connect(AbortSignal.timeout(3_000)),
    redisLifecycle.connect(AbortSignal.timeout(3_000)),
  ])
  await app
    .get<TelegramIngressLifecycle>(TELEGRAM_INGRESS_LIFECYCLE)
    .start(AbortSignal.timeout(3_000))
  await app.listen(config.http.port, config.http.host)
  lifecycle.markReady()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      lifecycle.beginDrain()
      const signal = AbortSignal.timeout(3_000)
      await app
        .get<TelegramIngressLifecycle>(TELEGRAM_INGRESS_LIFECYCLE)
        .stop(signal)
        .catch(() => undefined)
      await Promise.allSettled([
        database.close(signal),
        redisLifecycle.close(signal),
      ])
      await app.close()
    },
  }
}

describe('F05 authenticated HTTP updates planner month focus', () => {
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
  let planMonthId: string
  let currentRevision = 1

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f05_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${secondUserId}'::uuid),
        ('${outsiderUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 83).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'f05-e2e-secret-long',
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

  async function postFocus(
    targetId: string,
    value: object,
    cookie = firstCookie,
    csrfToken = firstCsrf,
  ): Promise<Response> {
    return fetch(`${baseUrl}/planning/drafts/${targetId}/focus`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(value),
    })
  }

  async function postFocusTo(
    targetBaseUrl: string,
    targetId: string,
    value: object,
  ): Promise<Response> {
    return fetch(`${targetBaseUrl}/planning/drafts/${targetId}/focus`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify(value),
    })
  }

  async function createDraft(): Promise<void> {
    const response = await fetch(`${baseUrl}/planning/drafts/empty`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        targetMonth: currentMonth(),
        focus: 'Initial focus',
      }),
    })
    expect(response.status).toBe(201)
    const body = await json(response)
    planMonthId = String(body['aggregateId'])
  }

  async function mutationDigest(): Promise<string> {
    const result = await admin.query<{ readonly digest: string }>(
      `SELECT jsonb_build_object(
        'drafts', COALESCE((SELECT jsonb_agg(to_jsonb(draft) ORDER BY draft.plan_month_id)
          FROM plan_drafts draft), '[]'::jsonb),
        'actions', COALESCE((SELECT jsonb_agg(to_jsonb(action) ORDER BY action.id)
          FROM planning_action_groups action), '[]'::jsonb),
        'receipts', COALESCE((SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.command_id)
          FROM command_receipts receipt), '[]'::jsonb)
      )::text digest`,
    )
    return result.rows[0]!.digest
  }

  it('documents the exact CSRF-protected operation and stale recovery', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    const operation = document.paths['/planning/drafts/{planMonthId}/focus']?.[
      'post'
    ] as {
      security?: unknown
      requestBody?: {
        content?: Record<string, { schema?: Record<string, unknown> }>
      }
      responses?: Record<string, unknown>
    }
    expect(operation.security).toEqual([{ sessionCookie: [], csrfToken: [] }])
    expect(
      operation.requestBody?.content?.['application/json']?.schema,
    ).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['commandId', 'expectedRevision', 'focus'],
      properties: {
        expectedRevision: { pattern: '^[1-9][0-9]*$' },
        focus: {
          pattern: '^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$',
          maxLength: 500,
        },
      },
    })
    expect(operation.responses).toHaveProperty('200')
    expect(JSON.stringify(operation.responses)).toContain(
      'DRAFT_REVISION_CONFLICT',
    )
    expect(
      document.components.schemas['DraftProblemConflictResponseDto'],
    ).toMatchObject({
      required: ['expectedRevision', 'currentRevision', 'nextAction'],
      properties: {
        nextAction: { enum: ['reload-draft-and-retry'] },
      },
    })
  })

  it('requires session and CSRF and rejects forged or invalid input without writes', async () => {
    const before = await mutationDigest()
    const value = {
      commandId: randomUUID(),
      expectedRevision: '1',
      focus: 'Updated focus',
    }
    expect((await postFocus(randomUUID(), value, '')).status).toBe(401)
    expect(
      (await postFocus(randomUUID(), value, firstCookie, 'wrong')).status,
    ).toBe(403)
    for (const invalid of [
      { ...value, actor: memberId },
      { ...value, spaceId },
      { ...value, expectedRevision: '0' },
      { ...value, expectedRevision: 1 },
      { ...value, focus: '   ' },
      { ...value, focus: 'safe\u0000unsafe' },
      { ...value, focus: 'x'.repeat(501) },
    ]) {
      const response = await postFocus(randomUUID(), invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect((await postFocus('not-a-uuid', value)).status).toBe(422)
    expect(
      (await postFocus(randomUUID(), value, outsiderCookie, outsiderCsrf))
        .status,
    ).toBe(403)
    expect(await mutationDigest()).toBe(before)
  })

  it('conceals missing and foreign drafts and updates through either pair member', async () => {
    const request = {
      commandId: randomUUID(),
      expectedRevision: '1',
      focus: 'Updated focus',
    }
    await createDraft()
    const missing = await postFocus(randomUUID(), request)
    const foreignHarness = await createForeignResolverHarness()
    try {
      const foreign = await postFocusTo(
        foreignHarness.baseUrl,
        planMonthId,
        request,
      )
      expect(missing.status).toBe(404)
      expect(foreign.status).toBe(404)
      expect(await json(missing)).toMatchObject({
        code: 'PLAN_DRAFT_NOT_FOUND',
      })
      expect(await json(foreign)).toMatchObject({
        code: 'PLAN_DRAFT_NOT_FOUND',
      })
    } finally {
      await foreignHarness.close()
    }

    const updated = await postFocus(
      planMonthId,
      { ...request, commandId: randomUUID(), focus: '  Confirmed focus  ' },
      secondCookie,
      secondCsrf,
    )
    expect(updated.status).toBe(200)
    expect(await json(updated)).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateId: planMonthId,
      aggregateRevision: '2',
    })
    currentRevision = 2
    const editor = await fetch(
      `${baseUrl}/planning/drafts?targetMonth=${currentMonth()}`,
      { headers: { cookie: firstCookie } },
    )
    expect(editor.status).toBe(200)
    expect(await json(editor)).toMatchObject({
      focus: '  Confirmed focus  ',
      planMonthRevision: '1',
      draftRevision: '2',
    })
    const history = await admin.query<{
      readonly action_kind: string
      readonly member_id: string
      readonly before_revision: string
      readonly after_revision: string
    }>(
      `SELECT action_kind, member_id::text, before_revision::text,
              after_revision::text
         FROM planning_action_groups
        WHERE plan_month_id = $1::uuid
        ORDER BY after_revision`,
      [planMonthId],
    )
    expect(history.rows.at(-1)).toEqual({
      action_kind: 'month_focus_updated',
      member_id: secondMemberId,
      before_revision: '1',
      after_revision: '2',
    })
  })

  it('replays exactly and supports stale retry without losing concurrent updates', async () => {
    const exactCommandId = randomUUID()
    const exactRequest = {
      commandId: exactCommandId,
      expectedRevision: String(currentRevision),
      focus: 'Replay focus',
    }
    const first = await postFocus(planMonthId, exactRequest)
    expect(first.status).toBe(200)
    const firstBody = await json(first)
    currentRevision += 1
    const replay = await postFocus(planMonthId, exactRequest)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(firstBody)
    const fingerprint = await postFocus(planMonthId, {
      ...exactRequest,
      focus: 'Different payload',
    })
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })

    const staleCommandId = randomUUID()
    const stale = await postFocus(planMonthId, {
      commandId: staleCommandId,
      expectedRevision: String(currentRevision - 1),
      focus: 'Stale retry focus',
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      conflict: {
        expectedRevision: String(currentRevision - 1),
        currentRevision: String(currentRevision),
        nextAction: 'reload-draft-and-retry',
      },
    })
    const retried = await postFocus(planMonthId, {
      commandId: staleCommandId,
      expectedRevision: String(currentRevision),
      focus: 'Stale retry focus',
    })
    expect(retried.status).toBe(200)
    currentRevision += 1

    const [left, right] = await Promise.all([
      postFocus(planMonthId, {
        commandId: randomUUID(),
        expectedRevision: String(currentRevision),
        focus: 'Concurrent left',
      }),
      postFocus(
        planMonthId,
        {
          commandId: randomUUID(),
          expectedRevision: String(currentRevision),
          focus: 'Concurrent right',
        },
        secondCookie,
        secondCsrf,
      ),
    ])
    expect([left.status, right.status].sort()).toEqual([200, 409])
    const conflict = left.status === 409 ? left : right
    expect(await json(conflict)).toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
      conflict: {
        expectedRevision: String(currentRevision),
        currentRevision: String(currentRevision + 1),
        nextAction: 'reload-draft-and-retry',
      },
    })
    currentRevision += 1
    const row = await admin.query<{
      readonly focus: string
      readonly revision: string
      readonly month_revision: string
    }>(
      `SELECT draft.focus, draft.revision::text,
              month.revision::text month_revision
         FROM plan_drafts draft
         JOIN plan_months month ON month.id = draft.plan_month_id
        WHERE draft.plan_month_id = $1::uuid`,
      [planMonthId],
    )
    expect(row.rows[0]).toMatchObject({
      revision: String(currentRevision),
      month_revision: '1',
    })
    expect(['Concurrent left', 'Concurrent right']).toContain(
      row.rows[0]!.focus,
    )
  })

  it('publishes the confirmed focus and keeps the publication immutable', async () => {
    const update = await postFocus(planMonthId, {
      commandId: randomUUID(),
      expectedRevision: String(currentRevision),
      focus: 'Published focus',
    })
    expect(update.status).toBe(200)
    currentRevision += 1
    const previewResponse = await fetch(
      `${baseUrl}/planning/drafts/publication-preview?targetMonth=${currentMonth()}`,
      { headers: { cookie: firstCookie } },
    )
    expect(previewResponse.status).toBe(200)
    const preview = await json(previewResponse)
    expect(preview).toMatchObject({
      planMonthId,
      focus: 'Published focus',
      draftRevision: String(currentRevision),
      blockers: [],
    })
    const publish = await fetch(
      `${baseUrl}/planning/drafts/${planMonthId}/publish`,
      {
        method: 'POST',
        headers: {
          cookie: firstCookie,
          origin,
          'content-type': 'application/json',
          'x-csrf-token': firstCsrf,
        },
        body: JSON.stringify({
          commandId: randomUUID(),
          expectedRevision: String(currentRevision),
          previewSchemaVersion: preview['schemaVersion'],
          previewHashVersion: preview['previewHashVersion'],
          previewHash: preview['previewHash'],
        }),
      },
    )
    expect(publish.status).toBe(201)
    const publicationRef = await json(publish)
    const publicationId = String(publicationRef['aggregateId'])
    const before = await fetch(
      `${baseUrl}/planning/publications/${publicationId}`,
      { headers: { cookie: firstCookie } },
    )
    expect(before.status).toBe(200)
    const beforeText = await before.text()
    expect(JSON.parse(beforeText)).toMatchObject({ focus: 'Published focus' })

    const rejected = await postFocus(planMonthId, {
      commandId: randomUUID(),
      expectedRevision: String(currentRevision),
      focus: 'Forbidden published edit',
    })
    expect(rejected.status).toBe(409)
    expect(await json(rejected)).toMatchObject({
      code: 'PLAN_DRAFT_NOT_EDITABLE',
    })
    const after = await fetch(
      `${baseUrl}/planning/publications/${publicationId}`,
      { headers: { cookie: secondCookie } },
    )
    expect(after.status).toBe(200)
    expect(await after.text()).toBe(beforeText)
  })
})
