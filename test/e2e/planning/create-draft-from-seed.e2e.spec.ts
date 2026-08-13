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
import { resolveAprilPlanSeed } from '@/modules/planning/seed/april-plan.seed'
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

describe('P11 authenticated HTTP creates and edits an April seed draft', () => {
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

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_p11_e2e')
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
    `)

    provider = new PrismaClientProvider(
      {
        database: {
          url: postgres.getConnectionUri(),
          poolMax: 4,
          connectionTimeoutMs: 2_000,
          idleTimeoutMs: 5_000,
          healthTimeoutMs: 1_000,
          transactionMaxWaitMs: 2_000,
          transactionTimeoutMs: 20_000,
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 63).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'p11-e2e-secret-long',
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

  async function post(
    value: object,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/planning/drafts/from-seed`, {
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

  async function state(): Promise<Record<string, string>> {
    const result = await admin.query<Record<string, string>>(`
      SELECT
        (SELECT count(*)::text FROM plan_months) months,
        (SELECT count(*)::text FROM goal_definitions) definitions,
        (SELECT count(*)::text FROM planning_seed_consumptions) consumptions,
        (SELECT count(*)::text FROM command_receipts) receipts
    `)
    return result.rows[0]!
  }

  it('documents the exact route body, security and finite conflicts', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
    }
    const operation = document.paths['/planning/drafts/from-seed']?.[
      'post'
    ] as {
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
      required: ['commandId', 'targetMonth', 'actorPersona'],
      properties: {
        actorPersona: { enum: ['memberA', 'memberB'] },
        targetMonth: {
          pattern:
            '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
        },
      },
    })
    expect(operation.responses).toHaveProperty('201')
    expect(JSON.stringify(operation.responses)).toContain(
      'PLAN_MONTH_ALREADY_EXISTS',
    )
    expect(JSON.stringify(operation.responses)).toContain(
      'PLAN_SEED_ALREADY_CONSUMED',
    )
  })

  it('requires session and CSRF and rejects expectedRevision/unknown fields with zero writes', async () => {
    const value = {
      commandId: randomUUID(),
      targetMonth: '2035-04',
      actorPersona: 'memberA',
    }
    const unauthenticated = await post(value, { cookie: '' })
    expect(unauthenticated.status).toBe(401)
    const badCsrf = await post(value, { 'x-csrf-token': 'wrong' })
    expect(badCsrf.status).toBe(403)
    for (const invalid of [
      { ...value, expectedRevision: '1' },
      { ...value, seedId: 'forged' },
    ]) {
      const response = await post(invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    expect(await state()).toEqual({
      months: '0',
      definitions: '0',
      consumptions: '0',
      receipts: '0',
    })
  })

  it('creates 41 editable goals, preserves replay revision one and creates no publication data', async () => {
    const commandId = randomUUID()
    const request = {
      commandId,
      targetMonth: '2035-04',
      actorPersona: 'memberA',
    }
    const created = await post(request)
    expect(created.status).toBe(201)
    const createdBody = await json(created)
    expect(createdBody).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: '1',
    })
    const planMonthId = String(createdBody['aggregateId'])

    const read = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(
        `${baseUrl}/planning/drafts?targetMonth=2035-04`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(200)
      return json(response)
    }
    const editor = await read()
    const goals = editor['goals'] as readonly Record<string, unknown>[]
    const seed = resolveAprilPlanSeed({
      denisMemberId: memberId,
      tanyaMemberId: secondMemberId,
    })
    expect(editor).toMatchObject({
      planMonthId,
      focus: seed.focus,
      draftRevision: '1',
      blockers: [],
    })
    expect(goals).toHaveLength(41)
    expect(
      goals.map((goal) => ({
        title: goal['title'],
        why: goal['why'],
        category: goal['category'],
        config: goal['config'],
        sourceProvenance: goal['sourceProvenance'],
      })),
    ).toEqual(
      seed.goals.map((goal) => ({
        title: goal.title,
        why: goal.why,
        category: goal.category,
        config: goal.config,
        sourceProvenance: goal.sourceProvenance,
      })),
    )

    const firstGoal = goals[0]!
    const config = firstGoal['config'] as Record<string, unknown>
    const measurement = config['measurement'] as Record<string, unknown>
    const changed = await fetch(
      `${baseUrl}/planning/drafts/${planMonthId}/goals/${String(firstGoal['planGoalId'])}/update`,
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
          expectedRevision: '1',
          goalDefinitionVersionId: firstGoal['goalDefinitionVersionId'],
          config: {
            ...config,
            measurement: { ...measurement, start: '08:15' },
          },
          sourceProvenance: firstGoal['sourceProvenance'],
        }),
      },
    )
    expect(changed.status).toBe(200)
    expect(await json(changed)).toMatchObject({ aggregateRevision: '2' })
    const after = await read()
    expect(after).toMatchObject({ draftRevision: '2' })
    expect(
      (
        (
          (after['goals'] as Record<string, unknown>[])[0]?.[
            'config'
          ] as Record<string, unknown>
        )['measurement'] as Record<string, unknown>
      )['start'],
    ).toBe('08:15')

    const replay = await post(request)
    expect(replay.status).toBe(201)
    expect(await json(replay)).toEqual(createdBody)
    const fingerprintConflict = await post({
      ...request,
      targetMonth: '2035-05',
    })
    expect(fingerprintConflict.status).toBe(409)
    expect(await json(fingerprintConflict)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
    const consumed = await post({
      ...request,
      commandId: randomUUID(),
      targetMonth: '2035-05',
    })
    expect(consumed.status).toBe(409)
    expect(await json(consumed)).toMatchObject({
      code: 'PLAN_SEED_ALREADY_CONSUMED',
    })

    const derived = await admin.query<Record<string, string>>(
      `SELECT
         (SELECT count(*)::text FROM plan_publications
           WHERE plan_month_id = $1::uuid) publications,
         (SELECT count(*)::text FROM plan_goal_snapshots
           WHERE plan_month_id = $1::uuid) snapshots,
         (SELECT count(*)::text FROM fixed_expectations expectation
           JOIN plan_goal_snapshots snapshot
             ON snapshot.id = expectation.plan_goal_snapshot_id
          WHERE snapshot.plan_month_id = $1::uuid) expectations,
         (SELECT count(*)::text FROM flexible_periods period
           JOIN plan_goal_snapshots snapshot
             ON snapshot.id = period.plan_goal_snapshot_id
          WHERE snapshot.plan_month_id = $1::uuid) periods`,
      [planMonthId],
    )
    expect(derived.rows[0]).toEqual({
      publications: '0',
      snapshots: '0',
      expectations: '0',
      periods: '0',
    })
  })
})
