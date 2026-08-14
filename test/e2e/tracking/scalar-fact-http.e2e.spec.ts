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
const sessionKeySecret = Buffer.alloc(32, 81)
const csrfSecret = Buffer.alloc(32, 82)

type Session = { readonly cookie: string; readonly csrf: string }
type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly snapshots: Readonly<Record<string, string>>
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

describe('H01 authenticated scalar fact HTTP adapter', () => {
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
        .withDatabase('planner_h01_e2e')
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
    const todayWeekday = (
      ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
    )[new Date(`${today}T00:00:00.000Z`).getUTCDay()]!
    const notEligibleWeekday = todayWeekday === 'mon' ? 'tue' : 'mon'
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
      payload: { targetMonth, focus: 'H01 scalar HTTP' },
    })
    const goals: readonly {
      readonly key: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        key: 'boolean',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        key: 'quantity-add',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'ml',
            precision: 0,
            aggregation: 'add',
            target: '1000',
          },
          checkpoints: null,
        },
      },
      {
        key: 'quantity-latest',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'steps',
            precision: 0,
            aggregation: 'latest',
            target: '7000',
          },
          checkpoints: null,
        },
      },
      {
        key: 'time',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'actual_time', start: '08:00', end: '09:00' },
          checkpoints: null,
        },
      },
      {
        key: 'rating-shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'rating', minimum: 1, maximum: 10 },
          checkpoints: null,
        },
      },
      {
        key: 'checkpoint-boolean',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Boolean checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'boolean' },
              },
            ],
          },
        },
      },
      {
        key: 'checkpoint-actual_time',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'actual_time', start: '08:00', end: '10:00' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Time checkpoint',
                deadline: '20:00',
                satisfaction: {
                  kind: 'actual_time',
                  start: '08:00',
                  end: '10:00',
                },
              },
            ],
          },
        },
      },
      {
        key: 'checkpoint-rating',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'rating', minimum: 1, maximum: 10 },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Rating checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'rating' },
              },
            ],
          },
        },
      },
      {
        key: 'partner-boolean',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: secondMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        key: 'not-applicable',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'weekdays', weekdays: [notEligibleWeekday] },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        key: 'foreign',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: `H01 ${goals[index]!.key}`,
          why: 'HTTP scalar contract',
          category: 'H01',
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
    if (preview === null) throw new Error('H01 publication preview missing')
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
      readonly config: {
        checkpoints: null | { items: { checkpointId: string }[] }
      }
    }>(
      `SELECT id::text, title, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    const snapshots: Record<string, string> = {}
    const checkpoints: Record<string, string> = {}
    for (const row of rows.rows) {
      const key = row.title.slice('H01 '.length)
      snapshots[key] = row.id
      const checkpointId = row.config.checkpoints?.items[0]?.checkpointId
      if (checkpointId !== undefined) checkpoints[key] = checkpointId
    }
    fixture = {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      snapshots,
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 83).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'h01-e2e-secret-long',
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
    path: '' | '/time' | '/rating' | '/checkpoint',
    value: object,
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
      body: JSON.stringify(value),
    })
  }

  function request(
    key: string,
    value: unknown,
    commandId = randomUUID(),
  ): Record<string, unknown> {
    return {
      commandId,
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots[key],
      localDate: today,
      value,
    }
  }

  async function forceMonthState(
    status: 'draft' | 'published' | 'closed',
    activePublicationId: string | null,
  ): Promise<void> {
    await withConstraintTriggersDisabled(
      `UPDATE plan_months
          SET status = $2,
              active_publication_id = $3::uuid
        WHERE id = $1::uuid`,
      [fixture.planMonthId, status, activePublicationId],
    )
  }

  async function withConstraintTriggersDisabled(
    query: string,
    values: readonly unknown[],
  ): Promise<void> {
    const client = await pool.connect()
    let reusable = false
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(query, [...values])
      await client.query('COMMIT')
      const role = await client.query<{ session_replication_role: string }>(
        'SHOW session_replication_role',
      )
      if (role.rows[0]?.session_replication_role !== 'origin') {
        throw new Error('PostgreSQL trigger role was not restored')
      }
      reusable = true
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release(!reusable)
    }
  }

  async function forcePublicationSpace(value: string): Promise<void> {
    await withConstraintTriggersDisabled(
      'UPDATE plan_publications SET space_id = $2::uuid WHERE id = $1::uuid',
      [fixture.publicationId, value],
    )
  }

  it('publishes four exact CSRF-protected OpenAPI mutations', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    for (const path of [
      '/tracking/facts',
      '/tracking/facts/time',
      '/tracking/facts/rating',
      '/tracking/facts/checkpoint',
    ]) {
      const operation = document.paths[path]?.['post'] as {
        security?: unknown
        responses?: Record<string, unknown>
        requestBody?: {
          content?: Record<string, { schema?: Record<string, unknown> }>
        }
      }
      expect(operation.security).toEqual([{ sessionCookie: [], csrfToken: [] }])
      expect(operation.responses).toHaveProperty('201')
      expect(
        operation.requestBody?.content?.['application/json']?.schema,
      ).toMatchObject({ type: 'object', additionalProperties: false })
    }
    const factSchema = (
      document.paths['/tracking/facts']?.['post'] as {
        requestBody: {
          content: Record<string, { schema: Record<string, unknown> }>
        }
      }
    ).requestBody.content['application/json']!.schema
    expect(factSchema).toMatchObject({
      required: [
        'commandId',
        'publicationId',
        'planGoalSnapshotId',
        'localDate',
        'value',
      ],
      properties: { expectedRevision: { pattern: '^[1-9][0-9]*$' } },
    })
    const timeSchema = (
      document.paths['/tracking/facts/time']?.['post'] as {
        requestBody: {
          content: Record<string, { schema: { properties?: unknown } }>
        }
      }
    ).requestBody.content['application/json']!.schema
    expect(timeSchema.properties).not.toHaveProperty('expectedRevision')
    expect(document.components.schemas).toHaveProperty(
      'TrackingFactMutationResponseV1Dto',
    )
    expect(
      document.components.schemas['TrackingFactMutationResponseV1Dto'],
    ).toMatchObject({ additionalProperties: false })

    for (const path of [
      '/tracking/facts',
      '/tracking/facts/time',
      '/tracking/facts/rating',
      '/tracking/facts/checkpoint',
    ]) {
      const operation = document.paths[path]?.['post'] as {
        responses: Record<
          string,
          {
            content?: Record<
              string,
              { examples?: Record<string, { value?: unknown }> }
            >
          }
        >
      }
      const validator = new OpenAPIResponseValidator({
        responses: operation.responses as never,
        components: document.components as never,
        customFormats: {
          uri: () => true,
          'uri-reference': () => true,
        },
      })
      for (const [status, response] of Object.entries(operation.responses)) {
        const examples =
          response.content?.['application/problem+json']?.examples ?? {}
        for (const example of Object.values(examples)) {
          expect(
            validator.validateResponse(status, example.value),
          ).toBeUndefined()
        }
      }
      expect(
        validator.validateResponse('201', {
          kind: 'tracking.fact-record.v1',
          aggregateId: '11111111-1111-4111-8111-111111111111',
          aggregateRevision: '1',
        }),
      ).toBeUndefined()
      expect(
        validator.validateResponse('201', {
          kind: 'tracking.fact-record.v1',
          aggregateId: '11111111-1111-4111-8111-111111111111',
          aggregateRevision: '1',
          unexpected: true,
        }),
      ).toBeDefined()
    }
  })

  it('requires authentication and CSRF and rejects actor, unknown and T02 revision fields', async () => {
    const value = request('boolean', { kind: 'boolean', result: 'done' })
    expect(
      (await post('', value, { cookie: '', csrf: first.csrf })).status,
    ).toBe(401)
    expect(
      (await post('', value, first, { 'x-csrf-token': 'wrong' })).status,
    ).toBe(403)
    for (const [path, invalid] of [
      ['', { ...value, actor: firstMemberId }],
      [
        '/time',
        {
          commandId: randomUUID(),
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots['time'],
          expectationDate: today,
          value: '08:30',
          expectedRevision: '1',
        },
      ],
    ] as const) {
      const response = await post(path, invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    const noMembership = await post('', value, outsider)
    expect(noMembership.status).toBe(403)
    expect(await json(noMembership)).toMatchObject({
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
  })

  it('records every scalar type and all checkpoint scalar variants', async () => {
    const cases: readonly [
      '' | '/time' | '/rating' | '/checkpoint',
      Record<string, unknown>,
      Session,
    ][] = [
      ['', request('boolean', { kind: 'boolean', result: 'done' }), first],
      ['', request('quantity-add', { kind: 'quantity', value: '400' }), first],
      ['', request('quantity-add', { kind: 'quantity', value: '600' }), first],
      [
        '',
        request('quantity-latest', { kind: 'quantity', value: '7000' }),
        first,
      ],
      [
        '/time',
        {
          commandId: randomUUID(),
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots['time'],
          expectationDate: today,
          value: '08:30',
        },
        first,
      ],
      [
        '/rating',
        {
          commandId: randomUUID(),
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots['rating-shared'],
          expectationDate: today,
          value: 8,
        },
        second,
      ],
      ...(
        [
          ['boolean', { kind: 'boolean', result: 'done' }],
          ['actual_time', { kind: 'actual_time', value: '09:00' }],
          ['rating', { kind: 'rating', value: 7 }],
        ] as const
      ).map(
        ([kind, value]): ['/checkpoint', Record<string, unknown>, Session] => [
          '/checkpoint',
          {
            commandId: randomUUID(),
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots[`checkpoint-${kind}`],
            expectationDate: today,
            checkpointId: fixture.checkpoints[`checkpoint-${kind}`],
            value,
          },
          first,
        ],
      ),
    ]
    for (const [path, value, session] of cases) {
      const response = await post(path, value, session)
      expect(response.status).toBe(201)
      expect(await json(response)).toMatchObject({
        kind: 'tracking.fact-record.v1',
        aggregateRevision: '1',
      })
    }
    const counts = await pool.query<{ records: string; revisions: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions
    `)
    expect(counts.rows[0]).toEqual({ records: '9', revisions: '9' })
  })

  it('preserves replay and maps fingerprint, stale, correction, ownership and target failures without writes', async () => {
    const commandId = randomUUID()
    const original = request(
      'partner-boolean',
      { kind: 'boolean', result: 'done' },
      commandId,
    )
    const stale = await post(
      '',
      { ...original, commandId: randomUUID(), expectedRevision: '1' },
      second,
    )
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({
      code: 'TRACKING_FACT_REVISION_CONFLICT',
      conflict: { expectedRevision: '1', currentRevision: null },
    })
    const created = await post('', original, second)
    expect(created.status).toBe(201)
    const createdBody = await json(created)
    const replay = await post('', original, second)
    expect(replay.status).toBe(201)
    expect(await json(replay)).toEqual(createdBody)
    const fingerprint = await post(
      '',
      { ...original, value: { kind: 'boolean', result: 'not_done' } },
      second,
    )
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
    const partnerDenied = await post(
      '',
      { ...original, commandId: randomUUID() },
      first,
    )
    expect(partnerDenied.status).toBe(403)
    const correction = await post('', {
      ...request('quantity-latest', { kind: 'quantity', value: '6000' }),
    })
    expect(correction.status).toBe(409)
    expect(await json(correction)).toMatchObject({
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'correction_required' },
    })
    const missing = await post('', {
      ...request('boolean', { kind: 'boolean', result: 'done' }),
      commandId: randomUUID(),
      planGoalSnapshotId: randomUUID(),
    })
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({
      code: 'TRACKING_FACT_TARGET_NOT_FOUND',
    })
    const invalid = await post('/rating', {
      commandId: randomUUID(),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots['rating-shared'],
      expectationDate: today,
      value: 11,
    })
    expect(invalid.status).toBe(422)
    expect(await json(invalid)).toMatchObject({
      code: 'TRACKING_FACT_VALUE_INVALID',
    })
    const counts = await pool.query<{ records: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type LIKE 'tracking.record-%') receipts
    `)
    expect(counts.rows[0]).toEqual({ records: '10', receipts: '10' })
  })

  it('maps future, calendar, lifecycle and concealed foreign targets with zero writes', async () => {
    const before = await pool.query<{ records: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type LIKE 'tracking.record-%') receipts
    `)
    const tomorrow = new Date(`${today}T00:00:00.000Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const future = await post('', {
      ...request('foreign', { kind: 'boolean', result: 'done' }),
      commandId: randomUUID(),
      localDate: tomorrow.toISOString().slice(0, 10),
    })
    expect(future.status).toBe(409)
    expect(await json(future)).toMatchObject({
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'future_date' },
    })
    const notApplicable = await post(
      '',
      request('not-applicable', { kind: 'boolean', result: 'done' }),
    )
    expect(notApplicable.status).toBe(409)
    expect(await json(notApplicable)).toMatchObject({
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'not_applicable' },
    })

    await forceMonthState('draft', null)
    try {
      const inactive = await post(
        '',
        request('foreign', { kind: 'boolean', result: 'done' }),
      )
      expect(inactive.status).toBe(409)
      expect(await json(inactive)).toMatchObject({
        code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
        conflict: { reason: 'not_active' },
      })
    } finally {
      await forceMonthState('published', fixture.publicationId)
    }

    await forceMonthState('closed', fixture.publicationId)
    try {
      const closed = await post(
        '',
        request('foreign', { kind: 'boolean', result: 'done' }),
      )
      expect(closed.status).toBe(409)
      expect(await json(closed)).toMatchObject({
        code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
        conflict: { reason: 'closed' },
      })
    } finally {
      await forceMonthState('published', fixture.publicationId)
    }

    await forcePublicationSpace(randomUUID())
    try {
      const foreign = await post(
        '',
        request('foreign', { kind: 'boolean', result: 'done' }),
      )
      expect(foreign.status).toBe(404)
      expect(await json(foreign)).toMatchObject({
        code: 'TRACKING_FACT_TARGET_NOT_FOUND',
      })
    } finally {
      await forcePublicationSpace(spaceId)
    }
    const after = await pool.query<{ records: string; receipts: string }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type LIKE 'tracking.record-%') receipts
    `)
    expect(after.rows[0]).toEqual(before.rows[0])
  })
})
