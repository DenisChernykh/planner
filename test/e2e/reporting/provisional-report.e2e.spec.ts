import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'
import OpenAPIResponseValidator, {
  type OpenAPIResponseValidatorArgs,
} from 'openapi-response-validator'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import {
  createPlanningApplication,
  createPlanningLifecycleWorker,
} from '@/modules/planning'
import { createReportingApplication } from '@/modules/reporting'
import { createTrackingApplication } from '@/modules/tracking'
import { PrismaDueLifecycleRepository } from '@/modules/planning/infrastructure/due-lifecycle.repository'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
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

describe('R02 provisional report HTTP read model', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let runtime: ApiRuntime
  let baseUrl: string
  let firstCookie: string
  let secondCookie: string
  let outsiderCookie: string
  let targetMonth: string
  let today: string
  let clock: FakeProductClock
  let closeWorker: ReturnType<typeof createPlanningLifecycleWorker>

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_r02_e2e')
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
    clock = new FakeProductClock(new Date(`${today}T07:00:00.000+05:00`))
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
    const reporting = createReportingApplication({
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
    if (preview === null) throw new Error('R02 preview missing')
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
    closeWorker = createPlanningLifecycleWorker({
      database: provider,
      transaction,
      lifecycle: new PrismaDueLifecycleRepository(provider),
      clock,
      closeMonthReport: reporting.buildCloseMonthReport,
    })
    const rows = await pool.query<{
      readonly id: string
      readonly measurement_kind: string
      readonly scope_kind: 'personal' | 'shared'
      readonly owner_member_id: string | null
      readonly expectation_date: string
      readonly component_kind: 'goal' | 'checkpoint' | 'checklist_item'
      readonly component_id: string | null
    }>(
      `SELECT snapshot.id::text id,
              snapshot.config->'measurement'->>'kind' measurement_kind,
              snapshot.scope_kind,
              snapshot.owner_member_id::text owner_member_id,
              expectation.expectation_date::text expectation_date,
              expectation.component_kind,
              expectation.component_id::text component_id
         FROM plan_goal_snapshots snapshot
         JOIN fixed_expectations expectation
           ON expectation.plan_goal_snapshot_id = snapshot.id
        WHERE snapshot.publication_id = $1::uuid
          AND expectation.expectation_date >= (
            SELECT active_local_date
              FROM plan_publications
             WHERE id = snapshot.publication_id
          )
          AND expectation.expectation_date <= $2::date
          AND (snapshot.scope_kind = 'shared' OR snapshot.owner_member_id = $3::uuid)
          AND snapshot.config->'measurement'->>'kind' IN ('quantity', 'actual_time', 'rating')
        ORDER BY snapshot.display_order, snapshot.id`,
      [publication.aggregateId, today, firstMemberId],
    )
    const quantity = rows.rows.find(
      (row) => row.measurement_kind === 'quantity',
    )
    const actualTime = rows.rows.find(
      (row) => row.measurement_kind === 'actual_time',
    )
    const rating = rows.rows.find((row) => row.measurement_kind === 'rating')
    if (
      quantity === undefined ||
      actualTime === undefined ||
      rating === undefined
    ) {
      throw new Error('Seed does not contain all R02 series fixtures')
    }
    try {
      await tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: quantity.id,
          localDate: quantity.expectation_date,
          value: { kind: 'quantity', value: '1200' },
        },
      })
    } catch (error) {
      throw new Error(
        `quantity fixture failed at ${quantity.expectation_date}`,
        { cause: error },
      )
    }
    try {
      await tracking.recordTime.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: actualTime.id,
          expectationDate: actualTime.expectation_date,
          value: '08:30',
        },
      })
    } catch (error) {
      throw new Error(
        `actual-time fixture failed at ${actualTime.expectation_date}`,
        { cause: error },
      )
    }
    try {
      if (rating.component_id === null) {
        await tracking.recordRating.execute({
          commandId: randomUUID(),
          trustedActor: actor,
          payload: {
            publicationId: publication.aggregateId,
            planGoalSnapshotId: rating.id,
            expectationDate: rating.expectation_date,
            value: 8,
          },
        })
      } else {
        await tracking.recordCheckpoint.execute({
          commandId: randomUUID(),
          trustedActor: actor,
          payload: {
            publicationId: publication.aggregateId,
            planGoalSnapshotId: rating.id,
            expectationDate: rating.expectation_date,
            checkpointId: rating.component_id,
            value: { kind: 'rating', value: 8 },
          },
        })
      }
    } catch (error) {
      throw new Error(`rating fixture failed at ${rating.expectation_date}`, {
        cause: error,
      })
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
    const issue = new IssueSessionUseCase(
      new PrismaLocalUserRepository(provider),
      new RedisSessionStore(
        connection.commandExecutor,
        new NodeAuthCryptoAdapter(),
        {
          keyPrefix: 'planner',
          sessionKeySecret,
          csrfSecret,
          idleTimeoutMs: 604_800_000,
          absoluteTimeoutMs: 2_592_000_000,
          touchIntervalMs: 300_000,
        },
      ),
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 93).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'r02-e2e-secret-long',
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
    ]) {
      delete process.env[key]
    }
  })

  it('publishes the protected report contract and keeps advanced analytics absent', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    const operation = document.paths['/reporting/months/{targetMonth}']?.[
      'get'
    ] as {
      security?: unknown
      responses?: Record<string, unknown>
      parameters?: readonly {
        readonly name?: string
        readonly schema?: { readonly pattern?: string }
      }[]
    }
    expect(operation.security).toEqual([{ sessionCookie: [] }])
    expect(operation.responses).toHaveProperty('200')
    expect(operation.responses).toHaveProperty('400')
    expect(
      operation.parameters?.find(
        (parameter) => parameter.name === 'targetMonth',
      )?.schema?.pattern,
    ).toBe(
      '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
    )
    expect(
      document.components.schemas['PilotReportReadResponseV1'],
    ).toBeDefined()
    const response = await fetch(`${baseUrl}/reporting/months/${targetMonth}`, {
      headers: { cookie: firstCookie },
    })
    expect(response.status).toBe(200)
    const value = await body(response)
    const responseValidator = new OpenAPIResponseValidator({
      responses: {
        200: (operation.responses?.['200'] ??
          {}) as OpenAPIResponseValidatorArgs['responses'][string],
      },
      components: document.components as unknown as NonNullable<
        OpenAPIResponseValidatorArgs['components']
      >,
    })
    expect(responseValidator.validateResponse(200, value)).toBeUndefined()
    expect(value).toMatchObject({
      schemaVersion: 'reporting.pilot-report-read.v1',
      status: 'current',
      source: { asOfLocalDate: today },
    })
    expect(JSON.stringify(value)).not.toMatch(
      /streak|forecast|correlation|comparison/iu,
    )
    const sections = value['sections'] as readonly Record<string, unknown>[]
    expect(sections).toHaveLength(3)
    const goals = sections.flatMap(
      (section) => section['goals'] as readonly Record<string, unknown>[],
    )
    expect(
      goals.some(
        (goal) =>
          (goal['series'] as Record<string, unknown>)['cumulativeQuantity'] !==
          null,
      ),
    ).toBe(true)
    expect(
      goals.some(
        (goal) =>
          (goal['series'] as Record<string, unknown>)['actualTime'] !== null,
      ),
    ).toBe(true)
    expect(
      goals.some(
        (goal) =>
          (goal['series'] as Record<string, unknown>)['rating'] !== null,
      ),
    ).toBe(true)
    expect(JSON.stringify(value)).toContain('1200')

    const invalid = structuredClone(value)
    const fixedGoal = sections
      .flatMap(
        (section) => section['goals'] as readonly Record<string, unknown>[],
      )
      .find((goal) => {
        const factTarget = goal['factTarget'] as Record<string, unknown>
        return Array.isArray(factTarget['units'])
      })
    if (fixedGoal === undefined) throw new Error('fixed goal missing')
    const invalidGoal = (invalid['sections'] as Record<string, unknown>[])
      .flatMap((section) => section['goals'] as Record<string, unknown>[])
      .find(
        (goal) =>
          goal['planGoalSnapshotId'] === fixedGoal['planGoalSnapshotId'],
      )
    if (invalidGoal === undefined) throw new Error('invalid fixed goal missing')
    const units = (invalidGoal['factTarget'] as Record<string, unknown>)[
      'units'
    ] as Record<string, unknown>[]
    const firstUnit = units[0]
    if (firstUnit === undefined) throw new Error('fixed unit missing')
    firstUnit['forecast'] = 1
    expect(responseValidator.validateResponse(200, invalid)).toBeDefined()

    const swapped = structuredClone(value)
    const timeGoal = (swapped['sections'] as Record<string, unknown>[])
      .flatMap((section) => section['goals'] as Record<string, unknown>[])
      .find((goal) => {
        const series = goal['series'] as Record<string, unknown>
        return Array.isArray(series['actualTime'])
      })
    if (timeGoal === undefined) throw new Error('actual-time goal missing')
    const timePoints = (timeGoal['series'] as Record<string, unknown>)[
      'actualTime'
    ] as Record<string, unknown>[]
    const firstTimePoint = timePoints[0]
    if (firstTimePoint === undefined)
      throw new Error('actual-time point missing')
    firstTimePoint['value'] = 830
    expect(responseValidator.validateResponse(200, swapped)).toBeDefined()
  })

  it('serves the immutable closed report after the worker catches up', async () => {
    const [yearToken, monthToken] = targetMonth.split('-')
    const year = Number(yearToken)
    const month = Number(monthToken)
    const nextMonthDate = new Date(Date.UTC(year, month, 1))
    const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(
      nextMonthDate.getUTCMonth() + 1,
    ).padStart(2, '0')}`
    clock.set(new Date(`${nextMonth}-04T07:00:00.000+05:00`))
    await closeWorker.tick()

    const response = await fetch(`${baseUrl}/reporting/months/${targetMonth}`, {
      headers: { cookie: firstCookie },
    })
    expect(response.status).toBe(200)
    const value = await body(response)
    expect(value).toMatchObject({
      schemaVersion: 'reporting.pilot-report-read.v1',
      status: 'closed',
    })
    const revisions = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count
         FROM report_revisions
        WHERE status = 'original'`,
    )
    expect(revisions.rows).toEqual([{ count: '1' }])
  })

  it('enforces session, month validation, membership and exact member separation', async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/reporting/months/${targetMonth}`,
    )
    expect(unauthenticated.status).toBe(401)
    expect(await body(unauthenticated)).toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    })
    const invalid = await fetch(`${baseUrl}/reporting/months/2035-13`, {
      headers: { cookie: firstCookie },
    })
    expect(invalid.status).toBe(400)
    expect(await body(invalid)).toMatchObject({
      code: 'REPORTING_QUERY_INVALID',
    })
    const outsider = await fetch(`${baseUrl}/reporting/months/${targetMonth}`, {
      headers: { cookie: outsiderCookie },
    })
    expect(outsider.status).toBe(403)
    expect(await body(outsider)).toMatchObject({
      code: 'REPORTING_AUTHORIZATION_DENIED',
    })
    const second = await fetch(`${baseUrl}/reporting/months/${targetMonth}`, {
      headers: { cookie: secondCookie },
    })
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(
      await (
        await fetch(`${baseUrl}/reporting/months/${targetMonth}`, {
          headers: { cookie: firstCookie },
        })
      ).text(),
    )
  })
})
