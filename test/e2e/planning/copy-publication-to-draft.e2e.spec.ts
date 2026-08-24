import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'

import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool, type QueryResult } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { ApiModule } from '@/bootstrap/api/api.module'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
import {
  createPlanningApplication,
  createPlanningLifecycleWorker,
  type PlanningApplication,
} from '@/modules/planning'
import { createRemindersApplication } from '@/modules/reminders'
import { createReportingApplication } from '@/modules/reporting'
import { createTrackingApplication } from '@/modules/tracking'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import {
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace/application/workspace-member-resolver.port'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import type { DatabaseLifecycle } from '@/platform/database/database.contracts'
import { DATABASE_LIFECYCLE } from '@/platform/database/database.tokens'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import type { RedisLifecyclePort } from '@/platform/redis/redis-lifecycle'
import { REDIS_LIFECYCLE } from '@/platform/redis/redis.tokens'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { RequestContext } from '@/platform/http/context/request-context'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'
import { createApiRuntimeConfig } from '@/platform/config/runtime-environment'
import {
  TELEGRAM_INGRESS_LIFECYCLE,
  type TelegramIngressLifecycle,
} from '@/modules/telegram-bot'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const foreignUserId = '66666666-6666-4666-8666-666666666666'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const foreignSpaceId = '77777777-7777-4777-8777-777777777777'
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

function withoutRequestMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => key !== 'instance' && key !== 'requestId',
    ),
  )
}

type ForeignResolverHarness = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

async function createForeignResolverHarness(
  foreignSpaceId: string,
): Promise<ForeignResolverHarness> {
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
  const config = {
    ...baseConfig,
    http: { ...baseConfig.http, port },
  }
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
  const redis = app.get<RedisLifecyclePort>(REDIS_LIFECYCLE)
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
    redis.connect(AbortSignal.timeout(3_000)),
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
      await Promise.allSettled([database.close(signal), redis.close(signal)])
      await app.close()
    },
  }
}

