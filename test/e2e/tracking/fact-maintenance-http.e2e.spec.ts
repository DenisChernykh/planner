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
import { configureApi } from '@/bootstrap/api/configure-api'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { PrismaLocalUserRepository } from '@/modules/auth/infrastructure/prisma-local-user.repository'
import { RedisSessionStore } from '@/modules/auth/infrastructure/redis-session.store'
import {
  createPlanningApplication,
  createPlanningLifecycleWorker,
  type DraftGoalConfigV1,
  type PlanningApplication,
} from '@/modules/planning'
import {
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
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
const sessionKeySecret = Buffer.alloc(32, 101)
const csrfSecret = Buffer.alloc(32, 102)

type Session = { readonly cookie: string; readonly csrf: string }
type StoredRef = { readonly id: string; revision: string }
type PublishedConfig = {
  readonly measurement: {
    readonly items?: readonly { readonly itemId: string }[]
    readonly variants?: readonly { readonly variantId: string }[]
  }
}
type Fixture = {
  readonly publicationId: string
  readonly snapshots: Readonly<Record<string, string>>
  readonly checklistItemId: string
  readonly variantId: string
  readonly weekly: readonly {
    readonly id: string
    readonly periodStart: string
    readonly periodEnd: string
  }[]
  readonly records: Record<string, StoredRef>
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

function addDays(localDate: string, days: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function weekOrdinal(localDate: string): '1' | '2' | '3' | '4' | '5' {
  const day = Number(localDate.slice(8, 10))
  const first = new Date(`${localDate.slice(0, 7)}-01T00:00:00.000Z`)
  const mondayOffset = (first.getUTCDay() + 6) % 7
  const ordinal = Math.floor((day + mondayOffset - 1) / 7) + 1
  if (ordinal < 1 || ordinal > 5) {
    throw new Error('H03 fixture requires a supported weekly task ordinal')
  }
  return String(ordinal) as '1' | '2' | '3' | '4' | '5'
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('H03 authenticated fact maintenance and closure HTTP adapter', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let issuerRedis: RedisLifecycle
  let issuerExecutor: RedisCommandExecutorPort
  let runtime: ApiRuntime
  let baseUrl: string
  let origin: string
  let today: string
  let closeDate: string
  let first: Session
  let second: Session
  let outsider: Session
  let fixture: Fixture

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_h03_e2e')
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
        poolMax: 12,
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
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    const members = new PrismaWorkspaceMemberResolver(provider)
    today = '2026-08-14'
    closeDate = addDays(today, -1)
    const targetMonth = today.slice(0, 7)
    clock = new FakeProductClock(
      new Date(`${targetMonth}-01T12:00:00.000+05:00`),
    )
    planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth, focus: 'H03 maintenance HTTP' },
    })
    const checklist = [{ itemId: null, label: 'Пункт' }] as const
    const variants = [
      {
        variantId: null,
        label: 'Основной вариант',
        unit: 'раз',
        precision: 0 as const,
        target: '10',
      },
    ] as const
    const ordinal = weekOrdinal(today)
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
        key: 'quantity-shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'шт.',
            precision: 0,
            aggregation: 'latest',
            target: '10',
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
          measurement: { kind: 'actual_time', start: '08:00', end: '10:00' },
          checkpoints: null,
        },
      },
      {
        key: 'rating',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'rating', minimum: 1, maximum: 10 },
          checkpoints: null,
        },
      },
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
        key: 'checklist',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'checklist', items: checklist },
          checkpoints: null,
        },
      },
      {
        key: 'or',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'any_of', variants },
          checkpoints: null,
        },
      },
      {
        key: 'partner',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: secondMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      ...(['weekly-one', 'weekly-two'] as const).map((key) => ({
        key,
        config: {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: {
            kind: 'weekly_planned_task' as const,
            weekOrdinal: ordinal,
            taskText: key,
          },
          measurement: { kind: 'boolean' as const },
          checkpoints: null,
        },
      })),
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: `H03 ${goals[index]!.key}`,
          why: 'HTTP maintenance contract',
          category: 'H03',
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
    if (preview === null) throw new Error('H03 publication preview missing')
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
    let checklistItemId = ''
    let variantId = ''
    for (const row of rows.rows) {
      const key = row.title.slice('H03 '.length)
      snapshots[key] = row.id
      if (key === 'checklist') {
        checklistItemId = row.config.measurement.items?.[0]?.itemId ?? ''
      }
      if (key === 'or') {
        variantId = row.config.measurement.variants?.[0]?.variantId ?? ''
      }
    }
    const weeklyRows = await pool.query<{
      readonly title: string
      readonly id: string
      readonly period_start: string
      readonly period_end: string
    }>(
      `SELECT snapshot.title, period.id::text,
              period.period_start::text, period.period_end::text
         FROM flexible_periods period
         JOIN plan_goal_snapshots snapshot
           ON snapshot.id = period.plan_goal_snapshot_id
        WHERE period.publication_id = $1::uuid
          AND period.period_kind = 'weekly_planned_task'
        ORDER BY snapshot.title`,
      [publication.aggregateId],
    )
    clock.set(new Date(`${today}T12:00:00.000+05:00`))
    const records: Record<string, StoredRef> = {}
    const store = (
      key: string,
      value: { aggregateId: string; aggregateRevision: bigint },
    ): void => {
      records[key] = {
        id: value.aggregateId,
        revision: value.aggregateRevision.toString(10),
      }
    }
    store(
      'boolean',
      await tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['boolean']!,
          localDate: today,
          value: { kind: 'boolean', result: 'done' },
        },
      }),
    )
    store(
      'quantity-shared',
      await tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['quantity-shared']!,
          localDate: today,
          value: { kind: 'quantity', value: '5' },
        },
      }),
    )
    store(
      'time',
      await tracking.recordTime.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['time']!,
          expectationDate: today,
          value: '08:30',
        },
      }),
    )
    store(
      'rating',
      await tracking.recordRating.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['rating']!,
          expectationDate: today,
          value: 7,
        },
      }),
    )
    store(
      'text-shared',
      await tracking.recordText.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['text-shared']!,
          expectationDate: today,
          checkpointId: null,
          text: 'Исходный текст',
          result: 'done',
        },
      }),
    )
    store(
      'checklist',
      await tracking.recordChecklistItem.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['checklist']!,
          expectationDate: today,
          checkpointId: null,
          checklistItemId,
          state: 'done',
        },
      }),
    )
    store(
      'or',
      await tracking.recordOrVariant.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshots['or']!,
          expectationDate: today,
          checkpointId: null,
          variantId,
          value: '4',
        },
      }),
    )
    fixture = {
      publicationId: publication.aggregateId,
      snapshots,
      checklistItemId,
      variantId,
      weekly: weeklyRows.rows.map((row) => ({
        id: row.id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
      })),
      records,
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
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 103).toString('base64url'),
      AUTH_CSRF_ORIGINS: origin,
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'h03-e2e-secret-long',
      TELEGRAM_OIDC_CALLBACK_URL: `${origin}/auth/telegram/callback`,
    })
    runtime = new ApiRuntime(() => configureApi(undefined, clock))
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
    path: string,
    body: object,
    session: Session = first,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
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

  async function get(
    path: string,
    session: Session = first,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { cookie: session.cookie } })
  }

  function correction(
    key: string,
    value: object,
    reason = `Исправление ${key}`,
    commandId = randomUUID(),
  ): object {
    return {
      commandId,
      expectedRevision: fixture.records[key]!.revision,
      value,
      reason,
    }
  }

  async function trackingWriteDigest(): Promise<string> {
    const result = await pool.query<{ digest: string }>(`
      SELECT jsonb_build_object(
        'months', COALESCE((
          SELECT jsonb_agg(
                   jsonb_build_array(id, facts_revision, status,
                                     active_publication_id)
                   ORDER BY id)
            FROM plan_months
        ), '[]'::jsonb),
        'records', COALESCE((
          SELECT jsonb_agg(
                   jsonb_build_array(id, space_id, current_revision_id,
                                     updated_at)
                   ORDER BY id)
            FROM tracking_fact_records
        ), '[]'::jsonb),
        'revisionCount', (SELECT count(*) FROM tracking_fact_revisions),
        'actionCount', (SELECT count(*) FROM tracking_action_groups),
        'changeCount', (SELECT count(*) FROM tracking_fact_changes),
        'closureCount', (SELECT count(*) FROM tracking_day_closures),
        'receiptCount', (SELECT count(*) FROM command_receipts)
      )::text AS digest
    `)
    return result.rows[0]!.digest
  }

  it('publishes exact resource routes, discriminators and finite Problem responses', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    const routes = [
      ['/tracking/facts/{factRecordId}/correct', 'post'],
      ['/tracking/facts/{factRecordId}/delete', 'post'],
      ['/tracking/facts/{factRecordId}/undo', 'post'],
      [
        '/tracking/publications/{publicationId}/days/{localDate}/close-preview',
        'get',
      ],
      ['/tracking/publications/{publicationId}/days/{localDate}/close', 'post'],
      [
        '/tracking/publications/{publicationId}/weekly-tasks/{flexiblePeriodId}/result',
        'post',
      ],
    ] as const
    for (const [path, method] of routes) {
      const operation = document.paths[path]?.[method] as {
        security?: unknown
        responses: Record<string, unknown>
        requestBody?: {
          content?: Record<string, { schema?: Record<string, unknown> }>
        }
      }
      expect(operation).toBeDefined()
      expect(operation.security).toEqual(
        method === 'get'
          ? [{ sessionCookie: [] }]
          : [{ sessionCookie: [], csrfToken: [] }],
      )
      if (method === 'get') {
        expect(Object.keys(operation.responses).sort()).toEqual([
          '200',
          '401',
          '403',
          '404',
          '409',
          '422',
          '503',
        ])
      }
      if (method === 'post') {
        expect(
          operation.requestBody?.content?.['application/json']?.schema,
        ).toMatchObject({ type: 'object', additionalProperties: false })
      }
      const validator = new OpenAPIResponseValidator({
        responses: operation.responses as never,
        components: document.components as never,
        customFormats: {
          uri: () => true,
          'uri-reference': () => true,
          'date-time': () => true,
        },
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
          const value = example.value
          expect(validator.validateResponse(status, value)).toBeUndefined()
          if (typeof value === 'object' && value !== null) {
            expect(
              validator.validateResponse(status, {
                ...value,
                unexpected: true,
              }),
            ).toBeDefined()
            const conflict = (value as { conflict?: unknown }).conflict
            if (typeof conflict === 'object' && conflict !== null) {
              expect(
                validator.validateResponse(status, {
                  ...value,
                  conflict: { ...conflict, unexpected: true },
                }),
              ).toBeDefined()
            }
          }
        }
      }
    }
    expect(document.components.schemas).toMatchObject({
      ProblemFieldErrorResponseDto: { additionalProperties: false },
      ProblemResponseDto: { additionalProperties: false },
      ValidationProblemResponseDto: { additionalProperties: false },
      TrackingFactTargetUnavailableConflictResponseDto: {
        additionalProperties: false,
      },
      TrackingFactTargetUnavailableProblemResponseDto: {
        additionalProperties: false,
      },
      TrackingFactRevisionConflictResponseDto: {
        additionalProperties: false,
      },
      TrackingFactRevisionProblemResponseDto: {
        additionalProperties: false,
      },
      TrackingCloseDayPreviewReadyV1: { additionalProperties: false },
      TrackingCloseDayPreviewClosedV1: { additionalProperties: false },
      TrackingDayCloseMutationResponseV1: { additionalProperties: false },
      TrackingFactUndoProblemResponseDto: { additionalProperties: false },
      TrackingExistingFactProblemResponseDto: { additionalProperties: false },
      TrackingCloseDayTargetProblemResponseDto: {
        additionalProperties: false,
      },
      TrackingCloseDayRetryProblemResponseDto: {
        additionalProperties: false,
      },
      TrackingExistingDayCloseProblemResponseDto: {
        additionalProperties: false,
      },
      TrackingWeeklyTaskTargetProblemResponseDto: {
        additionalProperties: false,
      },
    })
    expect(
      (
        document.components.schemas['TrackingTextFactValueV1'] as {
          properties: { text: { maxLength?: number } }
        }
      ).properties.text.maxLength,
    ).toBeUndefined()
  })

  it('requires authentication and CSRF and rejects actor, unknown fields and invalid revisions', async () => {
    const path = `/tracking/facts/${fixture.records['boolean']!.id}/correct`
    const body = correction('boolean', { kind: 'boolean', result: 'not_done' })
    expect(
      (await post(path, body, { cookie: '', csrf: first.csrf })).status,
    ).toBe(401)
    expect(
      (await post(path, body, first, { 'x-csrf-token': 'wrong' })).status,
    ).toBe(403)
    for (const invalid of [
      { ...body, actor: firstMemberId },
      { ...body, expectedRevision: '0' },
      { ...body, reason: '   ' },
    ]) {
      const response = await post(path, invalid)
      expect(response.status).toBe(422)
      expect(await json(response)).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    const noMembership = await post(path, body, outsider)
    expect(noMembership.status).toBe(403)
    expect(await json(noMembership)).toMatchObject({
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
  })

  it('corrects every fact category, enforces rights, tombstones and replays Undo safely', async () => {
    const cases: readonly [string, object, Session][] = [
      ['boolean', { kind: 'boolean', result: 'not_done' }, first],
      ['quantity-shared', { kind: 'quantity', value: '6' }, second],
      ['time', { kind: 'actual_time', value: '09:00' }, first],
      ['rating', { kind: 'rating', value: 8 }, first],
      [
        'text-shared',
        { kind: 'text', text: 'т'.repeat(2_001), result: 'done' },
        first,
      ],
      ['checklist', { kind: 'checklist_item', state: 'not_done' }, first],
      ['or', { kind: 'or_variant', value: '5' }, first],
    ]
    for (const [key, value, session] of cases) {
      const response = await post(
        `/tracking/facts/${fixture.records[key]!.id}/correct`,
        correction(key, value),
        session,
      )
      expect(response.status).toBe(200)
      const result = await json(response)
      expect(result).toMatchObject({
        kind: 'tracking.fact-record.v1',
        aggregateId: fixture.records[key]!.id,
        aggregateRevision: '2',
      })
      fixture.records[key]!.revision = '2'
    }
    const partnerDenied = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/correct`,
      correction('boolean', { kind: 'boolean', result: 'done' }),
      second,
    )
    expect(partnerDenied.status).toBe(403)
    const sharedDelete = await post(
      `/tracking/facts/${fixture.records['quantity-shared']!.id}/delete`,
      {
        commandId: randomUUID(),
        expectedRevision: fixture.records['quantity-shared']!.revision,
        reason: 'Shared нельзя удалить',
      },
      second,
    )
    expect(sharedDelete.status).toBe(403)

    const deleteCommandId = randomUUID()
    const deleteBody = {
      commandId: deleteCommandId,
      expectedRevision: fixture.records['boolean']!.revision,
      reason: 'Проверка tombstone',
    }
    const deleted = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/delete`,
      deleteBody,
    )
    expect(deleted.status).toBe(200)
    const deletedBody = await json(deleted)
    expect(deletedBody).toMatchObject({ aggregateRevision: '3' })
    fixture.records['boolean']!.revision = '3'
    const undone = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/undo`,
      {
        commandId: randomUUID(),
        expectedRevision: fixture.records['boolean']!.revision,
      },
    )
    expect(undone.status).toBe(200)
    expect(await json(undone)).toMatchObject({ aggregateRevision: '4' })
    fixture.records['boolean']!.revision = '4'

    const replay = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/delete`,
      deleteBody,
    )
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(deletedBody)
    const fingerprint = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/delete`,
      { ...deleteBody, reason: 'Другой intent' },
    )
    expect(fingerprint.status).toBe(409)
    expect(await json(fingerprint)).toMatchObject({
      code: 'COMMAND_FINGERPRINT_CONFLICT',
    })
    const notLatest = await post(
      `/tracking/facts/${fixture.records['boolean']!.id}/undo`,
      {
        commandId: randomUUID(),
        expectedRevision: fixture.records['boolean']!.revision,
      },
    )
    expect(notLatest.status).toBe(409)
    expect(await json(notLatest)).toMatchObject({
      code: 'TRACKING_FACT_UNDO_UNAVAILABLE',
      conflict: { reason: 'not_latest' },
    })

    const firstTextCorrection = await post(
      `/tracking/facts/${fixture.records['text-shared']!.id}/correct`,
      correction('text-shared', {
        kind: 'text',
        text: 'Собственное последнее действие',
        result: 'done',
      }),
    )
    expect(firstTextCorrection.status).toBe(200)
    fixture.records['text-shared']!.revision = '3'
    const partnerTextCorrection = await post(
      `/tracking/facts/${fixture.records['text-shared']!.id}/correct`,
      correction('text-shared', {
        kind: 'text',
        text: 'Изменено партнёром',
        result: 'done',
      }),
      second,
    )
    expect(partnerTextCorrection.status).toBe(200)
    fixture.records['text-shared']!.revision = '4'
    const superseded = await post(
      `/tracking/facts/${fixture.records['text-shared']!.id}/undo`,
      {
        commandId: randomUUID(),
        expectedRevision: fixture.records['text-shared']!.revision,
      },
    )
    expect(superseded.status).toBe(409)
    expect(await json(superseded)).toMatchObject({
      code: 'TRACKING_FACT_UNDO_UNAVAILABLE',
      conflict: { reason: 'superseded' },
    })
  })

  it('previews and closes unresolved or empty days with stale/hash recovery', async () => {
    const previewPath = `/tracking/publications/${fixture.publicationId}/days/${closeDate}/close-preview`
    const previewResponse = await get(previewPath)
    expect(previewResponse.status).toBe(200)
    const preview = await json(previewResponse)
    expect(preview).toMatchObject({
      schemaVersion: 'tracking.close-day-preview.v1',
      state: 'ready',
      publicationId: fixture.publicationId,
      localDate: closeDate,
      previewHashVersion: 'tracking.close-day-preview-hash.v1',
    })
    expect((preview['unresolved'] as unknown[]).length).toBeGreaterThan(0)
    const beforeCancel = await pool.query<{ count: string }>(
      'SELECT count(*)::text count FROM tracking_day_closures',
    )
    expect(beforeCancel.rows[0]!.count).toBe('0')

    const closePath = `/tracking/publications/${fixture.publicationId}/days/${closeDate}/close`
    const wrongHash = await post(closePath, {
      commandId: randomUUID(),
      expectedRevision: preview['factsRevision'],
      previewSchemaVersion: preview['schemaVersion'],
      previewHashVersion: preview['previewHashVersion'],
      previewHash: '0'.repeat(64),
    })
    expect(wrongHash.status).toBe(409)
    expect(await json(wrongHash)).toMatchObject({
      code: 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT',
      conflict: { nextAction: 'reload-close-day-preview-and-retry' },
    })

    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots['boolean']!,
        localDate: closeDate,
        value: { kind: 'boolean', result: 'done' },
      },
    })
    const stale = await post(closePath, {
      commandId: randomUUID(),
      expectedRevision: preview['factsRevision'],
      previewSchemaVersion: preview['schemaVersion'],
      previewHashVersion: preview['previewHashVersion'],
      previewHash: preview['previewHash'],
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({
      code: 'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
      conflict: { nextAction: 'reload-close-day-preview-and-retry' },
    })
    const refreshed = await json(await get(previewPath))
    const closed = await post(closePath, {
      commandId: randomUUID(),
      expectedRevision: refreshed['factsRevision'],
      previewSchemaVersion: refreshed['schemaVersion'],
      previewHashVersion: refreshed['previewHashVersion'],
      previewHash: refreshed['previewHash'],
    })
    expect(closed.status).toBe(201)
    const closedBody = await json(closed)
    expect(closedBody).toMatchObject({
      kind: 'tracking.day-close.v1',
    })
    expect(closedBody['aggregateRevision']).toEqual(
      expect.stringMatching(/^[1-9][0-9]*$/),
    )
    const alreadyClosed = await post(closePath, {
      commandId: randomUUID(),
      expectedRevision: closedBody['aggregateRevision'],
      previewSchemaVersion: refreshed['schemaVersion'],
      previewHashVersion: refreshed['previewHashVersion'],
      previewHash: refreshed['previewHash'],
    })
    expect(alreadyClosed.status).toBe(409)
    expect(await json(alreadyClosed)).toMatchObject({
      code: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
      conflict: {
        dayCloseId: closedBody['aggregateId'],
        nextAction: 'open-closed-day',
      },
    })
    const closedPreview = await json(await get(previewPath))
    expect(closedPreview).toMatchObject({
      state: 'closed',
      dayCloseId: closedBody['aggregateId'],
    })
    expect(closedPreview['closedAt']).toEqual(expect.stringMatching(/Z$/))

    const emptyPreviewPath = `/tracking/publications/${fixture.publicationId}/days/${today}/close-preview`
    const emptyPreview = await json(await get(emptyPreviewPath))
    expect(emptyPreview).toMatchObject({ state: 'ready', unresolved: [] })
    const emptyClose = await post(
      `/tracking/publications/${fixture.publicationId}/days/${today}/close`,
      {
        commandId: randomUUID(),
        expectedRevision: emptyPreview['factsRevision'],
        previewSchemaVersion: emptyPreview['schemaVersion'],
        previewHashVersion: emptyPreview['previewHashVersion'],
        previewHash: emptyPreview['previewHash'],
      },
    )
    expect(emptyClose.status).toBe(201)
  })

  it('records and corrects a weekly result and returns system-closed recovery', async () => {
    const firstPeriod = fixture.weekly[0]!
    const secondPeriod = fixture.weekly[1]!
    const path = `/tracking/publications/${fixture.publicationId}/weekly-tasks/${firstPeriod.id}/result`
    const initial = await post(path, {
      commandId: randomUUID(),
      result: 'done',
    })
    expect(initial.status).toBe(201)
    const initialBody = await json(initial)
    expect(initialBody).toMatchObject({
      kind: 'tracking.fact-record.v1',
      aggregateRevision: '1',
    })
    const duplicate = await post(path, {
      commandId: randomUUID(),
      result: 'not_done',
    })
    expect(duplicate.status).toBe(409)
    expect(await json(duplicate)).toMatchObject({
      code: 'TRACKING_FACT_CORRECTION_REQUIRED',
      conflict: {
        factRecordId: initialBody['aggregateId'],
        revision: '1',
        nextAction: 'correct-existing-record',
      },
    })
    const corrected = await post(
      `/tracking/facts/${String(initialBody['aggregateId'])}/correct`,
      {
        commandId: randomUUID(),
        expectedRevision: '1',
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'Итог недели уточнён',
      },
    )
    expect(corrected.status).toBe(200)
    expect(await json(corrected)).toMatchObject({ aggregateRevision: '2' })

    clock.set(
      new Date(`${addDays(firstPeriod.periodEnd, 1)}T00:01:00.000+05:00`),
    )
    await createPlanningLifecycleWorker({
      database: provider,
      transaction,
      clock,
    }).tick()
    clock.set(new Date(`${today}T12:00:00.000+05:00`))

    const systemClosed = await post(
      `/tracking/publications/${fixture.publicationId}/weekly-tasks/${secondPeriod.id}/result`,
      { commandId: randomUUID(), result: 'done' },
    )
    expect(systemClosed.status).toBe(409)
    expect(await json(systemClosed)).toMatchObject({
      code: 'TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED',
      conflict: {
        revision: '1',
        nextAction: 'correct-existing-record',
      },
    })
  })

  it('conceals missing or foreign targets and keeps unavailable failures zero-write', async () => {
    const setFactSpace = async (
      factRecordId: string,
      targetSpaceId: string,
    ): Promise<void> => {
      const client = await pool.connect()
      let destroy = false
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          'UPDATE tracking_fact_records SET space_id = $2::uuid WHERE id = $1::uuid',
          [factRecordId, targetSpaceId],
        )
        await client.query('COMMIT')
      } catch (error: unknown) {
        try {
          await client.query('ROLLBACK')
        } catch {
          destroy = true
        }
        throw error
      } finally {
        client.release(destroy)
      }
    }
    const expectZeroWrite = async (
      request: () => Promise<Response>,
      status: number,
      expected: object,
    ): Promise<void> => {
      const before = await trackingWriteDigest()
      const response = await request()
      expect(response.status).toBe(status)
      expect(await json(response)).toMatchObject(expected)
      expect(await trackingWriteDigest()).toBe(before)
    }
    const factPath = `/tracking/facts/${fixture.records['time']!.id}/correct`
    const factBody = (): object =>
      correction('time', { kind: 'actual_time', value: '09:15' })
    const closeTargetDate = addDays(today, -2)
    const weeklyPath = `/tracking/publications/${fixture.publicationId}/weekly-tasks/${fixture.weekly[0]!.id}/result`

    await expectZeroWrite(
      () =>
        post(`/tracking/facts/${randomUUID()}/correct`, {
          commandId: randomUUID(),
          expectedRevision: '1',
          value: { kind: 'boolean', result: 'done' },
          reason: 'Missing record',
        }),
      404,
      { code: 'TRACKING_FACT_TARGET_NOT_FOUND' },
    )
    await expectZeroWrite(
      () =>
        get(
          `/tracking/publications/${randomUUID()}/days/${closeTargetDate}/close-preview`,
        ),
      404,
      { code: 'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND' },
    )
    await expectZeroWrite(
      () =>
        post(
          `/tracking/publications/${fixture.publicationId}/weekly-tasks/${randomUUID()}/result`,
          { commandId: randomUUID(), result: 'done' },
        ),
      404,
      { code: 'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND' },
    )
    await expectZeroWrite(() => post(factPath, factBody(), outsider), 403, {
      code: 'TRACKING_AUTHORIZATION_DENIED',
    })
    await setFactSpace(fixture.records['time']!.id, randomUUID())
    try {
      await expectZeroWrite(() => post(factPath, factBody()), 404, {
        code: 'TRACKING_FACT_TARGET_NOT_FOUND',
      })
    } finally {
      await setFactSpace(fixture.records['time']!.id, spaceId)
    }

    const monthStart = `${today.slice(0, 7)}-01`
    clock.set(new Date(`${addDays(monthStart, -1)}T12:00:00.000+05:00`))
    await expectZeroWrite(() => post(factPath, factBody()), 409, {
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'not_active' },
    })
    await expectZeroWrite(
      () => post(weeklyPath, { commandId: randomUUID(), result: 'done' }),
      409,
      {
        code: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
        conflict: { reason: 'preactivation' },
      },
    )

    const nextMonth = new Date(`${monthStart}T00:00:00.000Z`)
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    const afterDeadline = addDays(nextMonth.toISOString().slice(0, 10), 3)
    clock.set(new Date(`${afterDeadline}T00:00:00.000+05:00`))
    await expectZeroWrite(() => post(factPath, factBody()), 409, {
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'closed' },
    })
    await expectZeroWrite(
      () =>
        get(
          `/tracking/publications/${fixture.publicationId}/days/${closeTargetDate}/close-preview`,
        ),
      409,
      {
        code: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
        conflict: { reason: 'closed' },
      },
    )
    clock.set(new Date(`${today}T12:00:00.000+05:00`))
  })
})
