import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'
import request from 'supertest'

import { ApiModule } from '@/bootstrap/api/api.module'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URL,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
} from '@/modules/auth/application/telegram-oidc.ports'
import {
  createPlanningLifecycleWorker,
  PLANNING_APPLICATION,
  type PlanningApplication,
} from '@/modules/planning'
import {
  createRemindersApplication,
  type ReminderDeliveryTransportPort,
} from '@/modules/reminders'
import {
  REPORTING_APPLICATION,
  type ReportingApplication,
} from '@/modules/reporting'
import {
  TELEGRAM_BOT_API,
  TELEGRAM_INGRESS_LIFECYCLE,
  type GetUpdatesRunner,
  type TelegramBotApiPort,
  type TelegramIngressLifecycle,
  type TelegramSendMessage,
} from '@/modules/telegram-bot'
import {
  TRACKING_APPLICATION,
  type TrackingApplication,
} from '@/modules/tracking'
import {
  ProvisionPairUseCase,
  WORKSPACE_MEMBER_RESOLVER,
  WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER,
  type WorkspaceMemberResolver,
  type WorkspaceTelegramRecipientResolver,
} from '@/modules/workspace'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { RequestContext } from '@/platform/http/context/request-context'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'
import type { RedisLifecyclePort } from '@/platform/redis/redis-lifecycle'
import { REDIS_LIFECYCLE } from '@/platform/redis/redis.tokens'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const ORIGIN = 'http://127.0.0.1:3000'
const clientId = '123456789'
const clientSecret = 'e01-acceptance-client-secret'
const accessToken = 'e01-telegram-access-token'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const firstTelegramId = 4_503_599_627_370_491
const secondTelegramId = 4_503_599_627_370_492
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 })
const publicJwk = keyPair.publicKey.export({ format: 'jwk' })
const kid = 'e01-telegram-key'

type BrowserSession = {
  readonly cookie: string
  readonly csrf: string
  readonly userId: string
}

