import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  type PlanningApplication,
} from '@/modules/planning'
import {
  createTrackingApplication,
  FactTargetNotFoundError,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

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

function actor(id = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id }
}

describe('F07 fact history in a consistent PostgreSQL snapshot', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_f07_fact_history')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 8,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    const transaction = new PrismaTransactionAdapter(provider, context, config)
    const members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-04-09T12:00:00.000Z'))
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
    await pool.query(`
      INSERT INTO users (id) VALUES ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('publishes exact session-only bounded history contracts', async () => {
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    for (const path of [
      '/tracking/facts/{factRecordId}/history',
      '/planning/months/{planMonthId}/history',
    ]) {
      const operation = document.paths[path]?.['get'] as {
        security?: unknown
        parameters?: readonly { readonly name?: string }[]
        responses?: Record<string, unknown>
        requestBody?: unknown
      }
      expect(operation.security).toEqual([{ sessionCookie: [] }])
      expect(operation.requestBody).toBeUndefined()
      expect(operation.parameters?.map((item) => item.name).sort()).toEqual(
        path.startsWith('/tracking')
          ? ['cursor', 'factRecordId', 'limit']
          : ['cursor', 'limit', 'planMonthId'],
      )
      expect(Object.keys(operation.responses ?? {}).sort()).toEqual([
        '200',
        '401',
        '403',
        '404',
        '422',
        '503',
      ])
    }
    expect(
      document.components.schemas['TrackingFactHistoryEventV1']?.['oneOf'],
    ).toHaveLength(4)
    expect(
      document.components.schemas['PlanningMonthHistoryEventV1']?.['oneOf'],
    ).toHaveLength(6)
  })

  it('returns authors, reasons, tombstone and compensation with stable keyset pagination', async () => {
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'F07 fact history' },
    })
    const definition = await planning.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Daily check', why: 'History', category: 'F07' },
    })
    await planning.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('F07 preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshots = await pool.query<{ readonly id: string }>(
      'SELECT id::text FROM plan_goal_snapshots WHERE publication_id = $1::uuid',
      [publication.aggregateId],
    )
    clock.set(new Date('2026-04-10T12:00:00.000Z'))
    const created = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: publication.aggregateId,
        planGoalSnapshotId: snapshots.rows[0]!.id,
        localDate: '2026-04-10',
        value: { kind: 'boolean', result: 'done' },
      },
    })
    clock.set(new Date('2026-04-10T13:00:00.000Z'))
    await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        factRecordId: created.aggregateId,
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'Исправили исходную отметку.',
      },
    })
    clock.set(new Date('2026-04-10T14:00:00.000Z'))
    await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: { factRecordId: created.aggregateId, reason: 'Запись лишняя.' },
    })
    clock.set(new Date('2026-04-10T15:00:00.000Z'))
    await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 3n,
      payload: { factRecordId: created.aggregateId },
    })

    const first = await tracking.getFactHistory.execute({
      trustedUserId: secondUserId,
      factRecordId: created.aggregateId,
      limit: 2,
    })
    expect(first).toMatchObject({
      schemaVersion: 'tracking.fact-history.v1',
      factRecordId: created.aggregateId,
      originalActor: { kind: 'member', id: firstMemberId },
      currentRevision: {
        revision: '4',
        kind: 'recorded',
        actor: { kind: 'member', id: firstMemberId },
      },
      items: [
        {
          kind: 'undone',
          reason: null,
          beforeRevision: { revision: '3', kind: 'tombstoned' },
          afterRevision: { revision: '4', kind: 'recorded' },
          compensation: {
            restoredFromRevision: { revision: '2', kind: 'recorded' },
          },
        },
        {
          kind: 'tombstoned',
          reason: 'Запись лишняя.',
          beforeRevision: { revision: '2' },
          afterRevision: { revision: '3' },
          compensation: null,
        },
      ],
      nextCursor: '3',
    })
    const second = await tracking.getFactHistory.execute({
      trustedUserId: firstUserId,
      factRecordId: created.aggregateId,
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((item) => item.kind)).toEqual([
      'corrected',
      'recorded',
    ])
    expect(second.items[0]).toMatchObject({
      reason: 'Исправили исходную отметку.',
      beforeRevision: { revision: '1' },
      afterRevision: { revision: '2' },
    })
    expect(second.nextCursor).toBeNull()
    await expect(
      tracking.getFactHistory.execute({
        trustedUserId: firstUserId,
        factRecordId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)
  })
})
