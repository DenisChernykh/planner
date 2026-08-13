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
import { createPlanningApplication } from '@/modules/planning'
import { createTrackingApplication } from '@/modules/tracking'
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
const sessionKeySecret = Buffer.alloc(32, 71)
const csrfSecret = Buffer.alloc(32, 72)

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

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('T07 authenticated Today and Month HTTP read models', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let firstCookie: string
  let secondCookie: string
  let outsiderCookie: string
  let today: string
  let targetMonth: string
  let waterId: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_t07_e2e')
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
        poolMax: 8,
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
    targetMonth = today.slice(0, 7)
    const clock = new FakeProductClock(new Date(`${today}T07:00:00.000+05:00`))
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth, actorPersona: 'memberB' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth,
    })
    if (preview === null) throw new Error('Today preview missing')
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
    const snapshot = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid AND title = 'Вода 1200 мл'`,
      [publication.aggregateId],
    )
    waterId = snapshot.rows[0]!.id
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: {
        publicationId: publication.aggregateId,
        planGoalSnapshotId: waterId,
        localDate: today,
        value: { kind: 'quantity', value: '1200' },
      },
    })
    await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2035-05', focus: 'HTTP draft state' },
    })

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
      issue.execute(firstUserId, Date.now()),
      issue.execute(secondUserId, Date.now()),
      issue.execute(outsiderUserId, Date.now()),
    ])
    firstCookie = `planner-session=${first.rawToken}`
    secondCookie = `planner-session=${second.rawToken}`
    outsiderCookie = `planner-session=${outsider.rawToken}`

    const port = await reservePort()
    const origin = `http://127.0.0.1:${port}`
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
      TELEGRAM_OIDC_CLIENT_SECRET: 't07-e2e-secret-long',
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

  it('publishes exact GET-only OpenAPI contracts', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    const todayOperation = document.paths['/tracking/today']?.['get'] as {
      security?: unknown
      responses?: Record<string, unknown>
    }
    const monthOperation = document.paths['/tracking/months/{targetMonth}']?.[
      'get'
    ] as {
      security?: unknown
      responses?: Record<string, unknown>
      parameters?: readonly {
        readonly name?: string
        readonly schema?: { readonly pattern?: string }
      }[]
    }
    expect(todayOperation.security).toEqual([{ sessionCookie: [] }])
    expect(monthOperation.security).toEqual([{ sessionCookie: [] }])
    expect(todayOperation.responses).toHaveProperty('200')
    expect(monthOperation.responses).toHaveProperty('200')
    expect(monthOperation.responses).toHaveProperty('400')
    expect(
      monthOperation.parameters?.find(
        (parameter) => parameter.name === 'targetMonth',
      )?.schema?.pattern,
    ).toBe(
      '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
    )
    const schema = document.components.schemas['TrackingMonthResponseV1'] as {
      readonly discriminator?: { readonly propertyName?: string }
      readonly oneOf?: readonly { readonly $ref?: string }[]
    }
    expect(schema.discriminator).toEqual({ propertyName: 'state' })
    expect(schema.oneOf?.map((item) => item.$ref)).toEqual([
      '#/components/schemas/TrackingMonthNoPlanV1',
      '#/components/schemas/TrackingMonthDraftV1',
      '#/components/schemas/TrackingMonthPublishedV1',
    ])
    const flexibleSchema = document.components.schemas[
      'TrackingFlexiblePeriodV1'
    ] as {
      readonly required?: unknown
      readonly properties?: Record<string, unknown>
    }
    expect(Array.isArray(flexibleSchema.required)).toBe(true)
    expect(flexibleSchema.required).toContain('expectedProgress')
    expect(flexibleSchema.required).toContain('actualProgress')
    expect(flexibleSchema.properties).toHaveProperty('expectedProgress')
    expect(flexibleSchema.properties).toHaveProperty('actualProgress')
  })

  it('requires session, rejects malformed month and conceals no membership', async () => {
    const unauthenticated = await fetch(`${baseUrl}/tracking/today`)
    expect(unauthenticated.status).toBe(401)
    expect(await body(unauthenticated)).toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    })
    const invalid = await fetch(`${baseUrl}/tracking/months/2035-13`, {
      headers: { cookie: firstCookie },
    })
    expect(invalid.status).toBe(400)
    expect(await body(invalid)).toMatchObject({
      code: 'TRACKING_QUERY_INVALID',
    })
    const yearZero = await fetch(`${baseUrl}/tracking/months/0000-01`, {
      headers: { cookie: firstCookie },
    })
    expect(yearZero.status).toBe(400)
    expect(await body(yearZero)).toMatchObject({
      code: 'TRACKING_QUERY_INVALID',
    })
    const forbidden = await fetch(`${baseUrl}/tracking/today`, {
      headers: { cookie: outsiderCookie },
    })
    expect(forbidden.status).toBe(403)
    expect(await body(forbidden)).toMatchObject({
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
  })

  it('returns no-plan and draft variants with 200 and no CSRF header', async () => {
    const noPlan = await fetch(`${baseUrl}/tracking/months/2035-06`, {
      headers: { cookie: firstCookie },
    })
    expect(noPlan.status).toBe(200)
    expect(await body(noPlan)).toMatchObject({
      schemaVersion: 'tracking.month.v1',
      targetMonth: '2035-06',
      state: 'no_plan',
    })
    const draft = await fetch(`${baseUrl}/tracking/months/2035-05`, {
      headers: { cookie: firstCookie },
    })
    expect(draft.status).toBe(200)
    expect(await body(draft)).toMatchObject({
      schemaVersion: 'tracking.month.v1',
      targetMonth: '2035-05',
      state: 'draft',
      lifecycleRevision: '1',
      draftRevision: '1',
      focus: 'HTTP draft state',
    })
  })

  it('returns Today facts and member-relative access through real composition', async () => {
    const first = await fetch(`${baseUrl}/tracking/today`, {
      headers: { cookie: firstCookie },
    })
    expect(first.status).toBe(200)
    const firstBody = await body(first)
    expect(firstBody).toMatchObject({
      schemaVersion: 'tracking.today.v1',
      targetMonth,
      queryLocalDate: today,
      state: 'published',
      factsRevision: '1',
      day: { localDate: today },
    })
    const firstGoals = firstBody['goals'] as readonly Record<string, unknown>[]
    expect(firstGoals).toHaveLength(41)
    expect(
      firstGoals.find((goal) => goal['planGoalSnapshotId'] === waterId),
    ).toMatchObject({ viewerAccess: 'personal_owner' })
    expect(JSON.stringify(firstBody)).toContain('1200')

    const second = await fetch(`${baseUrl}/tracking/today`, {
      headers: { cookie: secondCookie },
    })
    expect(second.status).toBe(200)
    const secondBody = await body(second)
    const secondGoals = secondBody['goals'] as readonly Record<
      string,
      unknown
    >[]
    expect(
      secondGoals.find((goal) => goal['planGoalSnapshotId'] === waterId),
    ).toMatchObject({ viewerAccess: 'partner_read_only' })
    expect(JSON.stringify(secondBody)).toContain('1200')
  })
})
