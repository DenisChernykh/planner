import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import OpenAPIResponseValidator from 'openapi-response-validator'
import { Pool } from 'pg'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import {
  createPlanningApplication,
  type DraftGoalConfigV1,
} from '@/modules/planning'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const outsiderUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const sessionKeySecret = Buffer.alloc(32, 91)
const csrfSecret = Buffer.alloc(32, 92)

type Session = { readonly cookie: string; readonly csrf: string }
type PublishedConfig = {
  readonly measurement: {
    readonly items?: readonly { readonly itemId: string }[]
    readonly variants?: readonly { readonly variantId: string }[]
  }
  readonly checkpoints: null | {
    readonly items: readonly { readonly checkpointId: string }[]
  }
}
type Fixture = {
  readonly publicationId: string
  readonly snapshots: Readonly<Record<string, string>>
  readonly checklistItems: Readonly<Record<string, string>>
  readonly variants: Readonly<Record<string, string>>
  readonly checkpoints: Readonly<Record<string, string>>
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

function ekbToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('H02 authenticated composite fact HTTP adapter', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let today: string
  let first: Session
  let second: Session
  let outsider: Session
  let fixture: Fixture

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_h02_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'), ('${secondUserId}'), ('${outsiderUserId}');
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}', 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2);
    `)
    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 10,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 1_000,
        transactionMaxWaitMs: 3_000,
        transactionTimeoutMs: 30_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(3_000))
    const transaction = new PrismaTransactionAdapter(
      provider,
      context,
      runtimeConfig,
    )
    const members = new PrismaWorkspaceMemberResolver(provider)
    today = ekbToday()
    const targetMonth = today.slice(0, 7)
    const clock = new FakeProductClock(new Date(`${today}T12:00:00.000+05:00`))
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth, focus: 'H02 composite HTTP' },
    })
    const checklist = (): readonly { itemId: null; label: string }[] => [
      { itemId: null, label: 'Первый пункт' },
      { itemId: null, label: 'Второй пункт' },
    ]
    const variants = (): readonly {
      variantId: null
      label: string
      unit: string
      precision: 0
      target: string
    }[] => [
      {
        variantId: null,
        label: 'Книги',
        unit: 'стр.',
        precision: 0,
        target: '10',
      },
      {
        variantId: null,
        label: 'Аудио',
        unit: 'мин.',
        precision: 0,
        target: '20',
      },
    ]
    const goals: readonly {
      readonly key: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        key: 'text-shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: null,
        },
      },
      {
        key: 'checklist-personal',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'checklist', items: checklist() },
          checkpoints: null,
        },
      },
      {
        key: 'or-personal',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'any_of', variants: variants() },
          checkpoints: null,
        },
      },
      {
        key: 'or-checkpoint-shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'any_of', variants: variants() },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Вечер',
                deadline: '22:00',
                satisfaction: { kind: 'any_of' },
              },
            ],
          },
        },
      },
      {
        key: 'flex-checklist-shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'weekly', n: '2' },
          measurement: { kind: 'checklist', items: checklist() },
          checkpoints: null,
        },
      },
      {
        key: 'flex-or-personal',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'weekly', n: '2' },
          measurement: { kind: 'any_of', variants: variants() },
          checkpoints: null,
        },
      },
      {
        key: 'partner-text',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: secondMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: null,
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: `H02 ${goals[index]!.key}`,
          why: 'HTTP composite contract',
          category: 'H02',
        },
      })
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: goals[index]!.config,
          sourceProvenance: null,
        },
      })
    }
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth,
    })
    if (preview === null) throw new Error('H02 publication preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const rows = await pool.query<{
      readonly id: string
      readonly title: string
      readonly config: PublishedConfig
    }>(
      `SELECT id::text, title, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    const snapshots: Record<string, string> = {}
    const checklistItems: Record<string, string> = {}
    const variantIds: Record<string, string> = {}
    const checkpoints: Record<string, string> = {}
    for (const row of rows.rows) {
      const key = row.title.slice('H02 '.length)
      snapshots[key] = row.id
      const itemId = row.config.measurement.items?.[0]?.itemId
      if (itemId !== undefined) checklistItems[key] = itemId
      const variantId = row.config.measurement.variants?.[0]?.variantId
      if (variantId !== undefined) variantIds[key] = variantId
      const checkpointId = row.config.checkpoints?.items[0]?.checkpointId
      if (checkpointId !== undefined) checkpoints[key] = checkpointId
    }
    fixture = {
      publicationId: publication.aggregateId,
      snapshots,
      checklistItems,
      variants: variantIds,
      checkpoints,
    }

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
    const [firstSession, secondSession, outsiderSession] = await Promise.all([
      issue.execute(firstUserId, Date.now()),
      issue.execute(secondUserId, Date.now()),
      issue.execute(outsiderUserId, Date.now()),
    ])
    first = {
      cookie: `planner-session=${firstSession.rawToken}`,
      csrf: firstSession.csrfToken,
    }
    second = {
      cookie: `planner-session=${secondSession.rawToken}`,
      csrf: secondSession.csrfToken,
    }
    outsider = {
      cookie: `planner-session=${outsiderSession.rawToken}`,
      csrf: outsiderSession.csrfToken,
    }
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 93).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'h02-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    await runtime?.stop()
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
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
    path: '/text' | '/checklist-item' | '/or-variant' | '/composite-occurrence',
    body: object,
    session: Session = first,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/tracking/facts${path}`, {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': session.csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  }

  function fixedTarget(key: string, commandId = randomUUID()): object {
    return {
      commandId,
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots[key],
      expectationDate: today,
      checkpointId: null,
    }
  }

  function occurrenceTarget(key: string, commandId = randomUUID()): object {
    return {
      commandId,
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots[key],
      localDate: today,
    }
  }

  it('publishes four exact CSRF-protected OpenAPI mutations', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    for (const path of [
      '/tracking/facts/text',
      '/tracking/facts/checklist-item',
      '/tracking/facts/or-variant',
      '/tracking/facts/composite-occurrence',
    ]) {
      const operation = document.paths[path]?.['post'] as {
        security?: unknown
        responses: Record<string, unknown>
        requestBody?: {
          content?: Record<string, { schema?: Record<string, unknown> }>
        }
      }
      expect(operation.security).toEqual([{ sessionCookie: [], csrfToken: [] }])
      expect(operation.responses).toHaveProperty('201')
      expect(
        operation.requestBody?.content?.['application/json']?.schema,
      ).toMatchObject({ type: 'object', additionalProperties: false })
      const validator = new OpenAPIResponseValidator({
        responses: operation.responses as never,
        components: document.components as never,
        customFormats: { uri: () => true, 'uri-reference': () => true },
      })
      for (const [status, response] of Object.entries(operation.responses)) {
        const examples = (
          response as {
            content?: Record<
              string,
              { examples?: Record<string, { value?: unknown }> }
            >
          }
        ).content?.['application/problem+json']?.examples
        for (const example of Object.values(examples ?? {})) {
          expect(
            validator.validateResponse(status, example.value),
          ).toBeUndefined()
        }
      }
    }
    const occurrence = (
      document.paths['/tracking/facts/composite-occurrence']?.['post'] as {
        requestBody: {
          content: Record<string, { schema: Record<string, unknown> }>
        }
      }
    ).requestBody.content['application/json']!.schema as {
      properties: { component: Record<string, unknown> }
    }
    expect(occurrence.properties.component).toMatchObject({
      discriminator: { propertyName: 'kind' },
      oneOf: [
        { $ref: '#/components/schemas/TrackingChecklistOccurrenceComponentV1' },
        { $ref: '#/components/schemas/TrackingOrOccurrenceComponentV1' },
      ],
    })
    expect(document.components.schemas).toMatchObject({
      TrackingChecklistOccurrenceComponentV1: {
        additionalProperties: false,
      },
      TrackingOrOccurrenceComponentV1: { additionalProperties: false },
    })
  })

  it('requires authentication and CSRF and rejects actor, revision and unknown nested fields', async () => {
    const text = {
      ...fixedTarget('text-shared'),
      text: 'Сделано',
      result: 'done',
    }
    expect(
      (await post('/text', text, { cookie: '', csrf: first.csrf })).status,
    ).toBe(401)
    expect(
      (await post('/text', text, first, { 'x-csrf-token': 'wrong' })).status,
    ).toBe(403)
    for (const invalid of [
      { ...text, actor: firstMemberId },
      { ...text, expectedRevision: '1' },
      { ...text, checkpointId: undefined },
    ]) {
      const response = await post('/text', invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    const nested = await post('/composite-occurrence', {
      ...occurrenceTarget('flex-checklist-shared'),
      component: {
        kind: 'checklist_item',
        checklistItemId: fixture.checklistItems['flex-checklist-shared'],
        state: 'done',
        unexpected: true,
      },
    })
    expect(nested.status).toBe(422)
    expect(await json(nested)).toMatchObject({ code: 'VALIDATION_FAILED' })
    const noMembership = await post('/text', text, outsider)
    expect(noMembership.status).toBe(403)
    expect(await json(noMembership)).toMatchObject({
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
  })

  it('records text, checklist, fixed/checkpoint OR and both flexible component variants', async () => {
    const textCommandId = randomUUID()
    const text = {
      ...fixedTarget('text-shared', textCommandId),
      text: 'Опубликован отчёт',
      result: 'done',
    }
    const cases: readonly [
      '/text' | '/checklist-item' | '/or-variant' | '/composite-occurrence',
      object,
      Session,
    ][] = [
      ['/text', text, second],
      [
        '/checklist-item',
        {
          ...fixedTarget('checklist-personal'),
          checklistItemId: fixture.checklistItems['checklist-personal'],
          state: 'done',
        },
        first,
      ],
      [
        '/or-variant',
        {
          ...fixedTarget('or-personal'),
          variantId: fixture.variants['or-personal'],
          value: '4',
        },
        first,
      ],
      [
        '/or-variant',
        {
          ...fixedTarget('or-checkpoint-shared'),
          checkpointId: fixture.checkpoints['or-checkpoint-shared'],
          variantId: fixture.variants['or-checkpoint-shared'],
          value: '10',
        },
        second,
      ],
      [
        '/composite-occurrence',
        {
          ...occurrenceTarget('flex-checklist-shared'),
          component: {
            kind: 'checklist_item',
            checklistItemId: fixture.checklistItems['flex-checklist-shared'],
            state: 'done',
          },
        },
        second,
      ],
      [
        '/composite-occurrence',
        {
          ...occurrenceTarget('flex-or-personal'),
          component: {
            kind: 'or_variant',
            variantId: fixture.variants['flex-or-personal'],
            value: '10',
          },
        },
        first,
      ],
    ]
    let textResponse: Record<string, unknown> | undefined
    for (const [path, body, session] of cases) {
      const response = await post(path, body, session)
      expect(response.status).toBe(201)
      const value = await json(response)
      expect(value).toMatchObject({
        kind: 'tracking.fact-record.v1',
        aggregateRevision: '1',
      })
      if (path === '/text') textResponse = value
    }
    const replay = await post('/text', text, second)
    expect(replay.status).toBe(201)
    expect(await json(replay)).toEqual(textResponse)
    const fingerprint = await post(
      '/text',
      { ...text, result: 'not_done' },
      second,
    )
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })

    const rows = await pool.query<{
      readonly fact_kind: string
      readonly count: string
    }>(
      `SELECT fact_kind, count(*)::text count
         FROM tracking_fact_records
        GROUP BY fact_kind
        ORDER BY fact_kind`,
    )
    expect(rows.rows).toEqual([
      { fact_kind: 'checklist_item', count: '2' },
      { fact_kind: 'or_variant', count: '3' },
      { fact_kind: 'text', count: '1' },
    ])
    const todayResponse = await fetch(`${baseUrl}/tracking/today`, {
      headers: { cookie: first.cookie },
    })
    expect(todayResponse.status).toBe(200)
    const todayBody = (await todayResponse.json()) as {
      day: {
        goals: readonly {
          planGoalSnapshotId: string
          state: string
          progress: { progress: { basisPoints?: string } }
          fixedExpectations: readonly { state: string }[]
        }[]
      }
    }
    expect(
      todayBody.day.goals.find(
        (goal) => goal.planGoalSnapshotId === fixture.snapshots['or-personal'],
      ),
    ).toMatchObject({
      state: 'filled',
      progress: { progress: { basisPoints: '4000' } },
      fixedExpectations: [{ state: 'partial' }],
    })
  })

  it('enforces personal ownership and conceals missing targets without writes', async () => {
    const before = await pool.query<{ records: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type LIKE 'tracking.record-%') receipts
    `)
    const denied = await post('/text', {
      ...fixedTarget('partner-text'),
      text: 'Чужая личная цель',
      result: 'done',
    })
    expect(denied.status).toBe(403)
    expect(await json(denied)).toMatchObject({
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
    const missing = await post('/or-variant', {
      ...fixedTarget('or-personal'),
      planGoalSnapshotId: randomUUID(),
      variantId: fixture.variants['or-personal'],
      value: '1',
    })
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({
      code: 'TRACKING_FACT_TARGET_NOT_FOUND',
    })
    const invalid = await post('/or-variant', {
      ...fixedTarget('or-personal'),
      commandId: randomUUID(),
      variantId: fixture.variants['or-personal'],
      value: '01',
    })
    expect(invalid.status).toBe(422)
    expect(await json(invalid)).toMatchObject({ code: 'VALIDATION_FAILED' })
    const after = await pool.query<{ records: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type LIKE 'tracking.record-%') receipts
    `)
    expect(after.rows[0]).toEqual(before.rows[0])
  })
})