describe('F04 authenticated HTTP copies immutable publications to drafts', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let sourcePlanning: PlanningApplication
  let sourceClock: FakeProductClock
  let baseUrl: string
  let origin: string
  let firstCookie: string
  let firstCsrf: string
  let secondCookie: string
  let secondCsrf: string
  let sourcePublicationId: string
  let sourcePlanMonthId: string
  let sourceDailySnapshotId: string
  let sourceChecklistItemId: string
  let sourceCheckpointId: string
  let sourceWeeklyPeriodId: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f04_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'), ('${secondUserId}'), ('${foreignUserId}');
      INSERT INTO spaces (id, singleton_key) VALUES
        ('${spaceId}', 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}', '${spaceId}', '${userId}', 1),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2);
    `)

    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 8,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 1_000,
        transactionMaxWaitMs: 2_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(3_000))
    sourcePlanning = createPlanningApplication({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: (sourceClock = new FakeProductClock(
        new Date('2035-03-30T18:00:00.000Z'),
      )),
    })
    const source = await publishSource(sourcePlanning, memberId, '2035-04')
    sourcePublicationId = source.publicationId
    sourcePlanMonthId = source.planMonthId
    sourceDailySnapshotId = source.dailySnapshotId
    sourceChecklistItemId = source.checklistItemId
    sourceCheckpointId = source.checkpointId
    sourceWeeklyPeriodId = source.weeklyPeriodId

    const tracking = createTrackingApplication({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: sourceClock,
    })
    sourceClock.set(new Date('2035-04-01T08:00:00.000Z'))
    await tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: memberId },
      payload: {
        publicationId: sourcePublicationId,
        flexiblePeriodId: sourceWeeklyPeriodId,
        result: 'done',
      },
    })
    sourceClock.set(new Date('2035-04-10T02:00:00.000Z'))
    await tracking.recordChecklistItem.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: memberId },
      payload: {
        publicationId: sourcePublicationId,
        planGoalSnapshotId: sourceDailySnapshotId,
        expectationDate: '2035-04-10',
        checkpointId: sourceCheckpointId,
        checklistItemId: sourceChecklistItemId,
        state: 'not_done',
      },
    })
    const reminders = createRemindersApplication({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: sourceClock,
      today: {
        getToday: (resolvedMemberId) =>
          tracking.getToday.execute({
            trustedActor: { kind: 'member', id: resolvedMemberId },
          }),
      },
    })
    await reminders.saveReminderSchedule.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: memberId },
      payload: {
        timeZone: 'Asia/Yekaterinburg',
        morning: '08:00',
        day: '13:00',
        evening: null,
      },
    })
    sourceClock.set(new Date('2035-04-10T03:00:00.000Z'))
    const reminderLeaseOwner = 'f04-source-fixture'
    const claims = await reminders.claimDueOccurrences.execute({
      leaseOwner: reminderLeaseOwner,
      limit: 10,
      leaseDurationMs: 60_000,
    })
    const sourceClaim = claims.find(
      (claim) =>
        claim.localDate === '2035-04-10' && claim.slotKind === 'morning',
    )
    if (sourceClaim === undefined)
      throw new Error('source reminder claim missing')
    const sourceIntent = await reminders.buildReminderIntent.execute({
      claim: sourceClaim,
      leaseOwner: reminderLeaseOwner,
    })
    if (sourceIntent.kind !== 'prepared')
      throw new Error('source reminder intent suppressed')
    expect(sourceIntent.contentHash).toMatch(/^[0-9a-f]{64}$/u)

    const reporting = createReportingApplication({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: sourceClock,
    })
    sourceClock.set(new Date('2035-05-01T00:00:00.000Z'))
    const lifecycle = createPlanningLifecycleWorker({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      clock: sourceClock,
      closeMonthReport: reporting.buildCloseMonthReport,
    })
    await lifecycle.tick()
    sourceClock.set(new Date('2035-05-04T00:00:00.000Z'))
    await lifecycle.tick()

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
    const [first, second] = await Promise.all([
      issue.execute(userId, Date.now()),
      issue.execute(secondUserId, Date.now()),
    ])
    firstCookie = `planner-session=${first.rawToken}`
    firstCsrf = first.csrfToken
    secondCookie = `planner-session=${second.rawToken}`
    secondCsrf = second.csrfToken

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
      TELEGRAM_OIDC_CLIENT_SECRET: 'f04-e2e-secret-long',
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

  async function publishSource(
    application: PlanningApplication,
    actorMemberId: string,
    targetMonth: string,
  ): Promise<{
    readonly publicationId: string
    readonly planMonthId: string
    readonly dailySnapshotId: string
    readonly checklistItemId: string
    readonly checkpointId: string
    readonly weeklySnapshotId: string
    readonly weeklyPeriodId: string
  }> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      payload: { targetMonth, focus: '  Published source focus  ' },
    })
    const dailyDefinition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      payload: {
        title: 'Source daily goal',
        why: 'Copy configuration and provenance',
        category: 'F04',
      },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: dailyDefinition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'checklist',
            items: [{ itemId: null, label: 'Source checklist child' }],
          },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Source checkpoint child',
                deadline: '12:00',
                satisfaction: { kind: 'checklist' },
              },
              {
                checkpointId: null,
                name: 'Source reminder checkpoint',
                deadline: '18:00',
                satisfaction: { kind: 'checklist' },
              },
            ],
          },
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'F04-fixture',
          sourcePage: 14,
          rawValue: 'daily-source-value',
          rawDenominator: null,
          resolution: 'daily copied exactly',
        },
      },
    })
    const weeklyDefinition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      payload: {
        title: 'Source weekly task',
        why: 'Copy ordered task configuration',
        category: 'F04',
      },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      expectedRevision: 2n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: weeklyDefinition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '1',
            taskText: 'Keep source order',
          },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'F04-fixture',
          sourcePage: 4,
          rawValue: 'weekly-source-value',
          rawDenominator: null,
          resolution: 'weekly copied exactly',
        },
      },
    })
    const draftGoalRows = await admin.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_draft_goals
        WHERE plan_month_id = $1::uuid AND detached_at IS NULL
        ORDER BY display_order`,
      [draft.aggregateId],
    )
    if (draftGoalRows.rows.length !== 2) throw new Error('source goals missing')
    await application.reorderDraftGoals.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      expectedRevision: 3n,
      payload: {
        planMonthId: draft.aggregateId,
        orderedPlanGoalIds: [
          draftGoalRows.rows[1]!.id,
          draftGoalRows.rows[0]!.id,
        ],
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: userId,
      targetMonth,
    })
    if (preview === null) throw new Error('source preview missing')
    const publication = await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: actorMemberId },
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const rows = await admin.query<{
      readonly plan_month_id: string
      readonly daily_snapshot_id: string
      readonly checklist_item_id: string
      readonly checkpoint_id: string
      readonly weekly_snapshot_id: string
      readonly weekly_period_id: string
    }>(
      `SELECT publication.plan_month_id::text,
              (SELECT id::text FROM plan_goal_snapshots
                WHERE publication_id = publication.id
                  AND config->'repetition'->>'kind' = 'daily') daily_snapshot_id,
              (SELECT config #>> '{measurement,items,0,itemId}'
                 FROM plan_goal_snapshots
                WHERE publication_id = publication.id
                  AND config #>> '{repetition,kind}' = 'daily') checklist_item_id,
              (SELECT config #>> '{checkpoints,items,0,checkpointId}'
                 FROM plan_goal_snapshots
                WHERE publication_id = publication.id
                  AND config #>> '{repetition,kind}' = 'daily') checkpoint_id,
              (SELECT id::text FROM plan_goal_snapshots
                WHERE publication_id = publication.id
                  AND config->'repetition'->>'kind' = 'weekly_planned_task') weekly_snapshot_id,
              (SELECT period.id::text FROM flexible_periods period
               WHERE period.publication_id = publication.id
                 AND period.period_kind = 'weekly_planned_task'
               ORDER BY period.period_start LIMIT 1) weekly_period_id
         FROM plan_publications publication
        WHERE publication.id = $1::uuid`,
      [publication.aggregateId],
    )
    const row = rows.rows[0]
    if (
      row === undefined ||
      row.daily_snapshot_id === null ||
      row.checklist_item_id === null ||
      row.checkpoint_id === null ||
      row.weekly_snapshot_id === null ||
      row.weekly_period_id === null
    ) {
      throw new Error('source snapshots missing')
    }
    return {
      publicationId: publication.aggregateId,
      planMonthId: row.plan_month_id,
      dailySnapshotId: row.daily_snapshot_id,
      checklistItemId: row.checklist_item_id,
      checkpointId: row.checkpoint_id,
      weeklySnapshotId: row.weekly_snapshot_id,
      weeklyPeriodId: row.weekly_period_id,
    }
  }

  async function postTo(
    requestBaseUrl: string,
    value: object,
    cookie = firstCookie,
    csrfToken = firstCsrf,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${requestBaseUrl}/planning/drafts/from-publication`, {
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

  async function post(
    value: object,
    cookie = firstCookie,
    csrfToken = firstCsrf,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return postTo(baseUrl, value, cookie, csrfToken, headers)
  }

  async function countForMonth(
    targetMonth: string,
  ): Promise<Record<string, string>> {
    const result = await admin.query<Record<string, string>>(
      `SELECT
        (SELECT id::text FROM plan_months WHERE space_id = $1::uuid AND month_start = $2::date) plan_month_id`,
      [spaceId, `${targetMonth}-01`],
    )
    const planMonthId = result.rows[0]?.plan_month_id
    if (planMonthId === undefined) {
      return {
        publications: '0',
        goals: '0',
        facts: '0',
        results: '0',
        reports: '0',
        reminders: '0',
      }
    }
    const counts = await admin.query<Record<string, string>>(
      `SELECT
        (SELECT count(*)::text FROM plan_publications WHERE plan_month_id = $1::uuid) publications,
        (SELECT count(*)::text FROM plan_draft_goals WHERE plan_month_id = $1::uuid) goals,
        (SELECT count(*)::text FROM tracking_fact_records WHERE plan_month_id = $1::uuid) facts,
        (SELECT count(*)::text FROM tracking_fact_records fact
          JOIN flexible_periods period ON period.id = fact.flexible_period_id
         WHERE fact.plan_month_id = $1::uuid
           AND period.period_kind = 'weekly_planned_task') results,
        (SELECT count(*)::text FROM report_revisions WHERE plan_month_id = $1::uuid) reports,
        (SELECT count(*)::text FROM notification_intents intent
          JOIN plan_publications publication ON publication.id = intent.publication_id
         WHERE publication.plan_month_id = $1::uuid) reminders`,
      [planMonthId],
    )
    return counts.rows[0]!
  }

  async function copyMutationDigest(
    targetMonth: string,
    commandId: string,
    relevantSpaceIds: readonly string[],
  ): Promise<string> {
    const result = await admin.query<{ readonly digest: string }>(
      `SELECT jsonb_build_object(
        'planMonths', COALESCE((SELECT jsonb_agg(to_jsonb(month) ORDER BY month.id)
          FROM plan_months month
         WHERE month.space_id = ANY($2::uuid[])
           AND month.month_start = $1::date), '[]'::jsonb),
        'drafts', COALESCE((SELECT jsonb_agg(to_jsonb(draft) ORDER BY draft.plan_month_id)
          FROM plan_drafts draft
          JOIN plan_months month ON month.id = draft.plan_month_id
         WHERE month.space_id = ANY($2::uuid[])
           AND month.month_start = $1::date), '[]'::jsonb),
        'actions', COALESCE((SELECT jsonb_agg(to_jsonb(action) ORDER BY action.id)
          FROM planning_action_groups action
          LEFT JOIN plan_months month ON month.id = action.plan_month_id
         WHERE action.command_id = $3::uuid
           AND (month.space_id = ANY($2::uuid[]) OR month.id IS NULL)), '[]'::jsonb),
        'copyChanges', COALESCE((SELECT jsonb_agg(to_jsonb(change) ORDER BY change.action_id)
          FROM planning_month_copy_changes change
          JOIN planning_action_groups action ON action.id = change.action_id
          LEFT JOIN plan_months month ON month.id = action.plan_month_id
         WHERE action.command_id = $3::uuid
           AND (month.space_id = ANY($2::uuid[]) OR month.id IS NULL)), '[]'::jsonb),
        'commandReceipts', COALESCE((SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.command_id)
          FROM command_receipts receipt
         WHERE receipt.command_id = $3::uuid), '[]'::jsonb)
      )::text AS digest`,
      [`${targetMonth}-01`, [...relevantSpaceIds], commandId],
    )
    return result.rows[0]?.digest ?? ''
  }

  it('documents exact request/security/success and finite Problems in OpenAPI', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
    }
    const operation = document.paths['/planning/drafts/from-publication']
      ?.post as {
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
      required: ['commandId', 'sourcePublicationId', 'targetMonth'],
    })
    expect(operation.responses).toHaveProperty('201')
    expect(operation.responses).toHaveProperty('404')
    expect(operation.responses).toHaveProperty('409')
    expect(JSON.stringify(operation.responses)).toContain(
      'PLAN_PUBLICATION_NOT_FOUND',
    )
    expect(JSON.stringify(operation.responses)).toContain(
      'COMMAND_FINGERPRINT_CONFLICT',
    )
    expect(JSON.stringify(operation.responses)).toContain('open-existing-month')
  })

  it('requires session and CSRF, rejects forged fields, and conceals missing/foreign sources', async () => {
    const value = {
      commandId: randomUUID(),
      sourcePublicationId,
      targetMonth: '2035-05',
    }
    expect((await post(value, '')).status).toBe(401)
    expect((await post(value, firstCookie, 'wrong')).status).toBe(403)
    for (const invalid of [
      { ...value, actor: memberId },
      { ...value, spaceId },
      { ...value, expectedRevision: '1' },
      { ...value, sourcePublicationId: 'not-a-uuid' },
      { ...value, targetMonth: '2035-5' },
    ]) {
      const response = await post(invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    const missingCommandId = randomUUID()
    const missingBefore = await copyMutationDigest(
      '2035-05',
      missingCommandId,
      [spaceId],
    )
    const missing = await post({
      ...value,
      commandId: missingCommandId,
      sourcePublicationId: randomUUID(),
    })
    const missingAfter = await copyMutationDigest('2035-05', missingCommandId, [
      spaceId,
    ])
    expect(missingAfter).toBe(missingBefore)
    const foreignCommandId = randomUUID()
    const foreignHarness = await createForeignResolverHarness(foreignSpaceId)
    try {
      const foreignBefore = await copyMutationDigest(
        '2035-05',
        foreignCommandId,
        [spaceId, foreignSpaceId],
      )
      const foreign = await postTo(foreignHarness.baseUrl, {
        ...value,
        commandId: foreignCommandId,
        sourcePublicationId,
      })
      expect(missing.status).toBe(404)
      expect(foreign.status).toBe(404)
      const missingBody = await json(missing)
      const foreignBody = await json(foreign)
      expect(missingBody).toMatchObject({ code: 'PLAN_PUBLICATION_NOT_FOUND' })
      expect(withoutRequestMetadata(foreignBody)).toEqual(
        withoutRequestMetadata(missingBody),
      )
      expect(JSON.stringify(foreignBody)).not.toMatch(
        /spaceId|userId|foreignPublicationId/u,
      )
      const foreignAfter = await copyMutationDigest(
        '2035-05',
        foreignCommandId,
        [spaceId, foreignSpaceId],
      )
      expect(foreignAfter).toBe(foreignBefore)
    } finally {
      await foreignHarness.close()
    }
  })

  it('copies source config/order/provenance through the second member actor without destination state', async () => {
    const sourceState = (): Promise<QueryResult<{ readonly state: string }>> =>
      admin.query<{ readonly state: string }>(
        `SELECT jsonb_build_object(
          'month', (SELECT to_jsonb(month) FROM plan_months month WHERE month.id = $2::uuid),
          'draft', (SELECT to_jsonb(draft) FROM plan_drafts draft WHERE draft.plan_month_id = $2::uuid),
          'publication', (SELECT to_jsonb(publication) FROM plan_publications publication WHERE publication.id = $1::uuid),
          'snapshots', COALESCE((SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.display_order, snapshot.id)
              FROM plan_goal_snapshots snapshot WHERE snapshot.publication_id = $1::uuid), '[]'::jsonb),
          'fixedExpectations', COALESCE((SELECT jsonb_agg(to_jsonb(expectation) ORDER BY expectation.id)
              FROM fixed_expectations expectation WHERE expectation.publication_id = $1::uuid), '[]'::jsonb),
          'flexiblePeriods', COALESCE((SELECT jsonb_agg(to_jsonb(period) ORDER BY period.period_start, period.id)
              FROM flexible_periods period WHERE period.publication_id = $1::uuid), '[]'::jsonb),
          'facts', COALESCE((SELECT jsonb_agg(to_jsonb(fact) ORDER BY fact.id)
              FROM tracking_fact_records fact WHERE fact.publication_id = $1::uuid), '[]'::jsonb),
          'factRevisions', COALESCE((SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision.id)
              FROM tracking_fact_revisions revision
              JOIN tracking_fact_records fact ON fact.id = revision.fact_record_id
             WHERE fact.publication_id = $1::uuid), '[]'::jsonb),
          'reports', COALESCE((SELECT jsonb_agg(to_jsonb(report) ORDER BY report.revision)
              FROM report_revisions report WHERE report.publication_id = $1::uuid), '[]'::jsonb),
          'notificationIntents', COALESCE((SELECT jsonb_agg(to_jsonb(intent) ORDER BY intent.id)
              FROM notification_intents intent WHERE intent.publication_id = $1::uuid), '[]'::jsonb),
          'reminderOccurrences', COALESCE((SELECT jsonb_agg(to_jsonb(occurrence) ORDER BY occurrence.id)
              FROM reminder_occurrences occurrence WHERE occurrence.recipient_member_id = $3::uuid), '[]'::jsonb),
          'reminderSchedules', COALESCE((SELECT jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id)
              FROM reminder_schedules schedule WHERE schedule.member_id = $3::uuid), '[]'::jsonb),
          'counts', jsonb_build_object(
            'facts', (SELECT count(*) FROM tracking_fact_records fact WHERE fact.publication_id = $1::uuid),
            'results', (SELECT count(*) FROM tracking_fact_records fact
              JOIN flexible_periods period ON period.id = fact.flexible_period_id
             WHERE fact.publication_id = $1::uuid
               AND period.period_kind = 'weekly_planned_task'),
            'reports', (SELECT count(*) FROM report_revisions report WHERE report.publication_id = $1::uuid),
            'notificationIntents', (SELECT count(*) FROM notification_intents intent WHERE intent.publication_id = $1::uuid)
          )
        )::text AS state`,
        [sourcePublicationId, sourcePlanMonthId, memberId],
      )
    const sourcePreconditions = await admin.query<{
      readonly facts: string
      readonly weekly_results: string
      readonly reports: string
      readonly reminder_schedules: string
      readonly reminder_occurrences: string
      readonly notification_intents: string
    }>(
      `SELECT
        (SELECT count(*)::text FROM tracking_fact_records fact
          WHERE fact.publication_id = $1::uuid) facts,
        (SELECT count(*)::text FROM tracking_fact_records fact
          JOIN flexible_periods period ON period.id = fact.flexible_period_id
         WHERE fact.publication_id = $1::uuid
           AND period.period_kind = 'weekly_planned_task') weekly_results,
        (SELECT count(*)::text FROM report_revisions report
          WHERE report.publication_id = $1::uuid) reports,
        (SELECT count(*)::text FROM reminder_schedules schedule
          WHERE schedule.member_id = $2::uuid) reminder_schedules,
        (SELECT count(*)::text FROM reminder_occurrences occurrence
          WHERE occurrence.recipient_member_id = $2::uuid
            AND occurrence.local_date = '2035-04-10'::date) reminder_occurrences,
        (SELECT count(*)::text FROM notification_intents intent
          WHERE intent.publication_id = $1::uuid) notification_intents`,
      [sourcePublicationId, memberId],
    )
    const sourcePreconditionRow = sourcePreconditions.rows[0]
    if (sourcePreconditionRow === undefined)
      throw new Error('source preconditions missing')
    for (const count of Object.values(sourcePreconditionRow)) {
      expect(Number(count)).toBeGreaterThan(0)
    }
    const before = await sourceState()
    const response = await post(
      { commandId: randomUUID(), sourcePublicationId, targetMonth: '2035-05' },
      secondCookie,
      secondCsrf,
    )
    expect(response.status).toBe(201)
    const body = await json(response)
    expect(body).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: '1',
    })

    const editor = await fetch(
      `${baseUrl}/planning/drafts?targetMonth=2035-05`,
      {
        headers: { cookie: secondCookie },
      },
    )
    expect(editor.status).toBe(200)
    const editorBody = await json(editor)
    if (!Array.isArray(editorBody.goals))
      throw new Error('destination goals missing')
    const editorGoals = editorBody.goals as readonly unknown[]
    expect(editorBody).toMatchObject({
      targetMonth: '2035-05',
      focus: '  Published source focus  ',
      draftRevision: '1',
    })
    expect(
      editorGoals.map((goal) =>
        typeof goal === 'object' && goal !== null && 'displayOrder' in goal
          ? goal.displayOrder
          : null,
      ),
    ).toEqual([0, 1])
    const sourceRows = await admin.query<{
      readonly display_order: number
      readonly source_plan_goal_id: string
      readonly source_draft_goal_revision_id: string
      readonly goal_definition_id: string
      readonly goal_definition_version_id: string
      readonly goal_series_id: string
      readonly config: unknown
      readonly source_provenance: unknown
    }>(
      `SELECT display_order, source_plan_goal_id::text,
              source_draft_goal_revision_id::text,
              goal_definition_id::text,
              goal_definition_version_id::text, goal_series_id::text,
              config, source_provenance
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
        ORDER BY display_order`,
      [sourcePublicationId],
    )
    const destinationRows = await admin.query<{
      readonly root_id: string
      readonly revision_id: string
      readonly display_order: number
      readonly goal_definition_id: string
      readonly goal_definition_version_id: string
      readonly goal_series_id: string
      readonly config: unknown
      readonly source_provenance: unknown
    }>(
      `SELECT root.id::text root_id, revision.id::text revision_id,
              root.display_order, root.goal_definition_id::text,
              revision.goal_definition_version_id::text,
              revision.goal_series_id::text, revision.config,
              revision.source_provenance
         FROM plan_draft_goals root
         JOIN plan_draft_goal_revisions revision ON revision.id = root.current_revision_id
        WHERE root.plan_month_id = (SELECT id FROM plan_months WHERE space_id = $1::uuid AND month_start = '2035-05-01'::date)
        ORDER BY root.display_order`,
      [spaceId],
    )
    expect(destinationRows.rows).toHaveLength(2)
    expect(sourceChecklistItemId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    const sourceChecklistGoal = sourceRows.rows.find(({ config }) =>
      JSON.stringify(config).includes(sourceChecklistItemId),
    )
    if (sourceChecklistGoal === undefined)
      throw new Error('source generated checklist ID missing')
    expect(
      JSON.stringify(destinationRows.rows.map(({ config }) => config)),
    ).toContain(sourceChecklistItemId)
    const sourceRootIds = new Set(
      sourceRows.rows.map(({ source_plan_goal_id }) => source_plan_goal_id),
    )
    const sourceRevisionIds = new Set(
      sourceRows.rows.map(
        ({ source_draft_goal_revision_id }) => source_draft_goal_revision_id,
      ),
    )
    const destinationRootIds = new Set(
      destinationRows.rows.map(({ root_id }) => root_id),
    )
    const destinationRevisionIds = new Set(
      destinationRows.rows.map(({ revision_id }) => revision_id),
    )
    const sourceIdentityIds = new Set([...sourceRootIds, ...sourceRevisionIds])
    expect(sourceRootIds.size).toBe(2)
    expect(sourceRevisionIds.size).toBe(2)
    expect(sourceIdentityIds.size).toBe(4)
    expect(
      [...destinationRootIds].filter((id) => sourceIdentityIds.has(id)),
    ).toEqual([])
    expect(
      [...destinationRevisionIds].filter((id) => sourceIdentityIds.has(id)),
    ).toEqual([])
    expect(
      [...destinationRootIds].filter((id) => destinationRevisionIds.has(id)),
    ).toEqual([])
    expect(
      destinationRows.rows.map(({ display_order, ...row }) => ({
        display_order,
        goal_definition_id: row.goal_definition_id,
        goal_definition_version_id: row.goal_definition_version_id,
        goal_series_id: row.goal_series_id,
        config: row.config,
        source_provenance: row.source_provenance,
      })),
    ).toEqual(
      sourceRows.rows.map((row) => ({
        display_order: row.display_order,
        goal_definition_id: row.goal_definition_id,
        goal_definition_version_id: row.goal_definition_version_id,
        goal_series_id: row.goal_series_id,
        config: row.config,
        source_provenance: row.source_provenance,
      })),
    )
    expect(
      destinationRows.rows.every(
        ({ root_id, revision_id }) =>
          root_id.length > 0 && revision_id.length > 0,
      ),
    ).toBe(true)
    expect(destinationRootIds.size).toBe(2)
    expect(destinationRevisionIds.size).toBe(2)
    const action = await admin.query<{ member_id: string }>(
      `SELECT member_id::text FROM planning_action_groups WHERE action_kind = 'draft_copied' ORDER BY occurred_at DESC LIMIT 1`,
    )
    expect(action.rows[0]?.member_id).toBe(secondMemberId)
    expect(await countForMonth('2035-05')).toEqual({
      publications: '0',
      goals: '2',
      facts: '0',
      results: '0',
      reports: '0',
      reminders: '0',
    })
    const after = await sourceState()
    expect(after.rows).toEqual(before.rows)
  })

  it('replays exactly, rejects fingerprint changes, safely reports an existing target, and serializes concurrency', async () => {
    const commandId = randomUUID()
    const request = { commandId, sourcePublicationId, targetMonth: '2035-06' }
    const first = await post(request)
    expect(first.status).toBe(201)
    const firstBody = await json(first)
    const replay = await post(request)
    expect(replay.status).toBe(201)
    expect(await json(replay)).toEqual(firstBody)
    const fingerprint = await post({ ...request, targetMonth: '2035-07' })
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })

    const competingTarget = { sourcePublicationId, targetMonth: '2035-08' }
    const [left, right] = await Promise.all([
      post({ ...competingTarget, commandId: randomUUID() }),
      post(
        { ...competingTarget, commandId: randomUUID() },
        secondCookie,
        secondCsrf,
      ),
    ])
    expect([left.status, right.status].sort()).toEqual([201, 409])
    const conflict = left.status === 409 ? left : right
    const conflictBody = await json(conflict)
    expect(conflictBody).toMatchObject({
      code: 'PLAN_MONTH_ALREADY_EXISTS',
      conflict: { nextAction: 'open-existing-month' },
    })
    expect(JSON.stringify(conflictBody)).not.toMatch(
      /spaceId|userId|sourcePublicationId/u,
    )
    const existing = await post({ ...competingTarget, commandId: randomUUID() })
    expect(existing.status).toBe(409)
    expect(await json(existing)).toMatchObject({
      code: 'PLAN_MONTH_ALREADY_EXISTS',
    })
  })
})
