import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'
import OpenAPIResponseValidator from 'openapi-response-validator'

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
import {
  resumeRedis,
  suspendRedis,
} from '@test/integration/support/redis-outage'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const outsiderUserId = 'aaaaaaaa-1111-4111-8111-111111111111'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const planMonthId = '66666666-6666-4666-8666-666666666666'
const blockedPlanMonthId = '77777777-7777-4777-8777-777777777777'
const scheduledPlanMonthId = '88888888-8888-4888-8888-888888888888'
const foreignSpaceId = '99999999-9999-4999-8999-999999999991'
const foreignMemberId = '99999999-9999-4999-8999-999999999992'
const foreignPlanMonthId = '99999999-9999-4999-8999-999999999993'
const reopenPlanMonthId = '99999999-9999-4999-8999-999999999994'
const sessionKeySecret = Buffer.alloc(32, 71)
const csrfSecret = Buffer.alloc(32, 72)

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

function monthAtOffset(offset: number): string {
  const [year, month] = currentMonth().split('-').map(Number)
  const value = new Date(Date.UTC(year!, month! - 1 + offset, 1))
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`
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

describe('P07 authenticated atomic publication HTTP', () => {
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
  let cookie: string
  let secondCookie: string
  let outsiderCookie: string
  let csrfToken: string
  let outsiderCsrfToken: string
  let publishedPublicationId: string
  let redisSuspended = false
  let postgresUnavailable = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_p07_e2e')
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
    await admin.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${secondUserId}'::uuid),
        ('${outsiderUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
      INSERT INTO plan_months
        (id, space_id, month_start, status, revision, created_at, updated_at)
      VALUES ('${planMonthId}'::uuid, '${spaceId}'::uuid,
              '${currentMonth()}-01'::date, 'draft', 1, now(), now()),
             ('${scheduledPlanMonthId}'::uuid, '${spaceId}'::uuid,
              '${monthAtOffset(1)}-01'::date, 'draft', 1, now(), now()),
             ('${blockedPlanMonthId}'::uuid, '${spaceId}'::uuid,
              '${monthAtOffset(2)}-01'::date, 'draft', 1, now(), now());
      INSERT INTO plan_drafts
        (plan_month_id, focus, revision, created_at, updated_at)
      VALUES ('${planMonthId}'::uuid, 'P07 empty-goal publication', 1, now(), now()),
             ('${scheduledPlanMonthId}'::uuid, 'P07 scheduled publication', 1, now(), now()),
             ('${blockedPlanMonthId}'::uuid, 'P07 blocked publication', 1, now(), now());
    `)

    provider = new PrismaClientProvider(
      {
        database: {
          url: postgres.getConnectionUri(),
          poolMax: 3,
          connectionTimeoutMs: 2_000,
          idleTimeoutMs: 5_000,
          healthTimeoutMs: 1_000,
          transactionMaxWaitMs: 1_000,
          transactionTimeoutMs: 5_000,
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
    const now = Date.now()
    const first = await issue.execute(userId, now)
    const second = await issue.execute(secondUserId, now)
    const outsider = await issue.execute(outsiderUserId, now)
    cookie = `planner-session=${first.rawToken}`
    secondCookie = `planner-session=${second.rawToken}`
    outsiderCookie = `planner-session=${outsider.rawToken}`
    csrfToken = first.csrfToken
    outsiderCsrfToken = outsider.csrfToken
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
      TELEGRAM_OIDC_CLIENT_SECRET: 'p07-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (redisSuspended) await resumeRedis(redis)
    if (postgresUnavailable) {
      await postgresControl.query(
        'ALTER DATABASE planner_p07_e2e WITH ALLOW_CONNECTIONS true',
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

  async function preview(
    selectedCookie = cookie,
    targetMonth = currentMonth(),
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/planning/drafts/publication-preview?targetMonth=${targetMonth}`,
      { headers: { cookie: selectedCookie } },
    )
  }

  async function post(
    body: Record<string, unknown> | string,
    options: {
      readonly selectedCookie?: string
      readonly selectedOrigin?: string
      readonly selectedCsrf?: string
      readonly contentType?: string
      readonly selectedPlanMonthId?: string
    } = {},
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/planning/drafts/${options.selectedPlanMonthId ?? planMonthId}/publish`,
      {
        method: 'POST',
        headers: {
          cookie: options.selectedCookie ?? cookie,
          origin: options.selectedOrigin ?? origin,
          'x-csrf-token': options.selectedCsrf ?? csrfToken,
          'content-type': options.contentType ?? 'application/json',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
    )
  }

  async function reopen(
    body: Record<string, unknown> | string,
    options: {
      readonly selectedCookie?: string
      readonly selectedOrigin?: string
      readonly selectedCsrf?: string
      readonly contentType?: string
      readonly selectedPlanMonthId?: string
    } = {},
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/planning/months/${options.selectedPlanMonthId ?? planMonthId}/reopen`,
      {
        method: 'POST',
        headers: {
          cookie: options.selectedCookie ?? cookie,
          origin: options.selectedOrigin ?? origin,
          'x-csrf-token': options.selectedCsrf ?? csrfToken,
          'content-type': options.contentType ?? 'application/json',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
    )
  }

  async function state(
    selectedPlanMonthIds: string | readonly string[],
  ): Promise<readonly Record<string, unknown>[]> {
    const ids =
      typeof selectedPlanMonthIds === 'string'
        ? [selectedPlanMonthIds]
        : selectedPlanMonthIds
    const value = await admin.query<Record<string, unknown>>(
      `SELECT month.id::text plan_month_id,
              month.status, month.revision::text month_revision,
              month.xmin::text month_xmin,
              month.active_publication_id::text active_publication_id,
              draft.revision::text draft_revision,
              draft.xmin::text draft_xmin,
              (SELECT count(*)::text FROM plan_publications publication
                WHERE publication.plan_month_id = month.id) publications,
              (SELECT count(*)::text FROM plan_goal_snapshots snapshot
                WHERE snapshot.plan_month_id = month.id) snapshots,
              (SELECT count(*)::text FROM fixed_expectations expectation
                JOIN plan_goal_snapshots snapshot
                  ON snapshot.id = expectation.plan_goal_snapshot_id
               WHERE snapshot.plan_month_id = month.id) fixed_expectations,
              (SELECT count(*)::text FROM flexible_periods period
                JOIN plan_goal_snapshots snapshot
                  ON snapshot.id = period.plan_goal_snapshot_id
               WHERE snapshot.plan_month_id = month.id) flexible_periods,
              (SELECT count(*)::text FROM planning_publication_changes change
                JOIN plan_publications publication
                  ON publication.id = change.publication_id
               WHERE publication.plan_month_id = month.id) changes,
              (SELECT count(*)::text FROM planning_action_groups action
                WHERE action.plan_month_id = month.id
                  AND action.action_kind = 'month_published') actions,
              (SELECT count(*)::text FROM command_receipts receipt
                JOIN plan_publications publication
                  ON publication.id = receipt.aggregate_id
               WHERE publication.plan_month_id = month.id
                 AND receipt.command_type = 'planning.publish-month.v1') receipts,
              coalesce((
                SELECT jsonb_agg(publication.xmin::text ORDER BY publication.id)
                  FROM plan_publications publication
                 WHERE publication.plan_month_id = month.id
              ), '[]'::jsonb) publication_xmins,
              coalesce((
                SELECT jsonb_agg(snapshot.xmin::text ORDER BY snapshot.id)
                  FROM plan_goal_snapshots snapshot
                 WHERE snapshot.plan_month_id = month.id
              ), '[]'::jsonb) snapshot_xmins,
              coalesce((
                SELECT jsonb_agg(expectation.xmin::text ORDER BY expectation.id)
                  FROM fixed_expectations expectation
                  JOIN plan_goal_snapshots snapshot
                    ON snapshot.id = expectation.plan_goal_snapshot_id
                 WHERE snapshot.plan_month_id = month.id
              ), '[]'::jsonb) fixed_expectation_xmins,
              coalesce((
                SELECT jsonb_agg(period.xmin::text ORDER BY period.id)
                  FROM flexible_periods period
                  JOIN plan_goal_snapshots snapshot
                    ON snapshot.id = period.plan_goal_snapshot_id
                 WHERE snapshot.plan_month_id = month.id
              ), '[]'::jsonb) flexible_period_xmins,
              coalesce((
                SELECT jsonb_agg(change.xmin::text ORDER BY change.action_id)
                  FROM planning_publication_changes change
                  JOIN plan_publications publication
                    ON publication.id = change.publication_id
                 WHERE publication.plan_month_id = month.id
              ), '[]'::jsonb) publication_change_xmins
         FROM plan_months month
         JOIN plan_drafts draft ON draft.plan_month_id = month.id
        WHERE month.id = ANY($1::uuid[])
        ORDER BY month.id`,
      [ids],
    )
    return value.rows
  }

  async function expectExactProblem(
    response: Response,
    expected: {
      readonly status: number
      readonly type: string
      readonly title: string
      readonly detail: string
      readonly code: string
      readonly blockers?: unknown
    },
  ): Promise<Record<string, unknown>> {
    expect(response.status).toBe(expected.status)
    expect(response.headers.get('content-type')).toMatch(
      /^application\/problem\+json/u,
    )
    const value = await json(response)
    expect(value['requestId']).toEqual(expect.any(String))
    expect(value['instance']).toBe(`urn:request:${String(value['requestId'])}`)
    expect(value).toEqual({
      ...expected,
      instance: value['instance'],
      requestId: value['requestId'],
    })
    return value
  }

  it('publishes an empty-goal preview once and serves immutable/active snapshots to both members', async () => {
    const before = await preview()
    expect(before.status).toBe(200)
    const value = await json(before)
    expect(value['blockers']).toEqual([])
    const commandId = randomUUID()
    const body = {
      commandId,
      expectedRevision: value['draftRevision'],
      previewSchemaVersion: value['schemaVersion'],
      previewHashVersion: value['previewHashVersion'],
      previewHash: value['previewHash'],
    }

    const created = await post(body)
    expect(created.status).toBe(201)
    const createdValue = await json(created)
    await expectExactProblem(await preview(), {
      type: 'https://planner.invalid/problems/plan-draft-not-editable',
      title: 'Plan draft not editable',
      status: 409,
      detail: 'The plan month is not an editable draft.',
      code: 'PLAN_DRAFT_NOT_EDITABLE',
    })
    const replay = await post(body)
    expect(replay.status).toBe(201)
    const ref = await json(replay)
    expect(ref).toMatchObject({
      kind: 'planning.plan-publication.v1',
      aggregateRevision: '1',
    })
    const publicationId = String(ref['aggregateId'])
    publishedPublicationId = publicationId
    const first = await fetch(
      `${baseUrl}/planning/publications/${publicationId}`,
      { headers: { cookie } },
    )
    const second = await fetch(
      `${baseUrl}/planning/publications/${publicationId}`,
      { headers: { cookie: secondCookie } },
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstText = await first.text()
    expect(await second.text()).toBe(firstText)
    const firstValue = JSON.parse(firstText) as Record<string, unknown>
    const active = await fetch(`${baseUrl}/planning/months/active`, {
      headers: { cookie },
    })
    expect(active.status).toBe(200)
    const activeValue = await json(active)
    expect(activeValue).toMatchObject({
      publicationId,
      goalSnapshots: [],
      calculatedTargets: [],
      publicationSnapshotHash: value['previewHash'],
    })

    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >
          }
        >
      >
      components: unknown
    }
    for (const [path, method, status, payload] of [
      ['/planning/drafts/{planMonthId}/publish', 'post', '201', createdValue],
      ['/planning/publications/{publicationId}', 'get', '200', firstValue],
      ['/planning/months/active', 'get', '200', activeValue],
    ] as const) {
      const schema =
        document.paths[path]?.[method]?.responses?.[status]?.content?.[
          'application/json'
        ]?.schema
      const validator = new OpenAPIResponseValidator({
        responses: { [status]: { schema: schema as never } },
        components: document.components as never,
        customFormats: { date: () => true },
      })
      expect(validator.validateResponse(status, payload)).toBeUndefined()
    }

    const already = await post({ ...body, commandId: randomUUID() })
    expect(already.status).toBe(409)
    expect(await json(already)).toMatchObject({
      code: 'PLAN_MONTH_ALREADY_PUBLISHED',
      conflict: {
        publicationId,
        publicationRevision: '1',
        nextAction: 'open-published-plan',
      },
    })
    const missing = await fetch(
      `${baseUrl}/planning/publications/${randomUUID()}`,
      { headers: { cookie } },
    )
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({
      code: 'PLAN_PUBLICATION_NOT_FOUND',
    })
  })

  it('conceals unavailable publications and excludes scheduled, non-current, non-published, wrong-pointer and future-active candidates without GET writes', async () => {
    const scheduledPreviewResponse = await preview(cookie, monthAtOffset(1))
    expect(scheduledPreviewResponse.status).toBe(200)
    const scheduledPreview = await json(scheduledPreviewResponse)
    expect(scheduledPreview['activation']).toMatchObject({ mode: 'scheduled' })
    const scheduledResponse = await post(
      {
        commandId: randomUUID(),
        expectedRevision: scheduledPreview['draftRevision'],
        previewSchemaVersion: scheduledPreview['schemaVersion'],
        previewHashVersion: scheduledPreview['previewHashVersion'],
        previewHash: scheduledPreview['previewHash'],
      },
      { selectedPlanMonthId: scheduledPlanMonthId },
    )
    expect(scheduledResponse.status).toBe(201)
    const scheduledPublicationId = String(
      (await json(scheduledResponse))['aggregateId'],
    )
    expect(
      (
        await fetch(
          `${baseUrl}/planning/publications/${scheduledPublicationId}`,
          { headers: { cookie } },
        )
      ).status,
    ).toBe(200)
    const activeBeforeMutants = await fetch(
      `${baseUrl}/planning/months/active`,
      { headers: { cookie } },
    )
    expect(activeBeforeMutants.status).toBe(200)
    expect(await json(activeBeforeMutants)).toMatchObject({
      publicationId: publishedPublicationId,
    })

    const outsiderRead = await fetch(
      `${baseUrl}/planning/publications/${publishedPublicationId}`,
      { headers: { cookie: outsiderCookie } },
    )
    await expectExactProblem(outsiderRead, {
      type: 'https://planner.invalid/problems/planning-authorization-denied',
      title: 'Planning authorization denied',
      status: 403,
      detail: 'The current principal cannot access this planning operation.',
      code: 'PLANNING_AUTHORIZATION_DENIED',
    })
    const missing = await fetch(
      `${baseUrl}/planning/publications/${randomUUID()}`,
      { headers: { cookie } },
    )
    await expectExactProblem(missing, {
      type: 'https://planner.invalid/problems/plan-publication-not-found',
      title: 'Plan publication not found',
      status: 404,
      detail: 'The requested plan publication was not found.',
      code: 'PLAN_PUBLICATION_NOT_FOUND',
    })

    const expectActiveMissingWithoutWrites = async (
      planMonthIds: readonly string[],
    ): Promise<void> => {
      const before = await state(planMonthIds)
      const inactive = await fetch(`${baseUrl}/planning/months/active`, {
        headers: { cookie },
      })
      await expectExactProblem(inactive, {
        type: 'https://planner.invalid/problems/active-plan-month-not-found',
        title: 'Active plan month not found',
        status: 404,
        detail: 'There is no active published plan for the current local date.',
        code: 'ACTIVE_PLAN_MONTH_NOT_FOUND',
      })
      expect(await state(planMonthIds)).toEqual(before)
    }

    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_guard_l02_lifecycle_update',
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_lifecycle_effect_consistent',
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_require_publication_pointer',
    )
    try {
      for (const status of ['draft', 'grace', 'closed'] as const) {
        await admin.query(
          `UPDATE plan_months
              SET status = $2::varchar,
                  active_publication_id = CASE WHEN $2::text = 'draft' THEN NULL
                                               ELSE $3::uuid END
            WHERE id = $1::uuid`,
          [planMonthId, status, publishedPublicationId],
        )
        await expectActiveMissingWithoutWrites([
          planMonthId,
          scheduledPlanMonthId,
        ])
        if (status === 'grace') {
          const beforePost = await state([planMonthId, scheduledPlanMonthId])
          const notEditable = await post({
            commandId: randomUUID(),
            expectedRevision: '1',
            previewSchemaVersion: 'planner.publication-preview.v1',
            previewHashVersion: 'planner.publication-preview-hash.v1',
            previewHash: 'a'.repeat(64),
          })
          await expectExactProblem(notEditable, {
            type: 'https://planner.invalid/problems/plan-draft-not-editable',
            title: 'Plan draft not editable',
            status: 409,
            detail: 'The plan month is not an editable draft.',
            code: 'PLAN_DRAFT_NOT_EDITABLE',
          })
          expect(await state([planMonthId, scheduledPlanMonthId])).toEqual(
            beforePost,
          )
        }
      }
    } finally {
      await admin.query(
        `UPDATE plan_months
            SET status = 'published', active_publication_id = $2::uuid
          WHERE id = $1::uuid`,
        [planMonthId, publishedPublicationId],
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_require_publication_pointer',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_lifecycle_effect_consistent',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_guard_l02_lifecycle_update',
      )
    }

    const scheduledOriginal = await admin.query<{
      month_start: string
      activation_mode: string
      active_local_date: string
      late_publication: boolean
      published_at: Date
    }>(
      `SELECT month.month_start::text, publication.activation_mode,
              publication.active_local_date::text,
              publication.late_publication, publication.published_at
         FROM plan_publications publication
         JOIN plan_months month ON month.id = publication.plan_month_id
        WHERE publication.id = $1::uuid`,
      [scheduledPublicationId],
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_guard_l02_lifecycle_update',
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_lifecycle_effect_consistent',
    )
    await admin.query(
      'ALTER TABLE plan_publications DISABLE TRIGGER plan_publications_reject_update_delete',
    )
    try {
      await admin.query(
        `UPDATE plan_months SET month_start = $2::date
          WHERE id = $1::uuid`,
        [scheduledPlanMonthId, `${monthAtOffset(-1)}-01`],
      )
      await admin.query(
        `UPDATE plan_publications
            SET activation_mode = 'immediate', active_local_date = $2::date,
                late_publication = false, published_at = $2::date::timestamp
                  AT TIME ZONE 'Asia/Yekaterinburg'
          WHERE id = $1::uuid`,
        [scheduledPublicationId, `${monthAtOffset(-1)}-01`],
      )
      await admin.query(
        `UPDATE plan_months SET status = 'grace' WHERE id = $1::uuid`,
        [planMonthId],
      )
      await expectActiveMissingWithoutWrites([
        planMonthId,
        scheduledPlanMonthId,
      ])
    } finally {
      const original = scheduledOriginal.rows[0]!
      await admin.query(
        `UPDATE plan_months SET status = 'published' WHERE id = $1::uuid`,
        [planMonthId],
      )
      await admin.query(
        `UPDATE plan_months SET month_start = $2::date WHERE id = $1::uuid`,
        [scheduledPlanMonthId, original.month_start],
      )
      await admin.query(
        `UPDATE plan_publications
            SET activation_mode = $2, active_local_date = $3::date,
                late_publication = $4, published_at = $5::timestamptz
          WHERE id = $1::uuid`,
        [
          scheduledPublicationId,
          original.activation_mode,
          original.active_local_date,
          original.late_publication,
          original.published_at,
        ],
      )
      await admin.query(
        'ALTER TABLE plan_publications ENABLE TRIGGER plan_publications_reject_update_delete',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_lifecycle_effect_consistent',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_guard_l02_lifecycle_update',
      )
    }

    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_guard_l02_lifecycle_update',
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_lifecycle_effect_consistent',
    )
    await admin.query(
      'ALTER TABLE plan_months DISABLE TRIGGER plan_months_require_publication_pointer',
    )
    try {
      await admin.query(
        `UPDATE plan_months SET active_publication_id = NULL WHERE id = $1::uuid`,
        [planMonthId],
      )
      await expectActiveMissingWithoutWrites([
        planMonthId,
        scheduledPlanMonthId,
      ])
    } finally {
      await admin.query(
        `UPDATE plan_months SET active_publication_id = $2::uuid
          WHERE id = $1::uuid`,
        [planMonthId, publishedPublicationId],
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_require_publication_pointer',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_lifecycle_effect_consistent',
      )
      await admin.query(
        'ALTER TABLE plan_months ENABLE TRIGGER plan_months_guard_l02_lifecycle_update',
      )
    }

    const activeDate = await admin.query<{ active_local_date: string }>(
      `SELECT active_local_date::text FROM plan_publications WHERE id = $1::uuid`,
      [publishedPublicationId],
    )
    await admin.query(
      'ALTER TABLE plan_publications DISABLE TRIGGER plan_publications_reject_update_delete',
    )
    try {
      await admin.query(
        `UPDATE plan_publications
            SET active_local_date = DATE '9999-12-31'
          WHERE id = $1::uuid`,
        [publishedPublicationId],
      )
      await expectActiveMissingWithoutWrites([
        planMonthId,
        scheduledPlanMonthId,
      ])
    } finally {
      await admin.query(
        `UPDATE plan_publications SET active_local_date = $2::date
          WHERE id = $1::uuid`,
        [publishedPublicationId, activeDate.rows[0]!.active_local_date],
      )
      await admin.query(
        'ALTER TABLE plan_publications ENABLE TRIGGER plan_publications_reject_update_delete',
      )
    }

    await admin.query(
      `ALTER TABLE spaces DROP CONSTRAINT spaces_singleton_key_check;
       ALTER TABLE spaces DROP CONSTRAINT spaces_singleton_key_key`,
    )
    let foreignPublicationId: string | undefined
    try {
      await admin.query(
        `INSERT INTO spaces (id, singleton_key) VALUES ($1::uuid, 2)`,
        [foreignSpaceId],
      )
      await admin.query(
        `INSERT INTO memberships (id, space_id, user_id, slot)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1)`,
        [foreignMemberId, foreignSpaceId, outsiderUserId],
      )
      await admin.query(
        `INSERT INTO plan_months
           (id, space_id, month_start, status, revision, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, 'draft', 1, now(), now())`,
        [foreignPlanMonthId, foreignSpaceId, `${currentMonth()}-01`],
      )
      await admin.query(
        `INSERT INTO plan_drafts
           (plan_month_id, focus, revision, created_at, updated_at)
         VALUES ($1::uuid, 'Foreign space publication', 1, now(), now())`,
        [foreignPlanMonthId],
      )
      const foreignPreviewResponse = await preview(
        outsiderCookie,
        currentMonth(),
      )
      expect(foreignPreviewResponse.status).toBe(200)
      const foreignPreview = await json(foreignPreviewResponse)
      const foreignPublicationResponse = await post(
        {
          commandId: randomUUID(),
          expectedRevision: foreignPreview['draftRevision'],
          previewSchemaVersion: foreignPreview['schemaVersion'],
          previewHashVersion: foreignPreview['previewHashVersion'],
          previewHash: foreignPreview['previewHash'],
        },
        {
          selectedCookie: outsiderCookie,
          selectedCsrf: outsiderCsrfToken,
          selectedPlanMonthId: foreignPlanMonthId,
        },
      )
      expect(foreignPublicationResponse.status).toBe(201)
      foreignPublicationId = String(
        (await json(foreignPublicationResponse))['aggregateId'],
      )
      const beforeForeignRead = await state([
        planMonthId,
        scheduledPlanMonthId,
        foreignPlanMonthId,
      ])
      const concealed = await fetch(
        `${baseUrl}/planning/publications/${foreignPublicationId}`,
        { headers: { cookie } },
      )
      await expectExactProblem(concealed, {
        type: 'https://planner.invalid/problems/plan-publication-not-found',
        title: 'Plan publication not found',
        status: 404,
        detail: 'The requested plan publication was not found.',
        code: 'PLAN_PUBLICATION_NOT_FOUND',
      })
      expect(
        await state([planMonthId, scheduledPlanMonthId, foreignPlanMonthId]),
      ).toEqual(beforeForeignRead)
    } finally {
      const cleanup = await admin.connect()
      try {
        await cleanup.query("SET session_replication_role = 'replica'")
        await cleanup.query(
          `DELETE FROM command_receipts
            WHERE aggregate_id IN (
              SELECT id FROM plan_publications WHERE plan_month_id = $1::uuid
            )`,
          [foreignPlanMonthId],
        )
        await cleanup.query(
          `DELETE FROM planning_publication_changes
            WHERE publication_id IN (
              SELECT id FROM plan_publications WHERE plan_month_id = $1::uuid
            )`,
          [foreignPlanMonthId],
        )
        await cleanup.query(
          `DELETE FROM planning_action_groups WHERE plan_month_id = $1::uuid`,
          [foreignPlanMonthId],
        )
        await cleanup.query(
          `DELETE FROM fixed_expectations
            WHERE plan_goal_snapshot_id IN (
              SELECT id FROM plan_goal_snapshots WHERE plan_month_id = $1::uuid
            )`,
          [foreignPlanMonthId],
        )
        await cleanup.query(
          `DELETE FROM flexible_periods
            WHERE plan_goal_snapshot_id IN (
              SELECT id FROM plan_goal_snapshots WHERE plan_month_id = $1::uuid
            )`,
          [foreignPlanMonthId],
        )
        for (const [statement, parameters] of [
          [
            'DELETE FROM plan_goal_snapshots WHERE plan_month_id = $1::uuid',
            [foreignPlanMonthId],
          ],
          [
            'DELETE FROM plan_publications WHERE plan_month_id = $1::uuid',
            [foreignPlanMonthId],
          ],
          [
            'DELETE FROM plan_drafts WHERE plan_month_id = $1::uuid',
            [foreignPlanMonthId],
          ],
          ['DELETE FROM plan_months WHERE id = $1::uuid', [foreignPlanMonthId]],
          ['DELETE FROM memberships WHERE id = $1::uuid', [foreignMemberId]],
          ['DELETE FROM spaces WHERE id = $1::uuid', [foreignSpaceId]],
        ] as const) {
          await cleanup.query(statement, [...parameters])
        }
      } finally {
        await cleanup
          .query("SET session_replication_role = 'origin'")
          .catch(() => undefined)
        cleanup.release()
      }
      await admin.query(
        `ALTER TABLE spaces
           ADD CONSTRAINT spaces_singleton_key_check CHECK (singleton_key = 1);
         ALTER TABLE spaces
           ADD CONSTRAINT spaces_singleton_key_key UNIQUE (singleton_key)`,
      )
    }

    const beforeReads = await state([planMonthId, scheduledPlanMonthId])
    for (let index = 0; index < 3; index += 1) {
      expect(
        (
          await fetch(
            `${baseUrl}/planning/publications/${publishedPublicationId}`,
            { headers: { cookie } },
          )
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(`${baseUrl}/planning/months/active`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(200)
    }
    expect(await state([planMonthId, scheduledPlanMonthId])).toEqual(
      beforeReads,
    )
  })

  it('enforces session, CSRF/origin and exact request validation without writes', async () => {
    const body = {
      commandId: randomUUID(),
      expectedRevision: '1',
      previewSchemaVersion: 'planner.publication-preview.v1',
      previewHashVersion: 'planner.publication-preview-hash.v1',
      previewHash: 'ab'.repeat(32),
    }
    const before = await state(planMonthId)
    expect((await post(body, { selectedCookie: '' })).status).toBe(401)
    await expectExactProblem(
      await post(body, {
        selectedCookie: outsiderCookie,
        selectedCsrf: outsiderCsrfToken,
      }),
      {
        type: 'https://planner.invalid/problems/planning-authorization-denied',
        title: 'Planning authorization denied',
        status: 403,
        detail: 'The current principal cannot access this planning operation.',
        code: 'PLANNING_AUTHORIZATION_DENIED',
      },
    )
    expect((await post(body, { selectedCsrf: 'wrong' })).status).toBe(403)
    expect(
      (await post(body, { selectedOrigin: 'https://wrong.invalid' })).status,
    ).toBe(403)
    expect((await post({ ...body, targetMonth: currentMonth() })).status).toBe(
      422,
    )
    expect((await post(body, { contentType: 'text/plain' })).status).toBe(415)
    await expectExactProblem(await post('{"commandId":'), {
      type: 'https://planner.invalid/problems/malformed-request',
      title: 'Malformed request',
      status: 400,
      detail: 'The request could not be parsed.',
      code: 'MALFORMED_REQUEST',
    })
    await expectExactProblem(
      await post(`{"padding":"${'x'.repeat(1_048_577)}"}`),
      {
        type: 'https://planner.invalid/problems/payload-too-large',
        title: 'Payload too large',
        status: 413,
        detail: 'The request payload exceeds the configured limit.',
        code: 'PAYLOAD_TOO_LARGE',
      },
    )
    expect(await state(planMonthId)).toEqual(before)
  })

  it('returns the exact live blocked Problem with blockers and validates it against committed OpenAPI', async () => {
    const response = await preview(cookie, monthAtOffset(2))
    expect(response.status).toBe(200)
    const blockedPreview = await json(response)
    expect(blockedPreview['blockers']).toEqual([
      {
        planGoalId: null,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
    ])
    const before = await state(blockedPlanMonthId)
    const blockedResponse = await post(
      {
        commandId: randomUUID(),
        expectedRevision: blockedPreview['draftRevision'],
        previewSchemaVersion: blockedPreview['schemaVersion'],
        previewHashVersion: blockedPreview['previewHashVersion'],
        previewHash: blockedPreview['previewHash'],
      },
      { selectedPlanMonthId: blockedPlanMonthId },
    )
    const problem = await expectExactProblem(blockedResponse, {
      type: 'https://planner.invalid/problems/plan-publication-blocked',
      title: 'Plan publication blocked',
      status: 409,
      detail: 'The current plan draft contains publication blockers.',
      code: 'PLAN_PUBLICATION_BLOCKED',
      blockers: blockedPreview['blockers'],
    })
    expect(await state(blockedPlanMonthId)).toEqual(before)

    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >
          }
        >
      >
      components: unknown
    }
    const schema =
      document.paths['/planning/drafts/{planMonthId}/publish']?.['post']
        ?.responses?.['409']?.content?.['application/problem+json']?.schema
    const validator = new OpenAPIResponseValidator({
      responses: { '409': { schema: schema as never } },
      components: document.components as never,
    })
    expect(validator.validateResponse('409', problem)).toBeUndefined()
  })

  it('publishes exact OpenAPI paths, security, statuses and finite publication schemas/problems', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<
        string,
        Record<
          string,
          { security?: unknown; responses?: Record<string, unknown> }
        >
      >
      components: { schemas: Record<string, unknown> }
    }
    expect(
      document.paths['/planning/drafts/{planMonthId}/publish']?.['post']
        ?.security,
    ).toEqual([{ sessionCookie: [], csrfToken: [] }])
    expect(
      Object.keys(
        document.paths['/planning/drafts/{planMonthId}/publish']?.['post']
          ?.responses ?? {},
      ).sort(),
    ).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '422',
      '503',
    ])
    expect(
      document.paths['/planning/publications/{publicationId}']?.['get']
        ?.security,
    ).toEqual([{ sessionCookie: [] }])
    expect(
      document.paths['/planning/months/active']?.['get']?.security,
    ).toEqual([{ sessionCookie: [] }])
    expect(
      document.paths['/planning/months/{planMonthId}/reopen']?.['post']
        ?.security,
    ).toEqual([{ sessionCookie: [], csrfToken: [] }])
    expect(
      Object.keys(
        document.paths['/planning/months/{planMonthId}/reopen']?.['post']
          ?.responses ?? {},
      ).sort(),
    ).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '422',
      '503',
    ])
    for (const name of [
      'PublishMonthRequestV1',
      'PlanPublicationResultResponseV1',
      'PublishedSnapshotResponseV1',
      'PublicationPreviewConflictProblemResponseDto',
      'PlanPublicationBlockedProblemResponseDto',
      'PlanMonthAlreadyPublishedProblemResponseDto',
      'ReopenMonthRequestV1',
      'PlanMonthMutationResponseV1',
      'PlanMonthRevisionConflictProblemResponseDto',
      'PlanMonthReopenConflictProblemResponseDto',
    ])
      expect(document.components.schemas[name]).toBeDefined()
  })

  it('protects the reasoned reopen boundary with CSRF, member authorization and finite conflicts', async () => {
    const month = (await state(planMonthId))[0]
    const body = {
      commandId: randomUUID(),
      expectedRevision: month?.['month_revision'],
      reason: 'Проверка HTTP-контракта закрытого месяца.',
    }
    const missingReason = await reopen({
      commandId: body.commandId,
      expectedRevision: body.expectedRevision,
    })
    expect(missingReason.status).toBe(422)
    expect(await json(missingReason)).toMatchObject({
      code: 'VALIDATION_FAILED',
    })

    const noCsrf = await reopen(body, { selectedCsrf: '' })
    expect(noCsrf.status).toBe(403)

    const outsider = await reopen(body, {
      selectedCookie: outsiderCookie,
      selectedCsrf: outsiderCsrfToken,
    })
    expect(outsider.status).toBe(403)
    expect(await json(outsider)).toMatchObject({
      code: 'PLANNING_AUTHORIZATION_DENIED',
    })

    const conflict = await reopen(body)
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({
      code: 'PLAN_MONTH_REOPEN_CONFLICT',
      conflict: {
        reason: 'not_closed',
        currentStatus: 'published',
      },
    })
  })

  it('reopens a closed report over HTTP with replay, fingerprint and stale-CAS semantics', async () => {
    await admin.query(
      `INSERT INTO plan_months
         (id, space_id, month_start, status, revision, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, 'draft', 1, now(), now())`,
      [reopenPlanMonthId, spaceId, `${monthAtOffset(-1)}-01`],
    )
    await admin.query(
      `INSERT INTO plan_drafts
         (plan_month_id, focus, revision, created_at, updated_at)
       VALUES ($1::uuid, 'L02 HTTP reopen', 1, now(), now())`,
      [reopenPlanMonthId],
    )
    const reopenPublicationId = randomUUID()
    const publishCommandId = randomUUID()
    const publishAt = new Date(`${monthAtOffset(-1)}-01T00:00:00.000Z`)
    const publishClient = await admin.connect()
    try {
      await publishClient.query('BEGIN')
      await publishClient.query(
        `INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 1, 'L02 HTTP reopen',
           'immediate', $4::date, false, 'Asia/Yekaterinburg',
           'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('a', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', $5::uuid, $6)`,
        [
          reopenPublicationId,
          spaceId,
          reopenPlanMonthId,
          `${monthAtOffset(-1)}-01`,
          memberId,
          publishAt,
        ],
      )
      const publishActionId = randomUUID()
      await publishClient.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
         VALUES ($1::uuid, 'month_published', 'member', $2, $3::uuid, NULL,
           $4::uuid, NULL, 'planning.publish-month.v1', $5::uuid, 1, 2, $6)`,
        [
          publishActionId,
          `member:${memberId}`,
          memberId,
          reopenPlanMonthId,
          publishCommandId,
          publishAt,
        ],
      )
      await publishClient.query(
        `INSERT INTO planning_publication_changes
          (action_id, publication_id, change_kind, confirmed_draft_revision,
           confirmed_preview_schema_version, confirmed_preview_hash_version,
           confirmed_preview_hash, before_active_publication_id,
           after_active_publication_id)
         VALUES ($1::uuid, $2::uuid, 'published', 1,
           'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('a', 64), NULL,
           $2::uuid)`,
        [publishActionId, reopenPublicationId],
      )
      await publishClient.query(
        `UPDATE plan_months
            SET status = 'published', active_publication_id = $2::uuid,
                revision = 2, updated_at = $3
          WHERE id = $1::uuid`,
        [reopenPlanMonthId, reopenPublicationId, publishAt],
      )
      await publishClient.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'planning.publish-month.v1', $2::uuid, repeat('0', 64),
           'planning.plan-publication.v1', $3::uuid, 1, $4)`,
        [
          `member:${memberId}`,
          publishCommandId,
          reopenPublicationId,
          publishAt,
        ],
      )
      await publishClient.query('COMMIT')
    } catch (error: unknown) {
      await publishClient.query('ROLLBACK')
      throw error
    } finally {
      publishClient.release()
    }

    const graceAt = new Date(Date.now() + 1_000)
    const closeAt = new Date(graceAt.getTime() + 1_000)
    const graceCommandId = randomUUID()
    const closeCommandId = randomUUID()
    const reportId = randomUUID()
    const client = await admin.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
         VALUES ($1::uuid, 'month_grace_started', 'system',
           'system:planner-worker', NULL, 'planner-worker', $2::uuid, NULL,
           'planning.start-month-grace.v1', $3::uuid, 2, 3, $4)`,
        [randomUUID(), reopenPlanMonthId, graceCommandId, graceAt],
      )
      await client.query(
        `UPDATE plan_months
            SET status = 'grace', revision = 3, updated_at = $2
          WHERE id = $1::uuid`,
        [reopenPlanMonthId, graceAt],
      )
      await client.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ('system:planner-worker', 'planning.start-month-grace.v1',
           $1::uuid, repeat('1', 64), 'planning.plan-month.v1', $2::uuid, 3, $3)`,
        [graceCommandId, reopenPlanMonthId, graceAt],
      )
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      await client.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
         VALUES ($1::uuid, 'month_closed', 'system',
           'system:planner-worker', NULL, 'planner-worker', $2::uuid, NULL,
           'planning.close-month.v1', $3::uuid, 3, 4, $4)`,
        [randomUUID(), reopenPlanMonthId, closeCommandId, closeAt],
      )
      await client.query(
        `INSERT INTO report_revisions
          (id, plan_month_id, publication_id, revision,
           publication_snapshot_hash, source_facts_revision, formula_version,
           payload, payload_checksum, status, created_at,
           created_by_system_actor_id)
         SELECT $1::uuid, month.id, month.active_publication_id, 1,
                publication.preview_hash, month.facts_revision,
                'planner.report.v1', '{}'::jsonb, repeat('c', 64), 'original',
                $2, 'planner-worker'
           FROM plan_months month
           JOIN plan_publications publication
             ON publication.id = month.active_publication_id
          WHERE month.id = $3::uuid`,
        [reportId, closeAt, reopenPlanMonthId],
      )
      await client.query(
        `UPDATE plan_months
            SET status = 'closed', revision = 4, updated_at = $2
          WHERE id = $1::uuid`,
        [reopenPlanMonthId, closeAt],
      )
      await client.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ('system:planner-worker', 'planning.close-month.v1',
           $1::uuid, repeat('2', 64), 'planning.report-revision.v1', $2::uuid, 1, $3)`,
        [closeCommandId, reportId, closeAt],
      )
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const reportBefore = await admin.query(
      'SELECT * FROM report_revisions WHERE id = $1::uuid',
      [reportId],
    )
    const commandId = randomUUID()
    const body = {
      commandId,
      expectedRevision: '4',
      reason: 'Уточняем факты после сверки закрытого отчёта.',
    }
    const success = await reopen(body, {
      selectedPlanMonthId: reopenPlanMonthId,
    })
    expect(success.status).toBe(200)
    const receipt = await json(success)
    expect(receipt).toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: reopenPlanMonthId,
      aggregateRevision: '5',
    })
    const replay = await reopen(body, {
      selectedPlanMonthId: reopenPlanMonthId,
    })
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(receipt)

    const fingerprint = await reopen(
      { ...body, reason: 'Другой fingerprint.' },
      { selectedPlanMonthId: reopenPlanMonthId },
    )
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
    const stale = await reopen(
      { ...body, commandId: randomUUID() },
      { selectedPlanMonthId: reopenPlanMonthId },
    )
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({
      code: 'PLAN_MONTH_REVISION_CONFLICT',
      conflict: { expectedRevision: '4', currentRevision: '5' },
    })
    expect(
      (
        await admin.query(
          `SELECT status, lifecycle_mode, revision::text
             FROM plan_months WHERE id = $1::uuid`,
          [reopenPlanMonthId],
        )
      ).rows,
    ).toEqual([{ status: 'grace', lifecycle_mode: 'reopened', revision: '5' }])
    expect(
      (
        await admin.query(
          'SELECT * FROM report_revisions WHERE id = $1::uuid',
          [reportId],
        )
      ).rows,
    ).toEqual(reportBefore.rows)
    expect(reopenPublicationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
  })

  it('fails closed through Redis and PostgreSQL outages, then retries the same zero-write blocked command after recovery', async () => {
    const response = await preview(cookie, monthAtOffset(2))
    const blockedPreview = await json(response)
    const command = {
      commandId: randomUUID(),
      expectedRevision: blockedPreview['draftRevision'],
      previewSchemaVersion: blockedPreview['schemaVersion'],
      previewHashVersion: blockedPreview['previewHashVersion'],
      previewHash: blockedPreview['previewHash'],
    }
    const options = { selectedPlanMonthId: blockedPlanMonthId }
    const before = await state(blockedPlanMonthId)
    const dependency = {
      type: 'https://planner.invalid/problems/dependency-unavailable',
      title: 'Dependency unavailable',
      status: 503,
      detail: 'A required service is temporarily unavailable.',
      code: 'DEPENDENCY_UNAVAILABLE',
    } as const
    const blocked = {
      type: 'https://planner.invalid/problems/plan-publication-blocked',
      title: 'Plan publication blocked',
      status: 409,
      detail: 'The current plan draft contains publication blockers.',
      code: 'PLAN_PUBLICATION_BLOCKED',
      blockers: blockedPreview['blockers'],
    } as const

    await suspendRedis(redis)
    redisSuspended = true
    await waitForStatus(`${baseUrl}/health/ready`, 503, 4_000)
    await expectExactProblem(await post(command, options), dependency)
    await resumeRedis(redis)
    redisSuspended = false
    await waitForStatus(`${baseUrl}/health/ready`, 200, 5_000)
    await expectExactProblem(await post(command, options), blocked)
    expect(await state(blockedPlanMonthId)).toEqual(before)

    await postgresControl.query(
      'ALTER DATABASE planner_p07_e2e WITH ALLOW_CONNECTIONS false',
    )
    postgresUnavailable = true
    await postgresControl.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 'planner_p07_e2e' AND pid <> pg_backend_pid()
    `)
    try {
      await expectExactProblem(await post(command, options), dependency)
    } finally {
      await postgresControl.query(
        'ALTER DATABASE planner_p07_e2e WITH ALLOW_CONNECTIONS true',
      )
      postgresUnavailable = false
    }
    await waitForStatus(`${baseUrl}/health/ready`, 200, 5_000)
    await expectExactProblem(await post(command, options), blocked)
    expect(await state(blockedPlanMonthId)).toEqual(before)
  })
})
