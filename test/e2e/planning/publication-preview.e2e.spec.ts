import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

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
const outsiderUserId = 'aaaaaaaa-1111-4111-8111-111111111111'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const sessionKeySecret = Buffer.alloc(32, 61)
const csrfSecret = Buffer.alloc(32, 62)

function parts(date: Date): { year: number; month: number; day: number } {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const read = (type: string): number =>
    Number(values.find((part) => part.type === type)?.value)
  return { year: read('year'), month: read('month'), day: read('day') }
}

function month(offset: number): string {
  const now = parts(new Date())
  const date = new Date(Date.UTC(now.year, now.month - 1 + offset, 1))
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}`
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

describe('P06 authenticated publication preview HTTP', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let control: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let cookie: string
  let secondCookie: string
  let outsiderCookie: string
  let csrfToken: string
  let origin: string
  let currentMonth: string
  let nextMonth: string
  let previousMonth: string
  let currentPlanMonthId: string
  let nextPlanMonthId: string
  let blockedPlanMonthId: string
  let monthlyPlanGoalId: string
  let postgresUnavailable = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_p06_e2e')
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
    control = new Pool({ connectionString: controlUrl.toString() })
    currentMonth = month(0)
    nextMonth = month(1)
    previousMonth = month(-1)
    currentPlanMonthId = randomUUID()
    nextPlanMonthId = randomUUID()
    blockedPlanMonthId = randomUUID()
    monthlyPlanGoalId = randomUUID()
    const invalidPlanGoalId = randomUUID()
    const monthlyDefinitionId = randomUUID()
    const invalidDefinitionId = randomUUID()
    const monthlySeriesId = randomUUID()
    const invalidSeriesId = randomUUID()
    const monthlyVersionId = randomUUID()
    const invalidVersionId = randomUUID()
    const monthlyRevisionId = randomUUID()
    const invalidRevisionId = randomUUID()
    const monthlyConfig = JSON.stringify({
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: memberId },
      repetition: { kind: 'monthly', n: '10' },
      measurement: { kind: 'boolean' },
      checkpoints: null,
    })
    const invalidConfig = JSON.stringify({
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: null },
      repetition: { kind: 'weekly', n: null },
      measurement: { kind: 'boolean' },
      checkpoints: null,
    })
    const sqlLiteral = (value: string): string =>
      `'${value.replaceAll("'", "''")}'`
    await admin.query(
      `
      INSERT INTO users (id) VALUES (${sqlLiteral(userId)}::uuid), (${sqlLiteral(secondUserId)}::uuid), (${sqlLiteral(outsiderUserId)}::uuid);
      INSERT INTO spaces (id, singleton_key) VALUES (${sqlLiteral(spaceId)}::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        (${sqlLiteral(memberId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(userId)}::uuid, 1),
        (${sqlLiteral(secondMemberId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(secondUserId)}::uuid, 2);
      INSERT INTO plan_months
        (id, space_id, month_start, status, revision, created_at, updated_at)
      VALUES
        (${sqlLiteral(currentPlanMonthId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(`${currentMonth}-01`)}::date, 'draft', 2, now(), now()),
        (${sqlLiteral(nextPlanMonthId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(`${nextMonth}-01`)}::date, 'draft', 1, now(), now()),
        (${sqlLiteral(blockedPlanMonthId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(`${previousMonth}-01`)}::date, 'draft', 1, now(), now());
      INSERT INTO plan_drafts
        (plan_month_id, focus, revision, created_at, updated_at)
      VALUES
        (${sqlLiteral(currentPlanMonthId)}::uuid, 'Current preview focus', 7, now(), now()),
        (${sqlLiteral(nextPlanMonthId)}::uuid, 'Next preview focus', 1, now(), now()),
        (${sqlLiteral(blockedPlanMonthId)}::uuid, 'Blocked preview focus', 1, now(), now());
      INSERT INTO goal_definitions
        (id, space_id, state, revision, created_at, updated_at, archived_at)
      VALUES
        (${sqlLiteral(monthlyDefinitionId)}::uuid, ${sqlLiteral(spaceId)}::uuid, 'active', 1, now(), now(), NULL),
        (${sqlLiteral(invalidDefinitionId)}::uuid, ${sqlLiteral(spaceId)}::uuid, 'active', 1, now(), now(), NULL);
      INSERT INTO goal_series (id, goal_definition_id, created_at) VALUES
        (${sqlLiteral(monthlySeriesId)}::uuid, ${sqlLiteral(monthlyDefinitionId)}::uuid, now()),
        (${sqlLiteral(invalidSeriesId)}::uuid, ${sqlLiteral(invalidDefinitionId)}::uuid, now());
      INSERT INTO goal_definition_versions
        (id, goal_definition_id, version_number, goal_series_id,
         series_decision, title, why, category, created_at)
      VALUES
        (${sqlLiteral(monthlyVersionId)}::uuid, ${sqlLiteral(monthlyDefinitionId)}::uuid, 1, ${sqlLiteral(monthlySeriesId)}::uuid, 'new', 'Monthly goal',
         'Exact P06', 'Test', now()),
        (${sqlLiteral(invalidVersionId)}::uuid, ${sqlLiteral(invalidDefinitionId)}::uuid, 1, ${sqlLiteral(invalidSeriesId)}::uuid, 'new', 'Invalid goal',
         'Exact blocker', 'Test', now());
      INSERT INTO plan_draft_goals
        (id, space_id, plan_month_id, goal_definition_id, display_order,
         current_revision_id, attached_at, detached_at, created_at, updated_at)
      VALUES
        (${sqlLiteral(monthlyPlanGoalId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(currentPlanMonthId)}::uuid, ${sqlLiteral(monthlyDefinitionId)}::uuid, 0, NULL,
         now(), NULL, now(), now()),
        (${sqlLiteral(invalidPlanGoalId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(currentPlanMonthId)}::uuid, ${sqlLiteral(invalidDefinitionId)}::uuid, 1, NULL,
         now(), NULL, now(), now());
      INSERT INTO plan_draft_goal_revisions
        (id, plan_goal_id, space_id, goal_definition_id, revision_number,
         goal_definition_version_id, goal_series_id, scope_kind,
         owner_member_id, config, source_provenance, created_at)
      VALUES
        (${sqlLiteral(monthlyRevisionId)}::uuid, ${sqlLiteral(monthlyPlanGoalId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(monthlyDefinitionId)}::uuid, 1,
         ${sqlLiteral(monthlyVersionId)}::uuid, ${sqlLiteral(monthlySeriesId)}::uuid, 'personal', ${sqlLiteral(memberId)}::uuid, ${sqlLiteral(monthlyConfig)}::jsonb,
         '{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"10","rawDenominator":"30","resolution":"P06"}'::jsonb, now()),
        (${sqlLiteral(invalidRevisionId)}::uuid, ${sqlLiteral(invalidPlanGoalId)}::uuid, ${sqlLiteral(spaceId)}::uuid, ${sqlLiteral(invalidDefinitionId)}::uuid, 1,
         ${sqlLiteral(invalidVersionId)}::uuid, ${sqlLiteral(invalidSeriesId)}::uuid, 'personal', NULL, ${sqlLiteral(invalidConfig)}::jsonb, NULL, now());
      UPDATE plan_draft_goals SET current_revision_id = ${sqlLiteral(monthlyRevisionId)}::uuid WHERE id = ${sqlLiteral(monthlyPlanGoalId)}::uuid;
      UPDATE plan_draft_goals SET current_revision_id = ${sqlLiteral(invalidRevisionId)}::uuid WHERE id = ${sqlLiteral(invalidPlanGoalId)}::uuid;
      `,
    )

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
    const firstSession = await issue.execute(userId, now)
    const secondSession = await issue.execute(secondUserId, now)
    const outsiderSession = await issue.execute(outsiderUserId, now)
    cookie = `planner-session=${firstSession.rawToken}`
    secondCookie = `planner-session=${secondSession.rawToken}`
    outsiderCookie = `planner-session=${outsiderSession.rawToken}`
    csrfToken = firstSession.csrfToken
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
      TELEGRAM_OIDC_CLIENT_SECRET: 'p06-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (postgresUnavailable) {
      await control.query(
        'ALTER DATABASE planner_p06_e2e WITH ALLOW_CONNECTIONS true',
      )
    }
    await runtime?.stop()
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await control?.end()
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

  function get(
    targetMonth: string,
    selectedCookie = cookie,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/planning/drafts/publication-preview?targetMonth=${targetMonth}`,
      { headers: { cookie: selectedCookie, ...headers } },
    )
  }

  async function state(): Promise<{
    readonly aggregate: Record<string, string>
    readonly planMonths: readonly Record<string, string>[]
    readonly drafts: readonly Record<string, string>[]
    readonly goalRoots: readonly Record<string, string>[]
    readonly goalRevisions: readonly Record<string, string>[]
    readonly definitions: readonly Record<string, string>[]
    readonly definitionVersions: readonly Record<string, string>[]
  }> {
    const aggregate = await admin.query<Record<string, string>>(
      `
      SELECT draft.revision::text draft_revision,
             draft.xmin::text draft_xmin,
             month.revision::text month_revision,
             month.xmin::text month_xmin,
             (SELECT count(*)::text FROM plan_draft_goals) roots,
             (SELECT count(*)::text FROM plan_draft_goal_revisions) revisions,
             (SELECT count(*)::text FROM planning_action_groups) actions,
             (SELECT count(*)::text FROM command_receipts) receipts
        FROM plan_drafts draft
        JOIN plan_months month ON month.id = draft.plan_month_id
       WHERE draft.plan_month_id = $1::uuid
      `,
      [currentPlanMonthId],
    )
    const planMonths = await admin.query<Record<string, string>>(
      `SELECT id::text id, space_id::text space_id, month_start::text month_start,
              status, revision::text revision, xmin::text xmin
         FROM plan_months
        WHERE space_id = $1::uuid
        ORDER BY month_start, id`,
      [spaceId],
    )
    const drafts = await admin.query<Record<string, string>>(
      `SELECT draft.plan_month_id::text plan_month_id, draft.focus,
              draft.revision::text revision, draft.xmin::text xmin
         FROM plan_drafts draft
         JOIN plan_months month ON month.id = draft.plan_month_id
        WHERE month.space_id = $1::uuid
        ORDER BY month.month_start, draft.plan_month_id`,
      [spaceId],
    )
    const goalRoots = await admin.query<Record<string, string>>(
      `SELECT id::text id, space_id::text space_id,
              plan_month_id::text plan_month_id,
              goal_definition_id::text goal_definition_id,
              display_order::text display_order,
              current_revision_id::text current_revision_id,
              attached_at::text attached_at,
              coalesce(detached_at::text, '') detached_at,
              created_at::text created_at, updated_at::text updated_at,
              xmin::text xmin
         FROM plan_draft_goals
        WHERE space_id = $1::uuid
        ORDER BY plan_month_id, display_order, id`,
      [spaceId],
    )
    const goalRevisions = await admin.query<Record<string, string>>(
      `SELECT revision.id::text id, revision.plan_goal_id::text plan_goal_id,
              revision.space_id::text space_id,
              revision.goal_definition_id::text goal_definition_id,
              revision.revision_number::text revision_number,
              revision.goal_definition_version_id::text goal_definition_version_id,
              revision.goal_series_id::text goal_series_id,
              revision.scope_kind, coalesce(revision.owner_member_id::text, '') owner_member_id,
              revision.config::text config,
              coalesce(revision.source_provenance::text, '') source_provenance,
              revision.created_at::text created_at,
              revision.xmin::text xmin
         FROM plan_draft_goal_revisions revision
         JOIN plan_draft_goals root ON root.current_revision_id = revision.id
        WHERE root.space_id = $1::uuid
        ORDER BY root.plan_month_id, root.display_order, revision.id`,
      [spaceId],
    )
    const definitions = await admin.query<Record<string, string>>(
      `SELECT DISTINCT definition.id::text id,
              definition.space_id::text space_id, definition.state,
              definition.revision::text revision,
              definition.created_at::text created_at,
              definition.updated_at::text updated_at,
              coalesce(definition.archived_at::text, '') archived_at,
              definition.xmin::text xmin
         FROM goal_definitions definition
         JOIN plan_draft_goals root
           ON root.goal_definition_id = definition.id
        WHERE root.space_id = $1::uuid
        ORDER BY id`,
      [spaceId],
    )
    const definitionVersions = await admin.query<Record<string, string>>(
      `SELECT DISTINCT version.id::text id,
              version.goal_definition_id::text goal_definition_id,
              version.version_number::text version_number,
              version.goal_series_id::text goal_series_id,
              version.series_decision, version.title, version.why,
              version.category, version.created_at::text created_at,
              version.xmin::text xmin
         FROM goal_definition_versions version
         JOIN plan_draft_goal_revisions revision
           ON revision.goal_definition_version_id = version.id
         JOIN plan_draft_goals root ON root.current_revision_id = revision.id
        WHERE root.space_id = $1::uuid
        ORDER BY id`,
      [spaceId],
    )
    return {
      aggregate: aggregate.rows[0]!,
      planMonths: planMonths.rows,
      drafts: drafts.rows,
      goalRoots: goalRoots.rows,
      goalRevisions: goalRevisions.rows,
      definitions: definitions.rows,
      definitionVersions: definitionVersions.rows,
    }
  }

  it('requires only a valid session and returns the same actor-free bytes for both members without writes', async () => {
    expect((await get(currentMonth, '')).status).toBe(401)
    const forbidden = await get(currentMonth, outsiderCookie)
    expect(forbidden.status).toBe(403)
    await expect(json(forbidden)).resolves.toMatchObject({
      code: 'PLANNING_AUTHORIZATION_DENIED',
    })
    const before = await state()
    const first = await get(currentMonth, cookie, {
      origin: 'https://untrusted.example',
      'x-csrf-token': 'not-required-for-safe-get',
    })
    const second = await get(currentMonth, secondCookie)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstText = await first.text()
    const secondText = await second.text()
    expect(secondText).toBe(firstText)
    const preview = JSON.parse(firstText) as Record<string, unknown>
    expect(preview).toMatchObject({
      schemaVersion: 'planner.publication-preview.v1',
      planMonthId: currentPlanMonthId,
      draftRevision: '7',
      planMonthRevision: '2',
      focus: 'Current preview focus',
      previewHashVersion: 'planner.publication-preview-hash.v1',
      formulaVersions: {
        calendarTargets: 'planner.calendar-targets.v1',
        goalEvaluation: 'planner.goal-evaluation.v1',
        scoreCoverage: 'planner.score-coverage.v1',
      },
    })
    expect(preview['previewHash']).toEqual(expect.any(String))
    expect(String(preview['previewHash'])).toMatch(/^[0-9a-f]{64}$/u)
    const goals = preview['goals'] as readonly Record<string, unknown>[]
    expect(goals[0]).toMatchObject({ planGoalId: monthlyPlanGoalId })
    expect(goals[1]).toMatchObject({
      blockers: [
        expect.objectContaining({ pointer: '/repetition/n' }) as unknown,
        expect.objectContaining({ pointer: '/scope/ownerMemberId' }) as unknown,
      ],
    })
    const targets = preview['calculatedTargets'] as readonly Record<
      string,
      unknown
    >[]
    expect(targets[0]).toMatchObject({ planGoalId: monthlyPlanGoalId })
    const repeat = await get(currentMonth)
    expect(repeat.status).toBe(200)
    expect(await repeat.text()).toBe(firstText)
    const blocked = await get(previousMonth)
    expect(blocked.status).toBe(200)
    expect(await state()).toEqual(before)
  })

  it('returns byte/hash stable repeat and a new hash after a real draft mutation', async () => {
    const beforeResponse = await get(currentMonth)
    const repeatResponse = await get(currentMonth)
    const beforeText = await beforeResponse.text()
    expect(await repeatResponse.text()).toBe(beforeText)
    const before = JSON.parse(beforeText) as Record<string, unknown>

    const mutation = await fetch(
      `${baseUrl}/planning/drafts/${currentPlanMonthId}/goals/${monthlyPlanGoalId}/update`,
      {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({
          commandId: randomUUID(),
          expectedRevision: '7',
          goalDefinitionVersionId: String(
            (before['goals'] as Record<string, unknown>[])[0]?.[
              'goalDefinitionVersionId'
            ],
          ),
          config: {
            schemaVersion: 1,
            scope: { kind: 'personal', ownerMemberId: memberId },
            repetition: { kind: 'monthly', n: '11' },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        }),
      },
    )
    expect(mutation.status).toBe(200)
    const changed = await json(await get(currentMonth))
    expect(changed['draftRevision']).toBe('8')
    expect(changed['previewHash']).not.toBe(before['previewHash'])
  })

  it('returns scheduled, blocked and finite request/draft problems', async () => {
    const scheduled = await json(await get(nextMonth))
    expect(scheduled).toMatchObject({
      planMonthId: nextPlanMonthId,
      activation: {
        mode: 'scheduled',
        activeLocalDate: `${nextMonth}-01`,
        latePublication: false,
      },
      blockers: [],
    })
    const blocked = await json(await get(previousMonth))
    expect(blocked).toMatchObject({
      planMonthId: blockedPlanMonthId,
      activation: {
        mode: 'blocked',
        activeLocalDate: `${previousMonth}-01`,
        latePublication: false,
      },
      blockers: [
        {
          planGoalId: null,
          pointer: '/targetMonth',
          code: 'incompatible',
          detail: 'Target month is not current or next.',
        },
      ],
    })
    expect((await get('0001-01')).status).toBe(404)
    expect((await get('not-a-month')).status).toBe(422)
    expect(
      (
        await fetch(`${baseUrl}/planning/drafts/publication-preview`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await fetch(
          `${baseUrl}/planning/drafts/publication-preview?targetMonth=${currentMonth}&extra=1`,
          { headers: { cookie } },
        )
      ).status,
    ).toBe(422)
  })

  it('publishes exact OpenAPI route security/status/query/response schemas', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<
        string,
        {
          get?: {
            security?: unknown
            parameters?: unknown
            responses?: Record<string, unknown>
          }
        }
      >
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    expect(
      Object.keys(document.paths)
        .filter((path) => path.startsWith('/planning/drafts'))
        .sort(),
    ).toContain('/planning/drafts/publication-preview')
    const operation =
      document.paths['/planning/drafts/publication-preview']?.get
    expect(operation?.security).toEqual([{ sessionCookie: [] }])
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '401',
      '403',
      '404',
      '409',
      '422',
      '503',
    ])
    expect(operation?.parameters).toEqual([
      {
        in: 'query',
        name: 'targetMonth',
        required: true,
        schema: {
          pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
          type: 'string',
        },
      },
    ])
    expect(
      document.components.schemas['PublicationPreviewResponseV1'],
    ).toMatchObject({
      additionalProperties: false,
      properties: {
        schemaVersion: {
          enum: ['planner.publication-preview.v1'],
          type: 'string',
        },
        previewHash: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        goals: {
          items: { $ref: '#/components/schemas/PublicationPreviewGoalV1' },
          type: 'array',
        },
        blockers: {
          items: { $ref: '#/components/schemas/PublicationPreviewBlockerV1' },
          type: 'array',
        },
      },
    })
  })

  it('maps live PostgreSQL loss to an exact value-free 503 and recovers', async () => {
    await control.query(
      'ALTER DATABASE planner_p06_e2e WITH ALLOW_CONNECTIONS false',
    )
    postgresUnavailable = true
    await control.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 'planner_p06_e2e' AND pid <> pg_backend_pid()
    `)
    try {
      const response = await get(currentMonth)
      expect(response.status).toBe(503)
      expect(response.headers.get('content-type')).toMatch(
        /^application\/problem\+json/u,
      )
      const problem = await json(response)
      const requestId = problem['requestId']
      const instance = problem['instance']
      expect(typeof requestId).toBe('string')
      expect(typeof instance).toBe('string')
      if (typeof requestId !== 'string' || typeof instance !== 'string') {
        throw new Error('Dependency Problem correlation fields are invalid')
      }
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(instance).toBe(`urn:request:${requestId}`)
      expect(problem).toEqual({
        type: 'https://planner.invalid/problems/dependency-unavailable',
        title: 'Dependency unavailable',
        status: 503,
        detail: 'A required service is temporarily unavailable.',
        instance,
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId,
      })
      expect(JSON.stringify(problem)).not.toMatch(
        /planner_p06_e2e|SELECT|targetMonth|Current preview focus/u,
      )
    } finally {
      await control.query(
        'ALTER DATABASE planner_p06_e2e WITH ALLOW_CONNECTIONS true',
      )
      postgresUnavailable = false
    }
    const recovered = await get(currentMonth)
    expect(recovered.status).toBe(200)
  })
})
