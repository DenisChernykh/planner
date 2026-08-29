import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const seededPlanMonthId = '66666666-6666-4666-8666-666666666666'
const sessionKeySecret = Buffer.alloc(32, 41)
const csrfSecret = Buffer.alloc(32, 42)

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

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('P03 authenticated typed draft-goal HTTP', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let cookie: string
  let csrfToken: string
  let definitionId: string
  let planMonthId: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_p03_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query(`
      INSERT INTO users (id) VALUES ('${userId}'), ('${secondUserId}');
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}', 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}', '${spaceId}', '${userId}', 1),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2);
      INSERT INTO plan_months
        (id, space_id, month_start, status, revision, created_at, updated_at)
      VALUES ('${seededPlanMonthId}', '${spaceId}', '2026-04-01', 'draft', 1,
              now(), now());
      INSERT INTO plan_drafts
        (plan_month_id, focus, revision, created_at, updated_at)
      VALUES ('${seededPlanMonthId}', 'P03 E2E', 1, now(), now());
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
    const session = await issue.execute(userId, Date.now())
    cookie = `planner-session=${session.rawToken}`
    csrfToken = session.csrfToken
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 43).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'p03-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()

    const catalog = await post('/planning/catalog/goal-definitions', {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Вода',
      why: 'Здоровье',
      category: 'Health',
    })
    definitionId = String((await body(catalog))['aggregateId'])
    planMonthId = seededPlanMonthId
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
    path: string,
    value: object,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
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

  function incompleteConfig(): object {
    return {
      schemaVersion: 1,
      scope: { kind: 'personal', ownerMemberId: null },
      repetition: { kind: 'weekly', n: null },
      measurement: {
        kind: 'quantity',
        mode: 'targeted',
        unit: null,
        precision: null,
        aggregation: null,
        target: null,
      },
      checkpoints: null,
    }
  }

  it('requires authentication for reads and conjunctive session/origin/csrf for mutations', async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/planning/drafts?targetMonth=2026-04`,
    )
    expect(unauthenticated.status).toBe(401)

    for (const headers of [
      { cookie: '' },
      { origin: 'https://evil.example' },
      { 'x-csrf-token': 'wrong' },
    ]) {
      const response = await post(
        `/planning/drafts/${planMonthId}/goals`,
        {
          commandId: randomCommandId(),
          expectedRevision: '1',
          goalDefinitionId: definitionId,
          config: incompleteConfig(),
          sourceProvenance: null,
        },
        headers,
      )
      expect(response.status).toBe(headers.cookie === '' ? 401 : 403)
    }
  })

  it('rejects a checkpoint target beyond its parent quantity precision as HTTP 422 with zero writes', async () => {
    const state = (): Promise<readonly Record<string, string>[]> =>
      admin
        .query<Record<string, string>>(
          `
          SELECT draft.revision::text draft_revision,
                 (SELECT count(*)::text FROM plan_draft_goals) roots,
                 (SELECT count(*)::text FROM plan_draft_goal_revisions) revisions,
                 (SELECT count(*)::text FROM planning_action_groups) actions,
                 (SELECT count(*)::text FROM command_receipts) receipts
            FROM plan_drafts draft
           WHERE draft.plan_month_id = '${planMonthId}'
        `,
        )
        .then(({ rows }) => rows)
    const before = await state()
    const response = await post(`/planning/drafts/${planMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '1',
      goalDefinitionId: definitionId,
      config: {
        schemaVersion: 1,
        scope: { kind: 'shared' },
        repetition: { kind: 'daily' },
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'л',
          precision: 0,
          aggregation: 'add',
          target: '2',
        },
        checkpoints: {
          aggregation: 'independent',
          items: [
            {
              checkpointId: null,
              name: 'Утро',
              deadline: '12:00',
              satisfaction: { kind: 'quantity', target: '1.5' },
            },
          ],
        },
      },
      sourceProvenance: null,
    })
    expect(response.status).toBe(422)
    expect(await body(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(state()).resolves.toEqual(before)
  })

  it('accepts only omitted or null add child IDs, then returns and updates required stored UUIDs', async () => {
    const childPlanMonthId = '77777777-7777-4777-8777-777777777777'
    await admin.query(`
      INSERT INTO plan_months
        (id, space_id, month_start, status, revision, created_at, updated_at)
      VALUES ('${childPlanMonthId}', '${spaceId}', '2026-05-01', 'draft', 1,
              now(), now());
      INSERT INTO plan_drafts
        (plan_month_id, focus, revision, created_at, updated_at)
      VALUES ('${childPlanMonthId}', 'P03 child IDs', 1, now(), now());
    `)
    const config = (withForgedId: boolean): object => ({
      schemaVersion: 1,
      scope: { kind: 'shared' },
      repetition: { kind: 'daily' },
      measurement: {
        kind: 'checklist',
        items: [
          {
            ...(withForgedId
              ? { itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
              : {}),
            label: 'omitted ID',
          },
          { itemId: null, label: 'null ID' },
        ],
      },
      checkpoints: {
        aggregation: 'independent',
        items: [
          {
            ...(withForgedId
              ? { checkpointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
              : {}),
            name: 'omitted checkpoint ID',
            deadline: '12:00',
            satisfaction: { kind: 'checklist' },
          },
          {
            checkpointId: null,
            name: 'null checkpoint ID',
            deadline: '18:00',
            satisfaction: { kind: 'checklist' },
          },
        ],
      },
    })
    const before = await admin.query(
      `SELECT count(*)::int count FROM plan_draft_goals
        WHERE plan_month_id = $1::uuid`,
      [childPlanMonthId],
    )
    const forged = await post(`/planning/drafts/${childPlanMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '1',
      goalDefinitionId: definitionId,
      config: config(true),
      sourceProvenance: null,
    })
    expect(forged.status).toBe(422)
    expect(await body(forged)).toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      admin.query(
        `SELECT count(*)::int count FROM plan_draft_goals
          WHERE plan_month_id = $1::uuid`,
        [childPlanMonthId],
      ),
    ).resolves.toEqual(before)

    const accepted = await post(`/planning/drafts/${childPlanMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '1',
      goalDefinitionId: definitionId,
      config: config(false),
      sourceProvenance: null,
    })
    expect(accepted.status).toBe(201)
    const read = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(
        `${baseUrl}/planning/drafts?targetMonth=2026-05`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(200)
      return body(response)
    }
    const initial = await read()
    const goal = (initial['goals'] as Array<Record<string, unknown>>)[0]!
    const stored = goal['config'] as {
      readonly measurement: {
        readonly kind: 'checklist'
        readonly items: readonly { readonly itemId: string }[]
      }
      readonly checkpoints: {
        readonly items: readonly { readonly checkpointId: string }[]
      }
    }
    const storedIds = [
      ...stored.measurement.items.map((item) => item.itemId),
      ...stored.checkpoints.items.map((item) => item.checkpointId),
    ]
    expect(storedIds).toHaveLength(4)
    expect(new Set(storedIds).size).toBe(4)
    for (const id of storedIds) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
    }

    const updatedConfig = {
      ...(goal['config'] as Record<string, unknown>),
      measurement: {
        kind: 'checklist',
        items: [
          { itemId: storedIds[0], label: 'retained ID' },
          { label: 'new omitted ID' },
        ],
      },
      checkpoints: {
        aggregation: 'independent',
        items: [
          {
            checkpointId: storedIds[2],
            name: 'retained checkpoint ID',
            deadline: '12:00',
            satisfaction: { kind: 'checklist' },
          },
          {
            checkpointId: null,
            name: 'new null checkpoint ID',
            deadline: '18:00',
            satisfaction: { kind: 'checklist' },
          },
        ],
      },
    }
    const updated = await post(
      `/planning/drafts/${childPlanMonthId}/goals/${String(goal['planGoalId'])}/update`,
      {
        commandId: randomCommandId(),
        expectedRevision: '2',
        goalDefinitionVersionId: String(goal['goalDefinitionVersionId']),
        config: updatedConfig,
        sourceProvenance: null,
      },
    )
    expect(updated.status).toBe(200)
    const after = await read()
    const afterGoal = (after['goals'] as Array<Record<string, unknown>>)[0]!
    const afterConfig = afterGoal['config'] as {
      readonly measurement: {
        readonly items: readonly { readonly itemId: string }[]
      }
      readonly checkpoints: {
        readonly items: readonly { readonly checkpointId: string }[]
      }
    }
    expect(afterConfig.measurement.items[0]?.itemId).toBe(storedIds[0])
    expect(afterConfig.checkpoints.items[0]?.checkpointId).toBe(storedIds[2])
    expect(afterConfig.measurement.items[1]?.itemId).not.toBe(storedIds[1])
    expect(afterConfig.checkpoints.items[1]?.checkpointId).not.toBe(
      storedIds[3],
    )

    const removed = await post(
      `/planning/drafts/${childPlanMonthId}/goals/${String(goal['planGoalId'])}/remove`,
      { commandId: randomCommandId(), expectedRevision: '3' },
    )
    expect(removed.status).toBe(200)
  })

  it('adds incomplete config as data blockers, then updates/reorders/removes with exact lossless views', async () => {
    const add = await post(`/planning/drafts/${planMonthId}/goals`, {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: '1',
      goalDefinitionId: definitionId,
      config: incompleteConfig(),
      sourceProvenance: {
        schemaVersion: 1,
        sourceDocument: 'monthly-plan-template',
        sourcePage: 1,
        rawValue: '2–3',
        rawDenominator: null,
        resolution: 'Выбрать N',
      },
    })
    expect(add.status).toBe(201)
    expect(await body(add)).toEqual({
      kind: 'planning.plan-draft.v1',
      aggregateId: planMonthId,
      aggregateRevision: '2',
    })

    const beforeDuplicate = await admin.query<Record<string, string>>(`
      SELECT draft.revision::text draft_revision,
             (SELECT count(*)::text FROM plan_draft_goals) roots,
             (SELECT count(*)::text FROM plan_draft_goal_revisions) revisions,
             (SELECT count(*)::text FROM planning_action_groups) actions,
             (SELECT count(*)::text FROM command_receipts) receipts
        FROM plan_drafts draft
       WHERE draft.plan_month_id = '${planMonthId}'
    `)
    const duplicate = await post(`/planning/drafts/${planMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '2',
      goalDefinitionId: definitionId,
      config: incompleteConfig(),
      sourceProvenance: null,
    })
    expect(duplicate.status).toBe(422)
    expect(await body(duplicate)).toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      admin.query<Record<string, string>>(`
        SELECT draft.revision::text draft_revision,
               (SELECT count(*)::text FROM plan_draft_goals) roots,
               (SELECT count(*)::text FROM plan_draft_goal_revisions) revisions,
               (SELECT count(*)::text FROM planning_action_groups) actions,
               (SELECT count(*)::text FROM command_receipts) receipts
          FROM plan_drafts draft
         WHERE draft.plan_month_id = '${planMonthId}'
      `),
    ).resolves.toEqual(beforeDuplicate)

    const read = await fetch(`${baseUrl}/planning/drafts?targetMonth=2026-04`, {
      headers: { cookie },
    })
    expect(read.status).toBe(200)
    const draft = await body(read)
    const goal = (draft['goals'] as Array<Record<string, unknown>>)[0]
    if (goal === undefined) throw new Error('missing P03 draft goal')
    const planGoalId = String(goal['planGoalId'])
    const goalDefinitionVersionId = String(goal['goalDefinitionVersionId'])
    const goalSeriesId = String(goal['goalSeriesId'])
    const expectedBlockers = [
      '/measurement/aggregation',
      '/measurement/precision',
      '/measurement/target',
      '/measurement/unit',
      '/repetition/n',
      '/scope/ownerMemberId',
    ].map((pointer) => ({
      planGoalId,
      pointer,
      code: 'required',
      detail: 'Required value is missing.',
    }))
    expect(draft).toEqual({
      planMonthId,
      spaceId,
      targetMonth: '2026-04',
      status: 'draft',
      focus: 'P03 E2E',
      planMonthRevision: '1',
      draftRevision: '2',
      goals: [
        {
          planGoalId,
          goalDefinitionId: definitionId,
          goalDefinitionVersionId,
          goalSeriesId,
          title: 'Вода',
          why: 'Здоровье',
          category: 'Health',
          displayOrder: 0,
          configRevision: '1',
          config: incompleteConfig(),
          sourceProvenance: {
            schemaVersion: 1,
            sourceDocument: 'monthly-plan-template',
            sourcePage: 1,
            rawValue: '2–3',
            rawDenominator: null,
            resolution: 'Выбрать N',
          },
          blockers: expectedBlockers,
        },
      ],
      blockers: expectedBlockers,
    })

    const mutationState = (): Promise<
      | {
          readonly draft_revision: string
          readonly config_revisions: number
          readonly update_receipts: number
        }
      | undefined
    > =>
      admin
        .query<{
          draft_revision: string
          config_revisions: number
          update_receipts: number
        }>(
          `SELECT draft.revision::text draft_revision,
                  (SELECT count(*)::int FROM plan_draft_goal_revisions)
                    config_revisions,
                  (SELECT count(*)::int FROM command_receipts
                    WHERE command_type = 'planning.update-draft-goal.v1')
                    update_receipts
             FROM plan_drafts draft
            WHERE draft.plan_month_id = $1::uuid`,
          [planMonthId],
        )
        .then(({ rows }) => rows[0])
    const beforeForgedId = await mutationState()
    const forgedId = await post(
      `/planning/drafts/${planMonthId}/goals/${planGoalId}/update`,
      {
        commandId: 'abababab-abab-4bab-8bab-abababababab',
        expectedRevision: '2',
        goalDefinitionVersionId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'checklist',
            items: [
              {
                itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                label: 'Forged child',
              },
            ],
          },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    )
    expect(forgedId.status).toBe(422)
    expect(await body(forgedId)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        {
          pointer: '/body',
          code: 'invalid_value',
          detail: 'Request body is invalid.',
        },
      ],
    })
    expect(await mutationState()).toEqual(beforeForgedId)

    const update = await post(
      `/planning/drafts/${planMonthId}/goals/${planGoalId}/update`,
      {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expectedRevision: '2',
        goalDefinitionVersionId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '1',
            taskText: 'Outreach',
          },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    )
    expect(update.status).toBe(200)
    expect(await body(update)).toEqual({
      kind: 'planning.plan-draft.v1',
      aggregateId: planMonthId,
      aggregateRevision: '3',
    })

    const reorder = await post(
      `/planning/drafts/${planMonthId}/goals/reorder`,
      {
        commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        expectedRevision: '3',
        orderedPlanGoalIds: [planGoalId],
      },
    )
    expect(reorder.status).toBe(200)

    const remove = await post(
      `/planning/drafts/${planMonthId}/goals/${planGoalId}/remove`,
      {
        commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        expectedRevision: '4',
      },
    )
    expect(remove.status).toBe(200)
    const empty = await fetch(
      `${baseUrl}/planning/drafts?targetMonth=2026-04`,
      { headers: { cookie } },
    )
    await expect(empty.json()).resolves.toMatchObject({
      draftRevision: '5',
      goals: [],
      blockers: [],
    })
  })

  it('rejects structural failures as value-free RFC 9457 with zero writes and exposes revision conflict extension', async () => {
    const before = await admin.query<{ count: number }>(
      'SELECT count(*)::int count FROM plan_draft_goals',
    )
    const invalid = await post(`/planning/drafts/${planMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '5',
      goalDefinitionId: definitionId,
      config: { ...incompleteConfig(), actorId: memberId },
      sourceProvenance: null,
    })
    expect(invalid.status).toBe(422)
    const invalidProblem = await body(invalid)
    const invalidInstanceMatcher: unknown =
      expect.stringMatching(/^urn:request:/u)
    const invalidRequestIdMatcher: unknown = expect.any(String)
    const invalidErrorsMatcher: unknown = expect.any(Array)
    expect(invalidProblem).toEqual({
      type: 'https://planner.invalid/problems/validation-failed',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'One or more request fields are invalid.',
      instance: invalidInstanceMatcher,
      requestId: invalidRequestIdMatcher,
      errors: invalidErrorsMatcher,
    })
    const after = await admin.query<{ count: number }>(
      'SELECT count(*)::int count FROM plan_draft_goals',
    )
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)

    const provenanceExtra = await post(
      `/planning/drafts/${planMonthId}/goals`,
      {
        commandId: randomCommandId(),
        expectedRevision: '5',
        goalDefinitionId: definitionId,
        config: incompleteConfig(),
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'monthly-plan-template',
          sourcePage: 1,
          rawValue: null,
          rawDenominator: null,
          resolution: 'P03',
          actorId: memberId,
        },
      },
    )
    expect(provenanceExtra.status).toBe(422)
    await expect(
      admin.query<{ count: number }>(
        'SELECT count(*)::int count FROM plan_draft_goals',
      ),
    ).resolves.toMatchObject({ rows: [{ count: before.rows[0]?.count }] })

    const exactProvenance = {
      schemaVersion: 1,
      sourceDocument: 'monthly-plan-template',
      sourcePage: 1,
      rawValue: null,
      rawDenominator: null,
      resolution: 'P03',
    }
    for (const [payload, pointer] of [
      [
        {
          commandId: randomCommandId(),
          expectedRevision: '5',
          goalDefinitionId: definitionId,
          config: incompleteConfig(),
        },
        '/sourceProvenance',
      ],
      [
        {
          commandId: randomCommandId(),
          expectedRevision: '5',
          goalDefinitionId: definitionId,
          config: incompleteConfig(),
          sourceProvenance: Object.fromEntries(
            Object.entries(exactProvenance).filter(
              ([key]) => key !== 'rawValue',
            ),
          ),
        },
        '/sourceProvenance/rawValue',
      ],
      [
        {
          commandId: randomCommandId(),
          expectedRevision: '5',
          goalDefinitionId: definitionId,
          config: incompleteConfig(),
          sourceProvenance: Object.fromEntries(
            Object.entries(exactProvenance).filter(
              ([key]) => key !== 'rawDenominator',
            ),
          ),
        },
        '/sourceProvenance/rawDenominator',
      ],
    ] as const) {
      const missing = await post(
        `/planning/drafts/${planMonthId}/goals`,
        payload,
      )
      expect(missing.status).toBe(422)
      expect(await body(missing)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [
          {
            pointer,
            code: 'invalid_type',
            detail: 'Field has an invalid type.',
          },
          {
            pointer,
            code: 'required',
            detail: 'Required field is missing.',
          },
        ],
      })
    }
    await expect(
      admin.query<{ count: number }>(
        'SELECT count(*)::int count FROM plan_draft_goals',
      ),
    ).resolves.toMatchObject({ rows: [{ count: before.rows[0]?.count }] })

    const stale = await post(`/planning/drafts/${planMonthId}/goals`, {
      commandId: randomCommandId(),
      expectedRevision: '1',
      goalDefinitionId: definitionId,
      config: incompleteConfig(),
      sourceProvenance: null,
    })
    expect(stale.status).toBe(409)
    const staleProblem = await body(stale)
    const staleInstanceMatcher: unknown =
      expect.stringMatching(/^urn:request:/u)
    const staleRequestIdMatcher: unknown = expect.any(String)
    expect(staleProblem).toEqual({
      type: 'https://planner.invalid/problems/draft-revision-conflict',
      title: 'Plan draft revision conflict',
      status: 409,
      code: 'DRAFT_REVISION_CONFLICT',
      detail: 'The plan draft changed before this request completed.',
      instance: staleInstanceMatcher,
      requestId: staleRequestIdMatcher,
      conflict: {
        expectedRevision: '1',
        currentRevision: '5',
        nextAction: 'reload-draft-and-retry',
      },
    })
  })

  it('commits exact nested OpenAPI discriminator mappings and request shapes', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    expect(
      Object.keys(document.paths)
        .filter((path) => path.startsWith('/planning/drafts'))
        .sort(),
    ).toEqual([
      '/planning/drafts',
      '/planning/drafts/empty',
      '/planning/drafts/from-publication',
      '/planning/drafts/from-seed',
      '/planning/drafts/publication-preview',
      '/planning/drafts/{planMonthId}/focus',
      '/planning/drafts/{planMonthId}/goals',
      '/planning/drafts/{planMonthId}/goals/reorder',
      '/planning/drafts/{planMonthId}/goals/{planGoalId}/remove',
      '/planning/drafts/{planMonthId}/goals/{planGoalId}/update',
      '/planning/drafts/{planMonthId}/publish',
    ])
    expect(document.components.schemas['AddDraftGoalMeasurementV1']).toEqual(
      expect.objectContaining({
        oneOf: [
          { $ref: '#/components/schemas/BooleanMeasurementV1' },
          { $ref: '#/components/schemas/QuantityMeasurementV1' },
          { $ref: '#/components/schemas/ActualTimeMeasurementV1' },
          { $ref: '#/components/schemas/RatingMeasurementV1' },
          { $ref: '#/components/schemas/TextMeasurementV1' },
          { $ref: '#/components/schemas/AddChecklistMeasurementV1' },
          { $ref: '#/components/schemas/AddAnyOfMeasurementV1' },
        ],
        discriminator: {
          propertyName: 'kind',
          mapping: {
            boolean: '#/components/schemas/BooleanMeasurementV1',
            quantity: '#/components/schemas/QuantityMeasurementV1',
            actual_time: '#/components/schemas/ActualTimeMeasurementV1',
            rating: '#/components/schemas/RatingMeasurementV1',
            text: '#/components/schemas/TextMeasurementV1',
            checklist: '#/components/schemas/AddChecklistMeasurementV1',
            any_of: '#/components/schemas/AddAnyOfMeasurementV1',
          },
        },
      }),
    )
    for (const name of [
      'BooleanMeasurementV1',
      'QuantityMeasurementV1',
      'ActualTimeMeasurementV1',
      'RatingMeasurementV1',
      'TextMeasurementV1',
      'AddChecklistMeasurementV1',
      'AddAnyOfMeasurementV1',
    ]) {
      expect(document.components.schemas[name]?.['additionalProperties']).toBe(
        false,
      )
    }
    expect(
      document.components.schemas['AddChecklistItemV1']?.['properties'],
    ).toMatchObject({ itemId: { enum: [null] } })
    expect(
      document.components.schemas['UpdateChecklistItemV1']?.['properties'],
    ).toMatchObject({ itemId: { type: 'string', nullable: true } })
    expect(
      document.components.schemas['StoredChecklistItemV1']?.['required'],
    ).toContain('itemId')
  })
})

function randomCommandId(): string {
  return randomUUID()
}
