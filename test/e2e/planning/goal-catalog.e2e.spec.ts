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
const sessionKeySecret = Buffer.alloc(32, 31)
const csrfSecret = Buffer.alloc(32, 32)

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
  if (result.status !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`)
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('P02 authenticated goal catalog HTTP', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let control: Pool
  let provider: PrismaClientProvider
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let cookie: string
  let csrfToken: string
  let postgresUnavailable = false

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_catalog_e2e')
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
          poolMax: 2,
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
    const issuerConnection = new RedisAuthConnectionManager(
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
    issuerRedis = new RedisLifecycle(issuerConnection, 1_000)
    await issuerRedis.connect(AbortSignal.timeout(2_000))
    issuerExecutor = issuerConnection.commandExecutor
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 33).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'catalog-e2e-secret',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (postgresUnavailable) {
      await control.query(
        'ALTER DATABASE planner_catalog_e2e WITH ALLOW_CONNECTIONS true',
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

  async function post(path: string, body: object): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(body),
    })
  }

  it('derives the actor from session and exposes lossless create/list/detail/version/archive/restore/copy flows', async () => {
    const create = await post('/planning/catalog/goal-definitions', {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: '  Сон 🌙  ',
      why: 'Восстановление',
      category: 'Здоровье',
    })
    expect(create.status).toBe(201)
    const created = await json(create)
    expect(created).toMatchObject({
      kind: 'planning.goal-definition.v1',
      aggregateRevision: '1',
    })
    expect(typeof created['aggregateId']).toBe('string')
    const definitionId = String(created['aggregateId'])

    const list = await fetch(`${baseUrl}/planning/catalog/goal-definitions`, {
      headers: { cookie },
    })
    expect(list.status).toBe(200)
    const listBody: unknown = await list.json()
    expect(listBody).toMatchObject([
      {
        goalDefinitionId: definitionId,
        state: 'active',
        revision: '1',
        currentVersion: {
          versionNumber: '1',
          seriesDecision: 'new',
          title: '  Сон 🌙  ',
        },
      },
    ])

    const version = await post(
      `/planning/catalog/goal-definitions/${definitionId}/versions`,
      {
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedRevision: '1',
        title: '  Сон 🌙  ',
        why: 'Те же metadata',
        category: 'Здоровье',
        seriesDecision: 'continue',
      },
    )
    expect(version.status).toBe(201)
    await expect(version.json()).resolves.toMatchObject({
      aggregateId: definitionId,
      aggregateRevision: '2',
    })

    const archived = await post(
      `/planning/catalog/goal-definitions/${definitionId}/archive`,
      {
        commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectedRevision: '2',
      },
    )
    expect(archived.status).toBe(200)
    const activeList = await fetch(
      `${baseUrl}/planning/catalog/goal-definitions`,
      { headers: { cookie } },
    )
    await expect(activeList.json()).resolves.toEqual([])
    const archivedList = await fetch(
      `${baseUrl}/planning/catalog/goal-definitions?state=archived`,
      { headers: { cookie } },
    )
    await expect(archivedList.json()).resolves.toHaveLength(1)

    const restored = await post(
      `/planning/catalog/goal-definitions/${definitionId}/restore`,
      {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expectedRevision: '3',
      },
    )
    expect(restored.status).toBe(200)
    const copied = await post(
      `/planning/catalog/goal-definitions/${definitionId}/copy`,
      {
        commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        expectedRevision: '4',
      },
    )
    expect(copied.status).toBe(201)
    const copyBody = await json(copied)
    expect(copyBody).toMatchObject({ aggregateRevision: '1' })
    expect(copyBody['aggregateId']).not.toBe(definitionId)

    const detail = await fetch(
      `${baseUrl}/planning/catalog/goal-definitions/${definitionId}`,
      { headers: { cookie } },
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      revision: '4',
      versions: [{ versionNumber: '2' }, { versionNumber: '1' }],
    })
    const history = await admin.query<{ member_id: string }>(`
      SELECT member_id::text FROM planning_action_groups
       WHERE goal_definition_id = '${definitionId}' ORDER BY occurred_at
    `)
    expect(history.rows.every(({ member_id }) => member_id === memberId)).toBe(
      true,
    )
  })

  it('enforces content-type/origin/csrf/parser order and value-free validation', async () => {
    const path = '/planning/catalog/goal-definitions'
    expect(
      (
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { cookie, origin },
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://evil.example',
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403)

    const malformed = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await json(malformed)).toMatchObject({ code: 'MALFORMED_REQUEST' })

    const scalar = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: '42',
    })
    expect(scalar.status).toBe(400)
    expect(await json(scalar)).toMatchObject({ code: 'MALFORMED_REQUEST' })

    const invalidMetadata = 'TOP-SECRET-METADATA'
    const invalid = await post(path, {
      commandId: randomUUID(),
      title: invalidMetadata,
      why: ' ',
      category: 'cat',
      userId,
    })
    expect(invalid.status).toBe(422)
    const invalidBody = await json(invalid)
    expect(invalidBody).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(JSON.stringify(invalidBody)).not.toMatch(
      /TOP-SECRET-METADATA|11111111-1111-4111-8111-111111111111/u,
    )
  })

  it('separates fingerprint, revision, state, not-found and dependency Problems without metadata leakage', async () => {
    const commandId = 'abababab-abab-4bab-8bab-abababababab'
    const first = await post('/planning/catalog/goal-definitions', {
      commandId,
      title: 'Private title',
      why: 'Private why',
      category: 'Private category',
    })
    const created = await json(first)
    const definitionId = String(created['aggregateId'])
    const fingerprint = await post('/planning/catalog/goal-definitions', {
      commandId,
      title: 'Different private title',
      why: 'Private why',
      category: 'Private category',
    })
    expect(fingerprint.status).toBe(409)
    const fingerprintBody = await json(fingerprint)
    expect(fingerprintBody).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
    expect(fingerprintBody['conflict']).toBeUndefined()

    const revision = await post(
      `/planning/catalog/goal-definitions/${definitionId}/archive`,
      { commandId: randomUUID(), expectedRevision: '9' },
    )
    expect(revision.status).toBe(409)
    expect(await json(revision)).toMatchObject({
      code: 'GOAL_DEFINITION_REVISION_CONFLICT',
      conflict: {
        currentRevision: '1',
        currentState: 'active',
        nextAction: 'reload-goal-definition-and-retry',
      },
    })
    await post(`/planning/catalog/goal-definitions/${definitionId}/archive`, {
      commandId: randomUUID(),
      expectedRevision: '1',
    })
    const state = await post(
      `/planning/catalog/goal-definitions/${definitionId}/archive`,
      { commandId: randomUUID(), expectedRevision: '2' },
    )
    expect(state.status).toBe(409)
    const stateBody = await json(state)
    expect(stateBody).toMatchObject({
      code: 'GOAL_DEFINITION_STATE_CONFLICT',
      conflict: {
        currentRevision: '2',
        currentState: 'archived',
        nextAction: 'reload-goal-definition-and-retry',
      },
    })
    const missing = await fetch(
      `${baseUrl}/planning/catalog/goal-definitions/${randomUUID()}`,
      { headers: { cookie } },
    )
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({
      code: 'GOAL_DEFINITION_NOT_FOUND',
    })
    for (const body of [fingerprintBody, stateBody]) {
      expect(JSON.stringify(body)).not.toMatch(
        /Private title|Private why|Private category|Different private title/u,
      )
    }

    await control.query(
      'ALTER DATABASE planner_catalog_e2e WITH ALLOW_CONNECTIONS false',
    )
    postgresUnavailable = true
    await control.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 'planner_catalog_e2e' AND pid <> pg_backend_pid()
    `)
    const unavailable = await fetch(
      `${baseUrl}/planning/catalog/goal-definitions`,
      { headers: { cookie } },
    )
    expect(unavailable.status).toBe(503)
    expect(await json(unavailable)).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    })
    await control.query(
      'ALTER DATABASE planner_catalog_e2e WITH ALLOW_CONNECTIONS true',
    )
    postgresUnavailable = false
  })
})