type SnapshotRow = {
  readonly id: string
  readonly title: string
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

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function oidcHash(value: string): string {
  return createHash('sha256')
    .update(value, 'ascii')
    .digest()
    .subarray(0, 16)
    .toString('base64url')
}

function signedIdToken(input: {
  readonly nonce: string
  readonly code: string
  readonly providerUserId: number
}): string {
  const now = Math.floor(Date.now() / 1_000)
  const header = base64UrlJson({ alg: 'RS256', kid, typ: 'JWT' })
  const payload = base64UrlJson({
    iss: TELEGRAM_OIDC_ISSUER,
    aud: clientId,
    sub: `e01-subject-${input.providerUserId}`,
    iat: now,
    exp: now + 300,
    nonce: input.nonce,
    id: input.providerUserId,
    at_hash: oidcHash(accessToken),
    c_hash: oidcHash(input.code),
    preferred_username: 'ignored_by_planner',
    phone_number: '+000000000',
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), {
    key: keyPair.privateKey,
  }).toString('base64url')
  return `${signingInput}.${signature}`
}

function discovery(): Record<string, unknown> {
  return {
    issuer: TELEGRAM_OIDC_ISSUER,
    authorization_endpoint: TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    token_endpoint: TELEGRAM_OIDC_TOKEN_ENDPOINT,
    jwks_uri: TELEGRAM_OIDC_JWKS_URL,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'telegram:bot_access'],
    code_challenge_methods_supported: ['S256'],
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function cookiePair(value: string): string {
  return value.split(';', 1)[0] ?? ''
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object response body')
  }
  return value as Record<string, unknown>
}

describe('E01 full backend pilot acceptance', () => {
  jest.setTimeout(240_000)

  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let redisLifecycle: RedisLifecyclePort
  let lifecycleState: ApplicationLifecycleState
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let reporting: ReportingApplication
  let transaction: DatabaseTransactionPort
  let workspaceMembers: WorkspaceMemberResolver
  let telegramRecipients: WorkspaceTelegramRecipientResolver
  let telegramIngress: TelegramIngressLifecycle
  let firstMemberId: string
  let secondMemberId: string
  let spaceId: string
  let realFetch: typeof globalThis.fetch = globalThis.fetch
  let activeNonce = ''
  let activeProviderUserId = firstTelegramId
  let updateId = 1_000

  const telegramBatches: unknown[][] = []
  const telegramMessages: TelegramSendMessage[] = []
  const reminderDeliveries: {
    readonly chatId: bigint
    readonly text: string
  }[] = []

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_e01_acceptance')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })

    realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input)
      if (url === TELEGRAM_OIDC_DISCOVERY_URL) {
        return Promise.resolve(jsonResponse(discovery()))
      }
      if (url === TELEGRAM_OIDC_TOKEN_ENDPOINT) {
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error('OIDC token form is missing')
        }
        const code = init.body.get('code') ?? ''
        return Promise.resolve(
          jsonResponse({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 300,
            id_token: signedIdToken({
              nonce: activeNonce,
              code,
              providerUserId: activeProviderUserId,
            }),
          }),
        )
      }
      if (url === TELEGRAM_OIDC_JWKS_URL) {
        return Promise.resolve(
          jsonResponse({
            keys: [
              {
                ...publicJwk,
                kid,
                alg: 'RS256',
                use: 'sig',
                key_ops: ['verify'],
              },
            ],
          }),
        )
      }
      throw new Error(`Unexpected external request: ${url}`)
    }

    const bot: TelegramBotApiPort = {
      getUpdates: jest.fn(() => Promise.resolve(telegramBatches.shift() ?? [])),
      sendMessage: jest.fn((input) => {
        telegramMessages.push(input)
        return Promise.resolve()
      }),
      answerCallbackQuery: jest.fn(() => Promise.resolve()),
    }
    const runtimeConfig = buildApiRuntimeConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      DATABASE_URL: postgres.getConnectionUri(),
      DATABASE_POOL_MAX: 16,
      DATABASE_TRANSACTION_TIMEOUT_MS: 60_000,
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 101).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 102).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 103).toString('base64url'),
      AUTH_CSRF_ORIGINS: ORIGIN,
      TELEGRAM_OIDC_CLIENT_ID: clientId,
      TELEGRAM_OIDC_CLIENT_SECRET: clientSecret,
      TELEGRAM_OIDC_CALLBACK_URL: `${ORIGIN}/auth/telegram/callback`,
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:e01-acceptance-bot-token',
    })
    clock = new FakeProductClock(new Date('2026-03-30T07:00:00.123Z'))
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(runtimeConfig, clock)],
    })
      .overrideProvider(TELEGRAM_BOT_API)
      .useValue(bot)
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    })
    lifecycleState = app.get(ApplicationLifecycleState)
    configureHttpApplication(
      app,
      lifecycleState,
      app.get(ActiveRequestTracker),
      app.get(RequestContext),
      app.get<StructuredLogger>(STRUCTURED_LOGGER),
    )
    await app.init()
    database = app.get(PrismaClientProvider)
    redisLifecycle = app.get<RedisLifecyclePort>(REDIS_LIFECYCLE)
    await Promise.all([
      database.connect(AbortSignal.timeout(5_000)),
      redisLifecycle.connect(AbortSignal.timeout(5_000)),
    ])
    lifecycleState.markReady()

    const provisioned = await app.get(ProvisionPairUseCase).execute({
      members: [
        { userId: firstUserId, telegramId: BigInt(firstTelegramId) },
        { userId: secondUserId, telegramId: BigInt(secondTelegramId) },
      ],
    })
    expect(provisioned.status).toBe('created')
    spaceId = provisioned.spaceId
    const memberByUser = new Map(
      provisioned.members.map((member) => [member.userId, member.memberId]),
    )
    firstMemberId = memberByUser.get(firstUserId) ?? ''
    secondMemberId = memberByUser.get(secondUserId) ?? ''
    if (firstMemberId === '' || secondMemberId === '') {
      throw new Error('Provisioned pair members are missing')
    }

    planning = app.get<PlanningApplication>(PLANNING_APPLICATION)
    tracking = app.get<TrackingApplication>(TRACKING_APPLICATION)
    reporting = app.get<ReportingApplication>(REPORTING_APPLICATION)
    transaction = app.get<DatabaseTransactionPort>(DATABASE_TRANSACTION_PORT)
    workspaceMembers = app.get<WorkspaceMemberResolver>(
      WORKSPACE_MEMBER_RESOLVER,
    )
    telegramRecipients = app.get<WorkspaceTelegramRecipientResolver>(
      WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER,
    )
    telegramIngress = app.get<TelegramIngressLifecycle>(
      TELEGRAM_INGRESS_LIFECYCLE,
    )
  })

  afterAll(async () => {
    lifecycleState?.beginDrain()
    await Promise.allSettled([
      redisLifecycle?.close(AbortSignal.timeout(2_000)),
      database?.close(AbortSignal.timeout(3_000)),
    ])
    await app?.close().catch(() => undefined)
    await pool?.end().catch(() => undefined)
    globalThis.fetch = realFetch
    await Promise.allSettled([postgres?.stop(), redis?.stop()])
  })

  async function login(input: {
    readonly providerUserId: number
    readonly expectedUserId: string
  }): Promise<BrowserSession> {
    activeProviderUserId = input.providerUserId
    const start = await request(app.getHttpServer())
      .get('/auth/telegram/start')
      .redirects(0)
      .expect(302)
    const authorization = new URL(String(start.headers['location']))
    const state = authorization.searchParams.get('state') ?? ''
    activeNonce = authorization.searchParams.get('nonce') ?? ''
    expect(authorization.searchParams.get('scope')).toBe(
      'openid profile telegram:bot_access',
    )
    expect(authorization.searchParams.has('phone')).toBe(false)
    const stateCookies = start.headers['set-cookie'] as unknown as string[]
    const callback = await request(app.getHttpServer())
      .get('/auth/telegram/callback')
      .query({ state, code: `code-${input.providerUserId}` })
      .set('Cookie', cookiePair(stateCookies[0] ?? ''))
      .redirects(0)
      .expect(303)
    const cookies = callback.headers['set-cookie'] as unknown as string[]
    const sessionCookie = cookies.find((value) =>
      value.startsWith('planner-session='),
    )
    if (sessionCookie === undefined)
      throw new Error('Session cookie is missing')
    const cookie = cookiePair(sessionCookie)
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie)
      .expect(200)
    expect(me.body).toMatchObject({ userId: input.expectedUserId })
    const csrf = await request(app.getHttpServer())
      .get('/auth/csrf')
      .set('Cookie', cookie)
      .expect(200)
    const csrfBody = bodyRecord(csrf.body)
    return {
      cookie,
      csrf: String(csrfBody['csrfToken']),
      userId: input.expectedUserId,
    }
  }

  function post(
    session: BrowserSession,
    path: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', session.csrf)
      .set('Content-Type', 'application/json')
      .send(body)
  }

  async function telegramTick(updates: readonly unknown[]): Promise<void> {
    telegramBatches.push([...updates])
    await (telegramIngress as GetUpdatesRunner).tick(
      0,
      AbortSignal.timeout(10_000),
    )
  }

  function callbackFor(text: string): string {
    const button = [...telegramMessages]
      .reverse()
      .flatMap((message) => message.replyMarkup?.inline_keyboard.flat() ?? [])
      .find((value) => value.text === text)
    if (button === undefined || !('callback_data' in button)) {
      throw new Error(`Telegram button is missing: ${text}`)
    }
    return button.callback_data
  }

  function telegramCallback(data: string, id: string): unknown {
    return {
      update_id: updateId++,
      callback_query: {
        id,
        data,
        from: { id: firstTelegramId },
        message: { chat: { id: firstTelegramId, type: 'private' } },
      },
    }
  }

  it('runs the allowlisted April journey through reclose and a fact-free May copy', async () => {
    const memberA = await login({
      providerUserId: firstTelegramId,
      expectedUserId: firstUserId,
    })
    const memberB = await login({
      providerUserId: secondTelegramId,
      expectedUserId: secondUserId,
    })
    expect(memberA.cookie).not.toBe(memberB.cookie)
    await expect(
      pool.query(
        `SELECT issuer, subject, provider_user_id::text, user_id::text
           FROM telegram_external_identities ORDER BY user_id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          issuer: TELEGRAM_OIDC_ISSUER,
          subject: `e01-subject-${firstTelegramId}`,
          provider_user_id: String(firstTelegramId),
          user_id: firstUserId,
        },
        {
          issuer: TELEGRAM_OIDC_ISSUER,
          subject: `e01-subject-${secondTelegramId}`,
          provider_user_id: String(secondTelegramId),
          user_id: secondUserId,
        },
      ],
    })

    const draft = await post(memberA, '/planning/drafts/from-seed', {
      commandId: randomUUID(),
      targetMonth: '2026-04',
      actorPersona: 'memberA',
    }).expect(201)
    const draftBody = bodyRecord(draft.body)
    const planMonthId = String(draftBody['aggregateId'])
    expect(draftBody).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: '1',
    })
    const editor = await request(app.getHttpServer())
      .get('/planning/drafts')
      .query({ targetMonth: '2026-04' })
      .set('Cookie', memberA.cookie)
      .expect(200)
    const editorBody = bodyRecord(editor.body)
    expect(editorBody).toMatchObject({
      planMonthId,
      focus: 'Показатель 108',
      draftRevision: '1',
      blockers: [],
    })
    expect(editorBody['goals']).toHaveLength(41)

    const preview = await request(app.getHttpServer())
      .get('/planning/drafts/publication-preview')
      .query({ targetMonth: '2026-04' })
      .set('Cookie', memberA.cookie)
      .expect(200)
    const previewBody = bodyRecord(preview.body)
    expect(previewBody['blockers']).toEqual([])
    const published = await post(
      memberA,
      `/planning/drafts/${planMonthId}/publish`,
      {
        commandId: randomUUID(),
        expectedRevision: previewBody['draftRevision'],
        previewSchemaVersion: previewBody['schemaVersion'],
        previewHashVersion: previewBody['previewHashVersion'],
        previewHash: previewBody['previewHash'],
      },
    ).expect(201)
    const publicationId = String(bodyRecord(published.body)['aggregateId'])
    const snapshotResult = await pool.query<SnapshotRow>(
      `SELECT id::text, title
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
        ORDER BY display_order`,
      [publicationId],
    )
    expect(snapshotResult.rows).toHaveLength(41)
    const snapshots = new Map(
      snapshotResult.rows.map((row) => [row.title, row.id]),
    )
    await expect(
      pool.query(
        `SELECT count(*)::text count
           FROM fixed_expectations expectation
           JOIN plan_goal_snapshots snapshot
             ON snapshot.id = expectation.plan_goal_snapshot_id
          WHERE snapshot.publication_id = $1::uuid
            AND expectation.expectation_date < DATE '2026-04-01'`,
        [publicationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] })
    for (const session of [memberA, memberB]) {
      await request(app.getHttpServer())
        .get(`/planning/publications/${publicationId}`)
        .set('Cookie', session.cookie)
        .expect(200)
    }

    clock.set(new Date('2026-04-10T02:50:00.123Z'))
    const webSnapshotId = snapshots.get('Показатель 053')
    const telegramSnapshotId = snapshots.get('Показатель 054')
    if (webSnapshotId === undefined || telegramSnapshotId === undefined) {
      throw new Error('Pilot Boolean snapshots are missing')
    }
    const webFact = await post(memberA, '/tracking/facts', {
      commandId: randomUUID(),
      publicationId,
      planGoalSnapshotId: webSnapshotId,
      localDate: '2026-04-10',
      value: { kind: 'boolean', result: 'done' },
    }).expect(201)
    const webFactId = String(bodyRecord(webFact.body)['aggregateId'])

    await telegramTick([
      {
        update_id: updateId++,
        message: {
          text: 'Сегодня',
          chat: { id: firstTelegramId, type: 'private' },
          from: { id: firstTelegramId },
        },
      },
    ])
    const selectBoolean = callbackFor('✓ Показатель 054')
    await telegramTick([telegramCallback(selectBoolean, 'select-boolean')])
    const confirmBoolean = callbackFor('Подтвердить')
    await telegramTick([
      telegramCallback(confirmBoolean, 'confirm-boolean-a'),
      telegramCallback(confirmBoolean, 'confirm-boolean-b'),
    ])
    await expect(
      pool.query(
        `SELECT count(*)::text count
           FROM tracking_fact_records record
           JOIN tracking_fact_revisions revision
             ON revision.id = record.current_revision_id
          WHERE record.publication_id = $1::uuid
            AND record.plan_goal_snapshot_id = $2::uuid
            AND revision.boolean_result = 'done'`,
        [publicationId, telegramSnapshotId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] })

    clock.set(new Date('2026-04-10T02:55:00.123Z'))
    await post(memberA, '/reminders/settings', {
      commandId: randomUUID(),
      timeZone: 'Asia/Yekaterinburg',
      morning: '08:00',
      day: null,
      evening: null,
    }).expect(201)
    clock.set(new Date('2026-04-10T03:00:00.123Z'))
    const deliveryTransport: ReminderDeliveryTransportPort = {
      send: (input) => {
        reminderDeliveries.push({ chatId: input.chatId, text: input.text })
        return Promise.resolve({ kind: 'accepted' })
      },
    }
    const reminderWorker = createRemindersApplication({
      database,
      transaction,
      workspaceMembers,
      telegramRecipientResolver: telegramRecipients,
      deliveryTransport,
      clock,
      today: {
        getToday: (memberId) =>
          tracking.getToday.execute({
            trustedActor: { kind: 'member', id: memberId },
          }),
      },
    })
    if (reminderWorker.runDueReminders === undefined) {
      throw new Error('Reminder worker composition is incomplete')
    }
    await expect(
      reminderWorker.runDueReminders.execute(new AbortController().signal),
    ).resolves.toMatchObject({ claimed: 1, prepared: 1, delivered: 1 })
    expect(reminderDeliveries).toHaveLength(1)
    expect(reminderDeliveries[0]).toMatchObject({
      chatId: BigInt(firstTelegramId),
    })
    expect(reminderDeliveries[0]!.text).not.toContain(
      'Показатель 053',
    )
    expect(reminderDeliveries[0]!.text).not.toContain(
      'Показатель 054',
    )

    clock.set(new Date('2026-04-10T18:50:00.123Z'))
    const closePath = `/tracking/publications/${publicationId}/days/2026-04-10`
    const closePreview = await request(app.getHttpServer())
      .get(`${closePath}/close-preview`)
      .set('Cookie', memberA.cookie)
      .expect(200)
    const closePreviewBody = bodyRecord(closePreview.body)
    expect(closePreviewBody).toMatchObject({ state: 'ready' })
    expect(closePreviewBody['unresolved']).not.toEqual([])
    await post(memberA, `${closePath}/close`, {
      commandId: randomUUID(),
      expectedRevision: closePreviewBody['factsRevision'],
      previewSchemaVersion: closePreviewBody['schemaVersion'],
      previewHashVersion: closePreviewBody['previewHashVersion'],
      previewHash: closePreviewBody['previewHash'],
    }).expect(201)

    const weeklyPeriod = await pool.query<{ readonly id: string }>(
      `SELECT period.id::text
         FROM flexible_periods period
         JOIN plan_goal_snapshots snapshot
           ON snapshot.id = period.plan_goal_snapshot_id
        WHERE period.publication_id = $1::uuid
          AND period.period_kind = 'weekly_planned_task'
          AND period.period_start <= DATE '2026-04-10'
          AND period.period_end >= DATE '2026-04-10'
        ORDER BY snapshot.display_order
        LIMIT 1`,
      [publicationId],
    )
    const weeklyPeriodId = weeklyPeriod.rows[0]?.id
    if (weeklyPeriodId === undefined) throw new Error('Weekly task is missing')
    await post(
      memberB,
      `/tracking/publications/${publicationId}/weekly-tasks/${weeklyPeriodId}/result`,
      { commandId: randomUUID(), result: 'done' },
    ).expect(201)

    const lifecycleWorker = createPlanningLifecycleWorker({
      database,
      transaction,
      clock,
      closeMonthReport: reporting.buildCloseMonthReport,
    })
    clock.set(new Date('2026-04-30T19:00:00.123Z'))
    await lifecycleWorker.tick()
    await expect(
      pool.query(
        `SELECT status, revision::text, lifecycle_mode
           FROM plan_months WHERE id = $1::uuid`,
        [planMonthId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'grace', revision: '3', lifecycle_mode: 'ordinary' }],
    })
    await expect(
      pool.query(
        `SELECT
           count(*) FILTER (WHERE revision.recorded_by_member_id IS NOT NULL
                             AND revision.boolean_result = 'done')::text member_done,
           count(*) FILTER (WHERE revision.recorded_by_system_actor_id = 'planner-worker'
                             AND revision.boolean_result = 'not_done')::text system_not_done
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
        WHERE record.publication_id = $1::uuid
          AND record.fact_kind = 'weekly_task_result'`,
        [publicationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ member_done: '1', system_not_done: '4' }],
    })

    const preliminaryBefore = await request(app.getHttpServer())
      .get('/reporting/months/2026-04')
      .set('Cookie', memberA.cookie)
      .expect(200)
    const preliminaryBeforeBody = bodyRecord(preliminaryBefore.body)
    expect(preliminaryBeforeBody['status']).toBe('preliminary')
    const graceCorrection = await post(
      memberA,
      `/tracking/facts/${webFactId}/correct`,
      {
        commandId: randomUUID(),
        expectedRevision: '1',
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'Сверили результат во время grace.',
      },
    ).expect(200)
    expect(bodyRecord(graceCorrection.body)['aggregateRevision']).toBe('2')
    const preliminaryAfter = await request(app.getHttpServer())
      .get('/reporting/months/2026-04')
      .set('Cookie', memberA.cookie)
      .expect(200)
    expect(preliminaryAfter.body).not.toEqual(preliminaryBefore.body)

    clock.set(new Date('2026-05-03T19:00:00.123Z'))
    await lifecycleWorker.tick()
    await expect(
      pool.query(
        `SELECT status, revision::text FROM plan_months WHERE id = $1::uuid`,
        [planMonthId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'closed', revision: '4' }],
    })
    await post(memberA, `/tracking/facts/${webFactId}/correct`, {
      commandId: randomUUID(),
      expectedRevision: '2',
      value: { kind: 'boolean', result: 'done' },
      reason: 'Закрытый месяц не должен принять исправление.',
    }).expect(409)

    const reopened = await post(
      memberA,
      `/planning/months/${planMonthId}/reopen`,
      {
        commandId: randomUUID(),
        expectedRevision: '4',
        reason: 'Повторно сверили апрельские записи.',
      },
    ).expect(200)
    expect(bodyRecord(reopened.body)['aggregateRevision']).toBe('5')
    const reopenedCorrection = await post(
      memberA,
      `/tracking/facts/${webFactId}/correct`,
      {
        commandId: randomUUID(),
        expectedRevision: '2',
        value: { kind: 'boolean', result: 'done' },
        reason: 'Исправили запись после подтверждённого reopen.',
      },
    ).expect(200)
    expect(bodyRecord(reopenedCorrection.body)['aggregateRevision']).toBe('3')
    const reclosed = await post(
      memberA,
      `/planning/months/${planMonthId}/reclose`,
      { commandId: randomUUID(), expectedRevision: '5' },
    ).expect(200)
    expect(bodyRecord(reclosed.body)).toMatchObject({
      kind: 'planning.report-revision.v1',
      aggregateRevision: '2',
    })
    await expect(
      pool.query(
        `SELECT revision::text, status, source_facts_revision::text,
                created_by_member_id::text, created_by_system_actor_id
           FROM report_revisions
          WHERE plan_month_id = $1::uuid
          ORDER BY revision`,
        [planMonthId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          revision: '1',
          status: 'original',
          created_by_member_id: null,
          created_by_system_actor_id: 'planner-worker',
        },
        {
          revision: '2',
          status: 'revised',
          created_by_member_id: firstMemberId,
          created_by_system_actor_id: null,
        },
      ],
    })
    const finalReport = await request(app.getHttpServer())
      .get('/reporting/months/2026-04')
      .set('Cookie', memberB.cookie)
      .expect(200)
    expect(bodyRecord(finalReport.body)).toMatchObject({
      status: 'revised',
    })

    const may = await planning.createDraftFromPublication.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: secondMemberId },
      payload: { sourcePublicationId: publicationId, targetMonth: '2026-05' },
    })
    const mayEditor = await planning.getDraftEditor.execute({
      trustedActor: { kind: 'member', id: firstMemberId },
      targetMonth: '2026-05',
    })
    if (mayEditor === null) throw new Error('Copied May draft is missing')
    expect(mayEditor).toMatchObject({
      planMonthId: may.aggregateId,
      focus: 'Показатель 108',
      draftRevision: 1n,
    })
    expect(mayEditor.goals).toHaveLength(41)
    expect(
      mayEditor.goals.filter(
        (goal) => goal.config.repetition.kind === 'weekly_planned_task',
      ),
    ).toHaveLength(5)
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::text FROM tracking_fact_records
             WHERE plan_month_id = $1::uuid) facts,
           (SELECT count(*)::text FROM report_revisions
             WHERE plan_month_id = $1::uuid) reports,
           (SELECT count(*)::text FROM plan_publications
             WHERE plan_month_id = $1::uuid) publications,
           (SELECT status FROM plan_months WHERE id = $1::uuid) status`,
        [may.aggregateId],
      ),
    ).resolves.toMatchObject({
      rows: [{ facts: '0', reports: '0', publications: '0', status: 'draft' }],
    })
    await expect(
      pool.query(
        `SELECT status, lifecycle_mode, revision::text
           FROM plan_months WHERE id = $1::uuid`,
        [planMonthId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'closed', lifecycle_mode: 'reopened', revision: '6' }],
    })
    expect(spaceId).toMatch(/^[0-9a-f-]{36}$/u)
  })
})
