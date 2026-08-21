import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

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
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
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

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

async function insertTerminalAttempt(input: {
  readonly pool: Pool
  readonly scheduleId: string
  readonly memberId: string
  readonly publicationId: string
  readonly localDate: string
  readonly slotKind: 'morning' | 'day' | 'evening'
  readonly outcome: 'accepted' | 'retryable' | 'terminal' | 'ambiguous'
  readonly outcomeReason: string | null
  readonly completedAt: string
}): Promise<void> {
  const occurrenceId = randomUUID()
  const intentId = randomUUID()
  const completedAt = new Date(input.completedAt)
  const startedAt = new Date(completedAt.getTime() - 1_000)
  const expiresAt = new Date(completedAt.getTime() + 60 * 60 * 1_000)
  const attemptId = randomUUID()
  const contentHash = randomUUID().replaceAll('-', '').padEnd(64, 'a')
  const client = await input.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO reminder_occurrences
         (id, space_id, recipient_member_id, schedule_id, local_date, slot_kind,
          schedule_revision, due_at, expires_at, state, fencing_token,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6,
               1, $7, $8, 'expired', 0, $9, $9)`,
      [
        occurrenceId,
        spaceId,
        input.memberId,
        input.scheduleId,
        input.localDate,
        input.slotKind,
        startedAt,
        expiresAt,
        startedAt,
      ],
    )
    await client.query(
      `INSERT INTO notification_intents
         (id, occurrence_id, space_id, recipient_member_id, publication_id,
          local_date, slot_kind, source_facts_revision, intent_revision,
          content_schema_version, content, content_hash, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date,
               $7, 0, 1, 'reminders.rendered-content.v1', '{}'::jsonb,
               $8, $9, $10)`,
      [
        intentId,
        occurrenceId,
        spaceId,
        input.memberId,
        input.publicationId,
        input.localDate,
        input.slotKind,
        contentHash,
        expiresAt,
        startedAt,
      ],
    )
    await client.query(
      `INSERT INTO notification_attempts
         (id, intent_id, occurrence_id, space_id, recipient_member_id,
          attempt_number, state, fencing_token, outcome, outcome_reason,
          provider_retry_after_sec, started_at, completed_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               1, 'terminal', 0, $6, $7,
               CASE WHEN $6 = 'retryable' THEN 1 ELSE NULL END,
               $8, $9, $8, $9)`,
      [
        attemptId,
        intentId,
        occurrenceId,
        spaceId,
        input.memberId,
        input.outcome,
        input.outcomeReason,
        startedAt,
        completedAt,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

describe('N04 reminder settings and delivery status HTTP adapter', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let postgresControl: Pool
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
  let publicationId: string
  let postgresUnavailable = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_n04_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const controlUrl = new URL(postgres.getConnectionUri())
    controlUrl.pathname = '/postgres'
    postgresControl = new Pool({ connectionString: controlUrl.toString() })
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
    const transactionContext = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, transactionContext)
    await provider.connect(AbortSignal.timeout(3_000))

    const transaction = new PrismaTransactionAdapter(
      provider,
      transactionContext,
      runtimeConfig,
    )
    const members = new PrismaWorkspaceMemberResolver(provider)
    const today = ekbToday()
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock: new FakeProductClock(new Date(`${today}T07:00:00.000+05:00`)),
    })
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      payload: { targetMonth: today.slice(0, 7), focus: 'N04 status fixture' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: today.slice(0, 7),
    })
    if (preview === null) throw new Error('N04 publication preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    publicationId = publication.aggregateId

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
    firstCsrf = first.csrfToken
    secondCookie = `planner-session=${second.rawToken}`
    secondCsrf = second.csrfToken
    outsiderCookie = `planner-session=${outsider.rawToken}`

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
      TELEGRAM_OIDC_CLIENT_SECRET: 'n04-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (postgresUnavailable) {
      await postgresControl
        ?.query('ALTER DATABASE planner_n04_e2e WITH ALLOW_CONNECTIONS true')
        .catch(() => undefined)
    }
    await runtime?.stop()
    await issuerRedis?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
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

  it('returns isolated defaults and an available status for both members', async () => {
    const [firstSettings, secondSettings, firstStatus] = await Promise.all([
      fetch(`${baseUrl}/reminders/settings`, {
        headers: { cookie: firstCookie },
      }),
      fetch(`${baseUrl}/reminders/settings`, {
        headers: { cookie: secondCookie },
      }),
      fetch(`${baseUrl}/reminders/delivery-status`, {
        headers: { cookie: firstCookie },
      }),
    ])
    expect(firstSettings.status).toBe(200)
    expect(secondSettings.status).toBe(200)
    expect(firstStatus.status).toBe(200)
    await expect(firstSettings.json()).resolves.toEqual({
      schemaVersion: 'reminders.settings.v1',
      scheduleId: null,
      revision: null,
      timeZone: 'Asia/Yekaterinburg',
      morning: null,
      day: null,
      evening: null,
    })
    await expect(secondSettings.json()).resolves.toEqual({
      schemaVersion: 'reminders.settings.v1',
      scheduleId: null,
      revision: null,
      timeZone: 'Asia/Yekaterinburg',
      morning: null,
      day: null,
      evening: null,
    })
    await expect(firstStatus.json()).resolves.toEqual({
      schemaVersion: 'reminders.delivery-status.v1',
      status: 'available',
    })
  })

  it('creates, replays and CAS-updates only the current member schedule', async () => {
    const createBody = {
      commandId: '61111111-1111-4111-8111-111111111111',
      timeZone: 'Asia/Yekaterinburg',
      morning: '08:00',
      day: '13:00',
      evening: null,
    }
    const create = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify(createBody),
    })
    expect(create.status).toBe(201)
    const created = await json(create)
    expect(created).toMatchObject({
      kind: 'reminders.schedule.v1',
      aggregateRevision: '1',
    })

    const replay = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify(createBody),
    })
    expect(replay.status).toBe(201)
    await expect(replay.json()).resolves.toEqual(created)

    const current = await fetch(`${baseUrl}/reminders/settings`, {
      headers: { cookie: firstCookie },
    })
    await expect(current.json()).resolves.toMatchObject({
      revision: '1',
      morning: '08:00',
      day: '13:00',
      evening: null,
    })

    const update = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify({
        ...createBody,
        commandId: '62222222-2222-4222-8222-222222222222',
        expectedRevision: '1',
        morning: null,
        day: '12:00',
        evening: '20:00',
      }),
    })
    expect(update.status).toBe(201)
    await expect(update.json()).resolves.toMatchObject({
      aggregateRevision: '2',
    })

    const partner = await fetch(`${baseUrl}/reminders/settings`, {
      headers: { cookie: secondCookie },
    })
    await expect(partner.json()).resolves.toEqual({
      schemaVersion: 'reminders.settings.v1',
      scheduleId: null,
      revision: null,
      timeZone: 'Asia/Yekaterinburg',
      morning: null,
      day: null,
      evening: null,
    })

    const stale = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: firstCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': firstCsrf,
      },
      body: JSON.stringify({
        ...createBody,
        commandId: '63333333-3333-4333-8333-333333333333',
        expectedRevision: '1',
        morning: '09:00',
        day: '14:00',
        evening: null,
      }),
    })
    expect(stale.status).toBe(409)
    await expect(json(stale)).resolves.toMatchObject({
      code: 'REMINDER_SCHEDULE_REVISION_CONFLICT',
      conflict: {
        expectedRevision: '1',
        currentRevision: '2',
        nextAction: 'reload-reminder-settings-and-retry',
      },
    })
  })

  it('rejects invalid ordering/timezone and enforces session and CSRF', async () => {
    const invalidOrder = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: secondCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({
        commandId: '64444444-4444-4444-8444-444444444444',
        timeZone: 'Asia/Yekaterinburg',
        morning: '18:00',
        day: '09:00',
        evening: null,
      }),
    })
    expect(invalidOrder.status).toBe(422)
    await expect(json(invalidOrder)).resolves.toMatchObject({
      code: 'VALIDATION_FAILED',
    })

    const invalidZone = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: secondCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({
        commandId: '65555555-5555-4555-8555-555555555555',
        timeZone: 'UTC',
        morning: null,
        day: null,
        evening: null,
      }),
    })
    expect(invalidZone.status).toBe(422)

    const nullExpectedRevision = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: secondCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({
        commandId: '68888888-8888-4888-8888-888888888888',
        expectedRevision: null,
        timeZone: 'Asia/Yekaterinburg',
        morning: null,
        day: null,
        evening: null,
      }),
    })
    expect(nullExpectedRevision.status).toBe(422)
    await expect(json(nullExpectedRevision)).resolves.toMatchObject({
      code: 'VALIDATION_FAILED',
    })

    const noSession = await fetch(`${baseUrl}/reminders/settings`)
    expect(noSession.status).toBe(401)

    const foreign = await fetch(`${baseUrl}/reminders/settings`, {
      headers: { cookie: outsiderCookie },
    })
    expect(foreign.status).toBe(403)

    const noCsrf = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: secondCookie,
        origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commandId: '66666666-6666-4666-8666-666666666666',
        timeZone: 'Asia/Yekaterinburg',
        morning: null,
        day: null,
        evening: null,
      }),
    })
    expect(noCsrf.status).toBe(403)
  })

  it('projects terminal outcomes by member and ignores local expiry/supersession', async () => {
    const firstSchedule = await pool.query<{ readonly id: string }>(
      'SELECT id::text FROM reminder_schedules WHERE member_id = $1::uuid',
      [firstMemberId],
    )
    const firstScheduleId = firstSchedule.rows[0]?.id
    if (firstScheduleId === undefined) throw new Error('first schedule missing')

    const status = async (): Promise<Record<string, unknown>> =>
      json(
        await fetch(`${baseUrl}/reminders/delivery-status`, {
          headers: { cookie: firstCookie },
        }),
      )

    await insertTerminalAttempt({
      pool,
      scheduleId: firstScheduleId,
      memberId: firstMemberId,
      publicationId,
      localDate: '2030-01-01',
      slotKind: 'morning',
      outcome: 'terminal',
      outcomeReason: 'blocked',
      completedAt: '2030-01-01T00:00:00.000Z',
    })
    await expect(status()).resolves.toMatchObject({ status: 'blocked' })

    await insertTerminalAttempt({
      pool,
      scheduleId: firstScheduleId,
      memberId: firstMemberId,
      publicationId,
      localDate: '2030-01-02',
      slotKind: 'day',
      outcome: 'terminal',
      outcomeReason: 'expired',
      completedAt: '2030-01-02T00:00:00.000Z',
    })
    await expect(status()).resolves.toMatchObject({ status: 'blocked' })

    await insertTerminalAttempt({
      pool,
      scheduleId: firstScheduleId,
      memberId: firstMemberId,
      publicationId,
      localDate: '2030-01-02',
      slotKind: 'evening',
      outcome: 'terminal',
      outcomeReason: 'superseded',
      completedAt: '2030-01-02T01:00:00.000Z',
    })
    await expect(status()).resolves.toMatchObject({ status: 'blocked' })

    const outcomes: readonly (readonly [
      'retryable' | 'ambiguous' | 'terminal',
      string,
    ])[] = [
      ['retryable', 'provider_error'],
      ['ambiguous', 'timeout'],
      ['terminal', 'provider_rejected'],
    ]
    for (const [index, [outcome, outcomeReason]] of outcomes.entries()) {
      await insertTerminalAttempt({
        pool,
        scheduleId: firstScheduleId,
        memberId: firstMemberId,
        publicationId,
        localDate: `2030-01-${String(index + 3).padStart(2, '0')}`,
        slotKind: 'evening',
        outcome,
        outcomeReason,
        completedAt: `2030-01-0${index + 3}T00:00:00.000Z`,
      })
      await expect(status()).resolves.toMatchObject({
        status: 'connection_lost',
      })
    }

    await insertTerminalAttempt({
      pool,
      scheduleId: firstScheduleId,
      memberId: firstMemberId,
      publicationId,
      localDate: '2030-01-06',
      slotKind: 'morning',
      outcome: 'accepted',
      outcomeReason: null,
      completedAt: '2030-01-06T00:00:00.000Z',
    })
    await expect(status()).resolves.toMatchObject({ status: 'available' })

    const createPartnerSchedule = await fetch(`${baseUrl}/reminders/settings`, {
      method: 'POST',
      headers: {
        cookie: secondCookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': secondCsrf,
      },
      body: JSON.stringify({
        commandId: '67777777-7777-4777-8777-777777777777',
        timeZone: 'Asia/Yekaterinburg',
        morning: null,
        day: null,
        evening: null,
      }),
    })
    expect(createPartnerSchedule.status).toBe(201)
    const secondSchedule = await pool.query<{ readonly id: string }>(
      'SELECT id::text FROM reminder_schedules WHERE member_id = $1::uuid',
      [secondMemberId],
    )
    const secondScheduleId = secondSchedule.rows[0]?.id
    if (secondScheduleId === undefined)
      throw new Error('second schedule missing')
    await insertTerminalAttempt({
      pool,
      scheduleId: secondScheduleId,
      memberId: secondMemberId,
      publicationId,
      localDate: '2030-01-07',
      slotKind: 'day',
      outcome: 'terminal',
      outcomeReason: 'chat_not_found',
      completedAt: '2030-01-07T00:00:00.000Z',
    })
    await expect(
      json(
        await fetch(`${baseUrl}/reminders/delivery-status`, {
          headers: { cookie: secondCookie },
        }),
      ),
    ).resolves.toMatchObject({ status: 'blocked' })
    await expect(status()).resolves.toMatchObject({ status: 'available' })
  })

  it('publishes the N04 OpenAPI surface and maps PostgreSQL loss to 503', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      readonly paths: Record<string, Record<string, unknown>>
      readonly components: { readonly schemas: Record<string, unknown> }
    }
    type Operation = {
      readonly requestBody?: {
        readonly content?: Readonly<
          Record<string, { readonly schema?: unknown }>
        >
      }
      readonly responses?: Readonly<
        Record<
          string,
          {
            readonly content?: Readonly<
              Record<string, { readonly schema?: unknown }>
            >
          }
        >
      >
      readonly security?: unknown
    }
    const operation = (path: string, method: 'get' | 'post'): Operation => {
      const value = document.paths[path]?.[method]
      if (value === undefined) throw new Error(`${method} ${path} is missing`)
      return value as Operation
    }
    const responseSchema = (
      value: Operation,
      status: string,
      mediaType = 'application/json',
    ): unknown => value.responses?.[status]?.content?.[mediaType]?.schema

    const settingsGet = operation('/reminders/settings', 'get')
    const settingsPost = operation('/reminders/settings', 'post')
    const deliveryStatusGet = operation('/reminders/delivery-status', 'get')
    expect(responseSchema(settingsGet, '200')).toEqual({
      $ref: '#/components/schemas/ReminderSettingsResponseV1',
    })
    expect(responseSchema(settingsPost, '201')).toEqual({
      $ref: '#/components/schemas/ReminderScheduleMutationResponseV1',
    })
    expect(responseSchema(deliveryStatusGet, '200')).toEqual({
      $ref: '#/components/schemas/ReminderDeliveryStatusResponseV1',
    })

    const settingsBody = settingsPost.requestBody?.content?.['application/json']
      ?.schema as
      | {
          readonly required?: readonly string[]
          readonly properties?: Readonly<Record<string, unknown>>
        }
      | undefined
    expect(settingsBody).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['commandId', 'timeZone', 'morning', 'day', 'evening'],
    })
    expect(settingsBody?.properties?.expectedRevision).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    })
    expect(settingsBody?.properties?.morning).toMatchObject({
      type: 'string',
      nullable: true,
      pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
    })
    expect(
      responseSchema(settingsPost, '409', 'application/problem+json'),
    ).toMatchObject({
      oneOf: [
        { $ref: '#/components/schemas/ProblemResponseDto' },
        {
          $ref: '#/components/schemas/ReminderScheduleRevisionConflictProblemResponseDto',
        },
      ],
    })
    expect(
      document.components.schemas['ReminderScheduleMutationResponseV1'],
    ).toMatchObject({
      type: 'object',
      required: ['kind', 'aggregateId', 'aggregateRevision'],
    })
    expect(
      document.components.schemas[
        'ReminderScheduleRevisionConflictProblemResponseDto'
      ],
    ).toMatchObject({
      type: 'object',
      required: [
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'code',
        'requestId',
        'conflict',
      ],
    })
    expect(settingsGet.security).toEqual([{ sessionCookie: [] }])
    expect(settingsPost.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(deliveryStatusGet.security).toEqual([{ sessionCookie: [] }])
    expect(
      document.components.schemas['ReminderSettingsResponseV1'],
    ).toBeDefined()
    expect(
      document.components.schemas['ReminderDeliveryStatusResponseV1'],
    ).toBeDefined()

    await postgresControl.query(
      'ALTER DATABASE planner_n04_e2e WITH ALLOW_CONNECTIONS false',
    )
    postgresUnavailable = true
    await postgresControl.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = 'planner_n04_e2e'
          AND pid <> pg_backend_pid()`,
    )
    const unavailable = await fetch(`${baseUrl}/reminders/settings`, {
      headers: { cookie: firstCookie },
    })
    expect(unavailable.status).toBe(503)
    await expect(json(unavailable)).resolves.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    })
    await postgresControl.query(
      'ALTER DATABASE planner_n04_e2e WITH ALLOW_CONNECTIONS true',
    )
    postgresUnavailable = false
  })
})
