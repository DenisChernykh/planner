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
const outsiderUserId = '33333333-3333-4333-8333-333333333333'
const spaceId = '44444444-4444-4444-8444-444444444444'
const memberId = '55555555-5555-4555-8555-555555555555'
const secondMemberId = '66666666-6666-4666-8666-666666666666'
const sessionKeySecret = Buffer.alloc(32, 91)
const csrfSecret = Buffer.alloc(32, 92)

function monthAtOffset(offset: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  const value = new Date(Date.UTC(read('year'), read('month') - 1 + offset, 1))
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`
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

describe('F06 authenticated HTTP cancellation and republish', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
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
  let outsiderCsrf: string

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_f06_e2e')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${secondUserId}'::uuid),
        ('${outsiderUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
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
    const [first, second, outsider] = await Promise.all([
      issue.execute(userId, Date.now()),
      issue.execute(secondUserId, Date.now()),
      issue.execute(outsiderUserId, Date.now()),
    ])
    firstCookie = `planner-session=${first.rawToken}`
    firstCsrf = first.csrfToken
    secondCookie = `planner-session=${second.rawToken}`
    secondCsrf = second.csrfToken
    outsiderCookie = `planner-session=${outsider.rawToken}`
    outsiderCsrf = outsider.csrfToken

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
      TELEGRAM_OIDC_CLIENT_SECRET: 'f06-e2e-secret-long',
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

  const headers = (
    cookie = firstCookie,
    csrf = firstCsrf,
  ): Record<string, string> => ({
    cookie,
    origin,
    'content-type': 'application/json',
    'x-csrf-token': csrf,
  })

  async function createDraft(targetMonth: string): Promise<string> {
    const response = await fetch(`${baseUrl}/planning/drafts/empty`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        commandId: randomUUID(),
        targetMonth,
        focus: `Initial ${targetMonth}`,
      }),
    })
    expect(response.status).toBe(201)
    return String((await json(response))['aggregateId'])
  }

  async function preview(
    targetMonth: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${baseUrl}/planning/drafts/publication-preview?targetMonth=${targetMonth}`,
      { headers: { cookie: firstCookie } },
    )
    expect(response.status).toBe(200)
    return json(response)
  }

  function confirmation(value: Record<string, unknown>): object {
    return {
      commandId: randomUUID(),
      expectedRevision: value['draftRevision'],
      previewSchemaVersion: value['schemaVersion'],
      previewHashVersion: value['previewHashVersion'],
      previewHash: value['previewHash'],
    }
  }

  async function publish(
    planMonthId: string,
    body: object,
    mode: 'publish' | 'republish' = 'publish',
  ): Promise<Response> {
    return fetch(`${baseUrl}/planning/drafts/${planMonthId}/${mode}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    })
  }

  async function cancel(
    publicationId: string,
    body: object,
    cookie = firstCookie,
    csrf = firstCsrf,
  ): Promise<Response> {
    return fetch(`${baseUrl}/planning/publications/${publicationId}/cancel`, {
      method: 'POST',
      headers: headers(cookie, csrf),
      body: JSON.stringify(body),
    })
  }

  it('documents exact cancel/republish requests, responses and finite conflicts', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    const cancelOperation = document.paths[
      '/planning/publications/{publicationId}/cancel'
    ]?.['post'] as {
      security?: unknown
      requestBody?: {
        content?: Record<string, { schema?: Record<string, unknown> }>
      }
      responses?: Record<string, unknown>
    }
    const republishOperation = document.paths[
      '/planning/drafts/{planMonthId}/republish'
    ]?.['post'] as typeof cancelOperation
    expect(cancelOperation.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(
      cancelOperation.requestBody?.content?.['application/json']?.schema,
    ).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['commandId', 'planMonthId', 'expectedRevision'],
    })
    expect(cancelOperation.responses).toHaveProperty('200')
    expect(JSON.stringify(cancelOperation.responses)).toContain(
      'PLAN_PUBLICATION_CANCELLATION_CONFLICT',
    )
    expect(republishOperation.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(
      republishOperation.requestBody?.content?.['application/json']?.schema,
    ).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'commandId',
        'expectedRevision',
        'previewSchemaVersion',
        'previewHashVersion',
        'previewHash',
      ],
    })
    expect(republishOperation.responses).toHaveProperty('201')
    expect(JSON.stringify(republishOperation.responses)).toContain(
      'PLAN_PUBLICATION_MODE_CONFLICT',
    )
    expect(
      document.components.schemas[
        'PlanPublicationCancellationConflictResponseDto'
      ],
    ).toMatchObject({
      required: ['reason', 'currentRevision'],
    })
    expect(
      document.components.schemas['PlanPublicationModeConflictResponseDto'],
    ).toMatchObject({
      required: ['requiredMode', 'latestPublicationRevision'],
    })
  })

  it('requires session/CSRF and rejects forged or malformed fields without writes', async () => {
    const before = await admin.query<{ readonly actions: string }>(
      'SELECT count(*)::text actions FROM planning_action_groups',
    )
    const cancelBody = {
      commandId: randomUUID(),
      planMonthId: randomUUID(),
      expectedRevision: '1',
    }
    expect((await cancel(randomUUID(), cancelBody, '')).status).toBe(401)
    expect(
      (await cancel(randomUUID(), cancelBody, firstCookie, 'wrong')).status,
    ).toBe(403)
    for (const invalid of [
      { ...cancelBody, actor: memberId },
      { ...cancelBody, expectedRevision: '0' },
      { ...cancelBody, planMonthId: 'not-a-uuid' },
    ]) {
      expect((await cancel(randomUUID(), invalid)).status).toBe(422)
    }
    expect(
      (await cancel(randomUUID(), cancelBody, outsiderCookie, outsiderCsrf))
        .status,
    ).toBe(403)
    expect(
      await admin.query<{ readonly actions: string }>(
        'SELECT count(*)::text actions FROM planning_action_groups',
      ),
    ).toMatchObject({ rows: before.rows })
  })

  it('cancels, replays and republishes an append-only future publication', async () => {
    const targetMonth = monthAtOffset(1)
    const planMonthId = await createDraft(targetMonth)
    const initialPreview = await preview(targetMonth)
    const initialConfirmation = confirmation(initialPreview)

    const wrongInitialMode = await publish(
      planMonthId,
      initialConfirmation,
      'republish',
    )
    expect(wrongInitialMode.status).toBe(409)
    expect(await json(wrongInitialMode)).toMatchObject({
      code: 'PLAN_PUBLICATION_MODE_CONFLICT',
      conflict: { requiredMode: 'publish', latestPublicationRevision: null },
    })

    const published = await publish(planMonthId, initialConfirmation)
    expect(published.status).toBe(201)
    const firstRef = await json(published)
    const firstPublicationId = String(firstRef['aggregateId'])
    expect(firstRef).toMatchObject({ aggregateRevision: '1' })
    const firstSnapshotResponse = await fetch(
      `${baseUrl}/planning/publications/${firstPublicationId}`,
      { headers: { cookie: firstCookie } },
    )
    const firstSnapshot = await firstSnapshotResponse.text()

    const stale = await cancel(firstPublicationId, {
      commandId: randomUUID(),
      planMonthId,
      expectedRevision: '1',
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({
      code: 'PLAN_MONTH_REVISION_CONFLICT',
      conflict: {
        expectedRevision: '1',
        currentRevision: '2',
        nextAction: 'reload-month-and-retry',
      },
    })

    const cancelCommand = {
      commandId: randomUUID(),
      planMonthId,
      expectedRevision: '2',
    }
    const cancelled = await cancel(firstPublicationId, cancelCommand)
    expect(cancelled.status).toBe(200)
    const cancelledBody = await json(cancelled)
    expect(cancelledBody).toMatchObject({
      kind: 'planning.plan-month.v1',
      aggregateId: planMonthId,
      aggregateRevision: '3',
    })
    const replay = await cancel(firstPublicationId, cancelCommand)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(cancelledBody)

    const inactive = await cancel(firstPublicationId, {
      commandId: randomUUID(),
      planMonthId,
      expectedRevision: '3',
    })
    expect(inactive.status).toBe(409)
    expect(await json(inactive)).toMatchObject({
      code: 'PLAN_PUBLICATION_CANCELLATION_CONFLICT',
      conflict: { reason: 'not_active', currentRevision: '3' },
    })

    const focusUpdate = await fetch(
      `${baseUrl}/planning/drafts/${planMonthId}/focus`,
      {
        method: 'POST',
        headers: headers(secondCookie, secondCsrf),
        body: JSON.stringify({
          commandId: randomUUID(),
          expectedRevision: initialPreview['draftRevision'],
          focus: 'Republished focus',
        }),
      },
    )
    expect(focusUpdate.status).toBe(200)
    const nextPreview = await preview(targetMonth)
    const nextConfirmation = confirmation(nextPreview)
    const wrongRepublishMode = await publish(planMonthId, nextConfirmation)
    expect(wrongRepublishMode.status).toBe(409)
    expect(await json(wrongRepublishMode)).toMatchObject({
      code: 'PLAN_PUBLICATION_MODE_CONFLICT',
      conflict: { requiredMode: 'republish', latestPublicationRevision: '1' },
    })

    const republished = await publish(
      planMonthId,
      nextConfirmation,
      'republish',
    )
    expect(republished.status).toBe(201)
    const secondRef = await json(republished)
    expect(secondRef).toMatchObject({ aggregateRevision: '2' })
    expect(secondRef['aggregateId']).not.toBe(firstPublicationId)
    const republishReplay = await publish(
      planMonthId,
      nextConfirmation,
      'republish',
    )
    expect(republishReplay.status).toBe(201)
    expect(await json(republishReplay)).toEqual(secondRef)

    const oldAfter = await fetch(
      `${baseUrl}/planning/publications/${firstPublicationId}`,
      { headers: { cookie: secondCookie } },
    )
    expect(await oldAfter.text()).toBe(firstSnapshot)
    const newSnapshot = await fetch(
      `${baseUrl}/planning/publications/${String(secondRef['aggregateId'])}`,
      { headers: { cookie: firstCookie } },
    )
    expect(await json(newSnapshot)).toMatchObject({
      publicationRevision: '2',
      focus: 'Republished focus',
    })
    const counts = await admin.query<{
      readonly publications: string
      readonly cancellations: string
    }>(
      `SELECT
        (SELECT count(*)::text FROM plan_publications WHERE plan_month_id = $1::uuid) publications,
        (SELECT count(*)::text FROM planning_publication_changes
          WHERE publication_id = $2::uuid AND change_kind = 'cancelled') cancellations`,
      [planMonthId, firstPublicationId],
    )
    expect(counts.rows[0]).toEqual({ publications: '2', cancellations: '1' })
  })

  it('rejects cancellation after the target month has started', async () => {
    const targetMonth = monthAtOffset(0)
    const planMonthId = await createDraft(targetMonth)
    const value = await preview(targetMonth)
    const published = await publish(planMonthId, confirmation(value))
    expect(published.status).toBe(201)
    const publicationId = String((await json(published))['aggregateId'])
    const response = await cancel(publicationId, {
      commandId: randomUUID(),
      planMonthId,
      expectedRevision: '2',
    })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({
      code: 'PLAN_PUBLICATION_CANCELLATION_CONFLICT',
      conflict: { reason: 'month_started', currentRevision: '2' },
    })
  })
})
