import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  PrismaFactPersistence,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  UndoLastOwnActionCommand,
  type FactWritePhase,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const migrationsThroughT05 = [
  '20260811090000_planner_foundation',
  '20260811100000_local_user_session',
  '20260811110000_pair_workspace',
  '20260811120000_telegram_external_identity',
  '20260811130000_plan_draft_kernel',
  '20260811140000_goal_catalog',
  '20260811150000_typed_draft_goals',
  '20260811151000_plan_publication',
  '20260811152000_cancel_republish',
  '20260811153000_copy_month',
  '20260811155000_seed_consumption',
  '20260811160000_tracking_record_kernel',
  '20260811161000_time_rating_checkpoints',
  '20260811162000_text_checklist_facts',
  '20260811163000_or_composite_facts',
  '20260811164000_fact_corrections_tombstones',
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly addSnapshotId: string
  readonly latestSnapshotId: string
  readonly textSnapshotId: string
  readonly sharedSnapshotId: string
  readonly booleanSnapshotId: string
  readonly timeSnapshotId: string
  readonly ratingSnapshotId: string
  readonly checklistSnapshotId: string
  readonly checklistItemId: string
  readonly orSnapshotId: string
  readonly orVariantId: string
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

async function applyMigration(target: Pool, name: string): Promise<void> {
  await target.query(
    readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
  )
}

function config(url: string): {
  readonly database: {
    readonly url: string
    readonly poolMax: number
    readonly connectionTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly healthTimeoutMs: number
    readonly transactionMaxWaitMs: number
    readonly transactionTimeoutMs: number
  }
} {
  return {
    database: {
      url,
      poolMax: 12,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 20_000,
    },
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

describe('T06 undo last own action in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t06_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const runtimeConfig = config(postgres.getConnectionUri())
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-04-09T20:00:00.123Z'))
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
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function resetPair(): Promise<void> {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
    clock.set(new Date('2026-04-09T20:00:00.123Z'))
  }

  async function publishedFixture(
    application = planning,
    database = pool,
    runtimeClock = clock,
  ): Promise<Fixture> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'T06 undo stack' },
    })
    const definitions = await Promise.all(
      [
        ['Personal add', 'Undo contribution'],
        ['Personal latest', 'Undo latest'],
        ['Personal text', 'Undo correction/delete'],
        ['Shared latest', 'Partner supersession'],
        ['Personal boolean', 'Restore boolean'],
        ['Personal time', 'Restore actual time'],
        ['Personal rating', 'Restore rating'],
        ['Personal checklist', 'Restore checklist item'],
        ['Personal OR', 'Restore OR variant'],
      ].map(([title, why]) =>
        application.createGoalDefinition.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: { title: title!, why: why!, category: 'T06' },
        }),
      ),
    )
    const configs = [
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'раз',
          precision: 0 as const,
          aggregation: 'add' as const,
          target: '10',
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'раз',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: '10',
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'text' as const },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'раз',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: '10',
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'boolean' as const },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'actual_time' as const,
          start: '22:30',
          end: '07:00',
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'rating' as const, minimum: 1, maximum: 10 },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'checklist' as const,
          items: [{ itemId: null, label: 'Шаг' }],
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'any_of' as const,
          variants: [
            {
              variantId: null,
              label: 'Вариант',
              unit: 'раз',
              precision: 0 as const,
              target: '10',
            },
          ],
        },
        checkpoints: null,
      },
    ]
    for (const [index, definition] of definitions.entries()) {
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: configs[index]!,
          sourceProvenance: null,
        },
      })
    }
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('T06 preview missing')
    const publication = await application.publishMonth.execute({
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
    const snapshots = await database.query<{
      readonly id: string
      readonly config: {
        readonly measurement?: {
          readonly items?: readonly { readonly itemId: string }[]
          readonly variants?: readonly { readonly variantId: string }[]
        }
      }
    }>(
      `SELECT id::text, config FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid ORDER BY display_order`,
      [publication.aggregateId],
    )
    runtimeClock.set(new Date('2026-04-10T20:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      addSnapshotId: snapshots.rows[0]!.id,
      latestSnapshotId: snapshots.rows[1]!.id,
      textSnapshotId: snapshots.rows[2]!.id,
      sharedSnapshotId: snapshots.rows[3]!.id,
      booleanSnapshotId: snapshots.rows[4]!.id,
      timeSnapshotId: snapshots.rows[5]!.id,
      ratingSnapshotId: snapshots.rows[6]!.id,
      checklistSnapshotId: snapshots.rows[7]!.id,
      checklistItemId: snapshots.rows[7]!.config.measurement!.items![0]!.itemId,
      orSnapshotId: snapshots.rows[8]!.id,
      orVariantId:
        snapshots.rows[8]!.config.measurement!.variants![0]!.variantId,
    }
  }

  async function recordQuantity(
    fixture: Fixture,
    snapshotId: string,
    value: string,
    memberId = firstMemberId,
  ): Promise<{
    readonly aggregateId: string
    readonly aggregateRevision: bigint
  }> {
    return tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(memberId),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: snapshotId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value },
      },
    })
  }

  async function recordText(fixture: Fixture): Promise<{
    readonly aggregateId: string
    readonly aggregateRevision: bigint
  }> {
    return tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.textSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Первоначально',
        result: 'not_done',
      },
    })
  }

  it('undoes latest and add creates as tombstones and walks backward', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const add = await recordQuantity(fixture, fixture.addSnapshotId, '2')
    const latest = await recordQuantity(fixture, fixture.latestSnapshotId, '7')
    const latestUndo = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: latest.aggregateRevision,
      payload: { factRecordId: latest.aggregateId },
    })
    const addUndo = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: add.aggregateRevision,
      payload: { factRecordId: add.aggregateId },
    })
    expect(latestUndo).toMatchObject({
      aggregateId: latest.aggregateId,
      aggregateRevision: 2n,
    })
    expect(addUndo).toMatchObject({
      aggregateId: add.aggregateId,
      aggregateRevision: 2n,
    })
    const state = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*)::text FROM tracking_fact_undo_changes) undos,
              (SELECT count(*)::text FROM tracking_fact_revisions
                WHERE revision_kind = 'tombstoned') tombstones,
              (SELECT facts_revision::text FROM plan_months
                WHERE id = $1::uuid) facts_revision,
              (SELECT count(*)::text FROM tracking_fact_undo_changes
                WHERE restored_from_revision_id IS NULL) create_undos`,
      [fixture.planMonthId],
    )
    expect(state.rows[0]).toEqual({
      undos: '2',
      tombstones: '2',
      facts_revision: '4',
      create_undos: '2',
    })
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: addUndo.aggregateRevision,
        payload: { factRecordId: add.aggregateId },
      }),
    ).rejects.toEqual(new FactUndoUnavailableError('nothing_to_undo'))
  })

  it('restores delete and correction values then tombstones the original create', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordText(fixture)
    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'text', text: 'Исправлено', result: 'done' },
        reason: 'Коррекция',
      },
    })
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: corrected.aggregateRevision,
      payload: { factRecordId: first.aggregateId, reason: 'Удаление' },
    })
    const undoDeleteCommand = {
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: deleted.aggregateRevision,
      payload: { factRecordId: first.aggregateId },
    }
    const restoredCorrection =
      await tracking.undoLastOwnAction.execute(undoDeleteCommand)
    const restoredOriginal = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: restoredCorrection.aggregateRevision,
      payload: { factRecordId: first.aggregateId },
    })
    const tombstoned = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: restoredOriginal.aggregateRevision,
      payload: { factRecordId: first.aggregateId },
    })
    clock.set(new Date('2026-06-01T00:00:00.000Z'))
    await expect(
      tracking.undoLastOwnAction.execute(undoDeleteCommand),
    ).resolves.toEqual(restoredCorrection)
    await expect(
      tracking.undoLastOwnAction.execute({
        ...undoDeleteCommand,
        payload: { factRecordId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    const revisions = await pool.query<Record<string, unknown>>(
      `SELECT revision_number::text, revision_kind, text_value, text_result,
              recorded_by_member_id::text
         FROM tracking_fact_revisions
        WHERE fact_record_id = $1::uuid ORDER BY revision_number`,
      [first.aggregateId],
    )
    expect(revisions.rows).toEqual([
      expect.objectContaining({
        revision_number: '1',
        text_value: 'Первоначально',
      }),
      expect.objectContaining({
        revision_number: '2',
        text_value: 'Исправлено',
      }),
      expect.objectContaining({
        revision_number: '3',
        revision_kind: 'tombstoned',
      }),
      expect.objectContaining({
        revision_number: '4',
        text_value: 'Исправлено',
        recorded_by_member_id: firstMemberId,
      }),
      expect.objectContaining({
        revision_number: '5',
        text_value: 'Первоначально',
        recorded_by_member_id: firstMemberId,
      }),
      expect.objectContaining({
        revision_number: '6',
        revision_kind: 'tombstoned',
      }),
    ])
    const record = await pool.query<{ readonly creator: string }>(
      `SELECT created_by_member_id::text creator
         FROM tracking_fact_records WHERE id = $1::uuid`,
      [first.aggregateId],
    )
    expect(record.rows[0]?.creator).toBe(firstMemberId)
    expect(tombstoned.aggregateRevision).toBe(6n)
  })

  it('walks transitively through prior undo revisions after a new correction', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const created = await recordText(fixture)
    const firstCorrection = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: created.aggregateRevision,
      payload: {
        factRecordId: created.aggregateId,
        value: { kind: 'text', text: 'Первая коррекция', result: 'done' },
        reason: 'Первая волна',
      },
    })
    const firstUndo = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: firstCorrection.aggregateRevision,
      payload: { factRecordId: created.aggregateId },
    })
    const secondCorrection = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: firstUndo.aggregateRevision,
      payload: {
        factRecordId: created.aggregateId,
        value: { kind: 'text', text: 'Вторая коррекция', result: 'done' },
        reason: 'Вторая волна',
      },
    })
    const secondUndo = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: secondCorrection.aggregateRevision,
      payload: { factRecordId: created.aggregateId },
    })
    const createUndo = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: secondUndo.aggregateRevision,
      payload: { factRecordId: created.aggregateId },
    })
    expect({ firstUndo, secondUndo, createUndo }).toMatchObject({
      firstUndo: { aggregateRevision: 3n },
      secondUndo: { aggregateRevision: 5n },
      createUndo: { aggregateRevision: 6n },
    })
    const revisions = await pool.query<Record<string, string | null>>(
      `SELECT revision_number::text, revision_kind, text_value
         FROM tracking_fact_revisions
        WHERE fact_record_id = $1::uuid
        ORDER BY revision_number`,
      [created.aggregateId],
    )
    expect(revisions.rows).toEqual([
      {
        revision_number: '1',
        revision_kind: 'recorded',
        text_value: 'Первоначально',
      },
      {
        revision_number: '2',
        revision_kind: 'recorded',
        text_value: 'Первая коррекция',
      },
      {
        revision_number: '3',
        revision_kind: 'recorded',
        text_value: 'Первоначально',
      },
      {
        revision_number: '4',
        revision_kind: 'recorded',
        text_value: 'Вторая коррекция',
      },
      {
        revision_number: '5',
        revision_kind: 'recorded',
        text_value: 'Первоначально',
      },
      { revision_number: '6', revision_kind: 'tombstoned', text_value: null },
    ])
  })

  it('copies every typed value column from the compensated before-revision', async () => {
    await resetPair()
    const fixture = await publishedFixture()

    const quantity = await recordQuantity(
      fixture,
      fixture.latestSnapshotId,
      '3',
    )
    const boolean = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.booleanSnapshotId,
        localDate: '2026-04-10',
        value: { kind: 'boolean', result: 'done' },
      },
    })
    const actualTime = await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.timeSnapshotId,
        expectationDate: '2026-04-10',
        value: '00:30',
      },
    })
    const rating = await tracking.recordRating.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.ratingSnapshotId,
        expectationDate: '2026-04-10',
        value: 2,
      },
    })
    const checklist = await tracking.recordChecklistItem.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.checklistSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        checklistItemId: fixture.checklistItemId,
        state: 'done',
      },
    })
    const orVariant = await tracking.recordOrVariant.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.orSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        variantId: fixture.orVariantId,
        value: '4',
      },
    })

    const cases = [
      {
        record: quantity,
        replacement: { kind: 'quantity' as const, value: '9' },
      },
      {
        record: boolean,
        replacement: { kind: 'boolean' as const, result: 'not_done' as const },
      },
      {
        record: actualTime,
        replacement: { kind: 'actual_time' as const, value: '12:00' },
      },
      {
        record: rating,
        replacement: { kind: 'rating' as const, value: 8 },
      },
      {
        record: checklist,
        replacement: {
          kind: 'checklist_item' as const,
          state: 'not_done' as const,
        },
      },
      {
        record: orVariant,
        replacement: { kind: 'or_variant' as const, value: '7' },
      },
    ] as const
    for (const item of cases) {
      const corrected = await tracking.correctRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: item.record.aggregateRevision,
        payload: {
          factRecordId: item.record.aggregateId,
          value: item.replacement,
          reason: 'Проверка typed restore',
        },
      })
      await tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: corrected.aggregateRevision,
        payload: { factRecordId: item.record.aggregateId },
      })
    }

    const restored = await pool.query<Record<string, string | null>>(
      `SELECT fact_record_id::text,
              boolean_result,
              quantity_value,
              actual_time_value::text,
              rating_value::text,
              text_value,
              text_result,
              checklist_item_state,
              or_variant_value
         FROM tracking_fact_revisions
        WHERE revision_number = 3
        ORDER BY fact_record_id`,
    )
    const byRecord = new Map(
      restored.rows.map((row) => [row.fact_record_id, row] as const),
    )
    expect(byRecord.get(quantity.aggregateId)).toMatchObject({
      quantity_value: '3',
    })
    expect(byRecord.get(boolean.aggregateId)).toMatchObject({
      boolean_result: 'done',
    })
    expect(byRecord.get(actualTime.aggregateId)).toMatchObject({
      actual_time_value: '00:30:00',
    })
    expect(byRecord.get(rating.aggregateId)).toMatchObject({
      rating_value: '2',
    })
    expect(byRecord.get(checklist.aggregateId)).toMatchObject({
      checklist_item_state: 'done',
    })
    expect(byRecord.get(orVariant.aggregateId)).toMatchObject({
      or_variant_value: '4',
    })
    for (const row of restored.rows) {
      expect(
        [
          row.boolean_result,
          row.quantity_value,
          row.actual_time_value,
          row.rating_value,
          row.text_value,
          row.checklist_item_state,
          row.or_variant_value,
        ].filter((value) => value !== null),
      ).toHaveLength(1)
    }
  })

  it('rejects non-latest, stale, missing, system and expired attempts without writes', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const add = await recordQuantity(fixture, fixture.addSnapshotId, '2')
    const latest = await recordQuantity(fixture, fixture.latestSnapshotId, '7')
    const before = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
              (SELECT count(*)::text FROM tracking_action_groups) actions,
              (SELECT count(*)::text FROM command_receipts) receipts,
              (SELECT facts_revision::text FROM plan_months
                WHERE id = $1::uuid) facts_revision`,
      [fixture.planMonthId],
    )
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: add.aggregateRevision,
        payload: { factRecordId: add.aggregateId },
      }),
    ).rejects.toEqual(new FactUndoUnavailableError('not_latest'))
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: { factRecordId: latest.aggregateId },
      }),
    ).rejects.toBeInstanceOf(FactRevisionConflictError)
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: { factRecordId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: { kind: 'system', id: 'planner-worker' },
        expectedRevision: latest.aggregateRevision,
        payload: { factRecordId: latest.aggregateId },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    clock.set(new Date('2026-05-03T19:00:00.000Z'))
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: latest.aggregateRevision,
        payload: { factRecordId: latest.aggregateId },
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('closed'))
    const after = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
              (SELECT count(*)::text FROM tracking_action_groups) actions,
              (SELECT count(*)::text FROM command_receipts) receipts,
              (SELECT facts_revision::text FROM plan_months
                WHERE id = $1::uuid) facts_revision`,
      [fixture.planMonthId],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('does not reverse a shared record superseded by the partner', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordQuantity(fixture, fixture.sharedSnapshotId, '3')
    const partner = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'quantity', value: '5' },
        reason: 'Совместная коррекция',
      },
    })
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: partner.aggregateRevision,
        payload: { factRecordId: first.aggregateId },
      }),
    ).rejects.toEqual(new FactUndoUnavailableError('superseded'))
    await expect(
      tracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        expectedRevision: partner.aggregateRevision,
        payload: { factRecordId: first.aggregateId },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 3n })
  })

  it('serializes two undos and a new own action behind the month lock', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const latest = await recordQuantity(fixture, fixture.latestSnapshotId, '7')
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        tracking.undoLastOwnAction.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: latest.aggregateRevision,
          payload: { factRecordId: latest.aggregateId },
        }),
      ),
    )
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    const loser = attempts.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )
    expect(loser?.reason).toBeInstanceOf(FactRevisionConflictError)

    await resetPair()
    const secondFixture = await publishedFixture()
    const secondLatest = await recordQuantity(
      secondFixture,
      secondFixture.latestSnapshotId,
      '7',
    )
    let reachedRevision!: () => void
    let releaseRevision!: () => void
    const reached = new Promise<void>((resolve) => {
      reachedRevision = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseRevision = resolve
    })
    const persistence = new PrismaFactPersistence(provider, async (phase) => {
      if (phase === 'revision') {
        reachedRevision()
        await release
      }
    })
    const command = new UndoLastOwnActionCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      persistence,
    )
    const undoPromise = command.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: secondLatest.aggregateRevision,
      payload: { factRecordId: secondLatest.aggregateId },
    })
    await reached
    const newActionPromise = recordQuantity(
      secondFixture,
      secondFixture.addSnapshotId,
      '2',
    )
    releaseRevision()
    await expect(undoPromise).resolves.toMatchObject({ aggregateRevision: 2n })
    await expect(newActionPromise).resolves.toMatchObject({
      aggregateRevision: 1n,
    })
    const order = await pool.query<{ readonly action_kind: string }>(
      `SELECT action_kind FROM tracking_action_groups
        WHERE plan_month_id = $1::uuid ORDER BY after_facts_revision DESC
        LIMIT 2`,
      [secondFixture.planMonthId],
    )
    expect(order.rows.map((row) => row.action_kind)).toEqual([
      'fact_recorded',
      'fact_undone',
    ])
  })

  it('rolls back every undo write phase and completed receipt', async () => {
    const phases: readonly FactWritePhase[] = [
      'revision',
      'pointer',
      'facts_revision',
      'history',
      'undo_detail',
    ]
    for (const phase of phases) {
      await resetPair()
      const fixture = await publishedFixture()
      const latest = await recordQuantity(
        fixture,
        fixture.latestSnapshotId,
        '7',
      )
      const persistence = new PrismaFactPersistence(provider, (current) => {
        if (current === phase) throw new Error(`failpoint:${phase}`)
      })
      const command = new UndoLastOwnActionCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        persistence,
      )
      await expect(
        command.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: latest.aggregateRevision,
          payload: { factRecordId: latest.aggregateId },
        }),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
      const counts = await pool.query<Record<string, string>>(
        `SELECT (SELECT count(*)::text FROM tracking_fact_revisions
                  WHERE fact_record_id = $1::uuid) revisions,
                (SELECT count(*)::text FROM tracking_action_groups
                  WHERE action_kind = 'fact_undone') undos,
                (SELECT count(*)::text FROM tracking_fact_undo_changes) details,
                (SELECT count(*)::text FROM command_receipts
                  WHERE command_type = 'tracking.undo-last-own-action.v1') receipts,
                (SELECT facts_revision::text FROM plan_months
                  WHERE id = $2::uuid) facts_revision`,
        [latest.aggregateId, fixture.planMonthId],
      )
      expect(counts.rows[0]).toEqual({
        revisions: '1',
        undos: '0',
        details: '0',
        receipts: '0',
        facts_revision: '1',
      })
    }
  })

  it('preserves populated T01-T05 history through the T06 upgrade', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t06_upgrade')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const upgradePool = new Pool({
      connectionString: upgrade.getConnectionUri(),
    })
    const runtimeConfig = config(upgrade.getConnectionUri())
    const upgradeContext = new PrismaTransactionContext()
    const upgradeProvider = new PrismaClientProvider(
      runtimeConfig,
      upgradeContext,
    )
    try {
      for (const migration of migrationsThroughT05) {
        await applyMigration(upgradePool, migration)
      }
      await upgradePool.query(`
        INSERT INTO users (id) VALUES
          ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
        INSERT INTO spaces (id, singleton_key)
        VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot) VALUES
          ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
          ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
      `)
      await upgradeProvider.connect(AbortSignal.timeout(2_000))
      const upgradeTransaction = new PrismaTransactionAdapter(
        upgradeProvider,
        upgradeContext,
        runtimeConfig,
      )
      const upgradeMembers = new PrismaWorkspaceMemberResolver(upgradeProvider)
      const upgradeClock = new FakeProductClock(
        new Date('2026-04-09T20:00:00.123Z'),
      )
      const upgradePlanning = createPlanningApplication({
        database: upgradeProvider,
        transaction: upgradeTransaction,
        workspaceMembers: upgradeMembers,
        clock: upgradeClock,
      })
      const upgradeTracking = createTrackingApplication({
        database: upgradeProvider,
        transaction: upgradeTransaction,
        workspaceMembers: upgradeMembers,
        clock: upgradeClock,
      })
      const fixture = await publishedFixture(
        upgradePlanning,
        upgradePool,
        upgradeClock,
      )
      const recorded = await upgradeTracking.recordText.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.textSnapshotId,
          expectationDate: '2026-04-10',
          checkpointId: null,
          text: 'До T05',
          result: 'not_done',
        },
      })
      const corrected = await upgradeTracking.correctRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: recorded.aggregateRevision,
        payload: {
          factRecordId: recorded.aggregateId,
          value: { kind: 'text', text: 'После коррекции', result: 'done' },
          reason: 'До T06',
        },
      })
      const deleted = await upgradeTracking.deleteRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: corrected.aggregateRevision,
        payload: { factRecordId: recorded.aggregateId, reason: 'До T06' },
      })
      const digestSql = `
        SELECT md5(concat_ws('|',
          (SELECT string_agg(to_jsonb(revision)::text, '' ORDER BY revision_number)
             FROM tracking_fact_revisions revision
            WHERE fact_record_id = $1::uuid),
          (SELECT string_agg(to_jsonb(action)::text, '' ORDER BY after_facts_revision)
             FROM tracking_action_groups action
            WHERE plan_month_id = $2::uuid),
          (SELECT string_agg(to_jsonb(change_value)::text, '' ORDER BY action_id)
             FROM tracking_fact_changes change_value
            WHERE fact_record_id = $1::uuid),
          (SELECT string_agg(to_jsonb(receipt)::text, '' ORDER BY completed_at)
             FROM command_receipts receipt
            WHERE aggregate_id = $1::uuid)
        )) digest`
      const before = await upgradePool.query<{ readonly digest: string }>(
        digestSql,
        [recorded.aggregateId, fixture.planMonthId],
      )
      await applyMigration(upgradePool, '20260811165000_fact_undo')
      const after = await upgradePool.query<{ readonly digest: string }>(
        digestSql,
        [recorded.aggregateId, fixture.planMonthId],
      )
      expect(after.rows).toEqual(before.rows)
      await expect(
        upgradePool.query<{ readonly valid: boolean }>(
          `SELECT t01_action_has_exact_shape(id) valid
             FROM tracking_action_groups
            WHERE plan_month_id = $1::uuid
            ORDER BY after_facts_revision DESC
            LIMIT 1`,
          [fixture.planMonthId],
        ),
      ).resolves.toMatchObject({ rows: [{ valid: true }] })
      const undone = await upgradeTracking.undoLastOwnAction.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: deleted.aggregateRevision,
        payload: { factRecordId: recorded.aggregateId },
      })
      expect(undone.aggregateRevision).toBe(4n)
      await expect(
        upgradePool.query<Record<string, string>>(
          `SELECT revision_kind, text_value, text_result
             FROM tracking_fact_revisions
            WHERE fact_record_id = $1::uuid AND revision_number = 4`,
          [recorded.aggregateId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            revision_kind: 'recorded',
            text_value: 'После коррекции',
            text_result: 'done',
          },
        ],
      })
    } finally {
      await upgradeProvider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
      await upgradePool.end()
      await upgrade.stop()
    }
  })

  it('rejects non-latest, partner and forged restoration SQL envelopes', async () => {
    type ForgedUndo = {
      readonly fixture: Fixture
      readonly factRecordId: string
      readonly snapshotId: string
      readonly currentRevisionId: string
      readonly nextRevisionNumber: number
      readonly undoneActionId: string
      readonly restoredFromRevisionId: string | null
      readonly beforeFactsRevision: number
      readonly revisionKind: 'recorded' | 'tombstoned'
      readonly textValue?: string
      readonly textResult?: 'done' | 'not_done'
    }
    const attempt = async (input: ForgedUndo): Promise<void> => {
      const client = await pool.connect()
      const actionId = randomUUID()
      const revisionId = randomUUID()
      const commandId = randomUUID()
      const occurredAt = '2026-04-11T01:00:00.123Z'
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, actual_time_value, rating_value,
             text_value, text_result, checklist_item_state, or_variant_value,
             recorded_by_member_id, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, NULL, NULL, NULL, NULL,
                   $5, $6, NULL, NULL, $7::uuid, $8::timestamptz)`,
          [
            revisionId,
            input.factRecordId,
            input.nextRevisionNumber,
            input.revisionKind,
            input.textValue ?? null,
            input.textResult ?? null,
            firstMemberId,
            occurredAt,
          ],
        )
        await client.query(
          `UPDATE tracking_fact_records
              SET current_revision_id = $2::uuid, updated_at = $3::timestamptz
            WHERE id = $1::uuid`,
          [input.factRecordId, revisionId, occurredAt],
        )
        await client.query(
          `UPDATE plan_months SET facts_revision = $2
            WHERE id = $1::uuid`,
          [input.fixture.planMonthId, input.beforeFactsRevision + 1],
        )
        await client.query(
          `INSERT INTO tracking_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id, space_id,
             plan_month_id, publication_id, plan_goal_snapshot_id,
             command_type, command_id, before_facts_revision,
             after_facts_revision, occurred_at)
           VALUES ($1::uuid, 'fact_undone', 'member', $2, $3::uuid, $4::uuid,
                   $5::uuid, $6::uuid, $7::uuid,
                   'tracking.undo-last-own-action.v1', $8::uuid, $9, $10,
                   $11::timestamptz)`,
          [
            actionId,
            `member:${firstMemberId}`,
            firstMemberId,
            spaceId,
            input.fixture.planMonthId,
            input.fixture.publicationId,
            input.snapshotId,
            commandId,
            input.beforeFactsRevision,
            input.beforeFactsRevision + 1,
            occurredAt,
          ],
        )
        await client.query(
          `INSERT INTO tracking_fact_changes
            (action_id, fact_record_id, before_revision_id, after_revision_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
          [actionId, input.factRecordId, input.currentRevisionId, revisionId],
        )
        await client.query(
          `INSERT INTO tracking_fact_undo_changes
            (action_id, undone_action_id, restored_from_revision_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid)`,
          [actionId, input.undoneActionId, input.restoredFromRevisionId],
        )
        await client.query(
          `INSERT INTO command_receipts
            (actor_scope, command_type, command_id, fingerprint, result_kind,
             aggregate_id, aggregate_revision, completed_at)
           VALUES ($1, 'tracking.undo-last-own-action.v1', $2::uuid,
                   repeat('f', 64), 'tracking.fact-record.v1', $3::uuid, $4,
                   $5::timestamptz)`,
          [
            `member:${firstMemberId}`,
            commandId,
            input.factRecordId,
            input.nextRevisionNumber,
            occurredAt,
          ],
        )
        await expect(client.query('COMMIT')).rejects.toMatchObject({
          code: '23514',
        })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }

    await resetPair()
    const fixture = await publishedFixture()
    const recorded = await recordText(fixture)
    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: recorded.aggregateRevision,
      payload: {
        factRecordId: recorded.aggregateId,
        value: { kind: 'text', text: 'Исправлено', result: 'done' },
        reason: 'SQL fixture',
      },
    })
    const history = await pool.query<{
      readonly action_id: string
      readonly action_kind: string
      readonly before_revision_id: string | null
      readonly after_revision_id: string
    }>(
      `SELECT action.id::text action_id, action.action_kind,
              change_value.before_revision_id::text,
              change_value.after_revision_id::text
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change_value
           ON change_value.action_id = action.id
        WHERE change_value.fact_record_id = $1::uuid
        ORDER BY action.after_facts_revision`,
      [recorded.aggregateId],
    )
    const create = history.rows[0]!
    const correction = history.rows[1]!
    await attempt({
      fixture,
      factRecordId: recorded.aggregateId,
      snapshotId: fixture.textSnapshotId,
      currentRevisionId: correction.after_revision_id,
      nextRevisionNumber: 3,
      undoneActionId: create.action_id,
      restoredFromRevisionId: null,
      beforeFactsRevision: 2,
      revisionKind: 'tombstoned',
    })
    await attempt({
      fixture,
      factRecordId: recorded.aggregateId,
      snapshotId: fixture.textSnapshotId,
      currentRevisionId: correction.after_revision_id,
      nextRevisionNumber: 3,
      undoneActionId: correction.action_id,
      restoredFromRevisionId: correction.before_revision_id,
      beforeFactsRevision: 2,
      revisionKind: 'recorded',
      textValue: 'Подделано',
      textResult: 'done',
    })

    await resetPair()
    const partnerFixture = await publishedFixture()
    const partnerRecord = await recordQuantity(
      partnerFixture,
      partnerFixture.sharedSnapshotId,
      '5',
      secondMemberId,
    )
    const partnerHistory = await pool.query<{
      readonly action_id: string
      readonly revision_id: string
    }>(
      `SELECT action.id::text action_id,
              change_value.after_revision_id::text revision_id
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change_value
           ON change_value.action_id = action.id
        WHERE change_value.fact_record_id = $1::uuid`,
      [partnerRecord.aggregateId],
    )
    await attempt({
      fixture: partnerFixture,
      factRecordId: partnerRecord.aggregateId,
      snapshotId: partnerFixture.sharedSnapshotId,
      currentRevisionId: partnerHistory.rows[0]!.revision_id,
      nextRevisionNumber: 2,
      undoneActionId: partnerHistory.rows[0]!.action_id,
      restoredFromRevisionId: null,
      beforeFactsRevision: 1,
      revisionKind: 'tombstoned',
    })
    expect(corrected.aggregateRevision).toBe(2n)
  })

  it('enforces immutable and unique undo history in direct SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const latest = await recordQuantity(fixture, fixture.latestSnapshotId, '7')
    await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: latest.aggregateRevision,
      payload: { factRecordId: latest.aggregateId },
    })
    const shape = await pool.query<{ readonly valid: boolean }>(
      `SELECT t01_action_has_exact_shape(action_id) valid
         FROM tracking_fact_undo_changes`,
    )
    expect(shape.rows).toEqual([{ valid: true }])
    await expect(
      pool.query(`UPDATE tracking_fact_undo_changes
                     SET restored_from_revision_id = NULL`),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(`DELETE FROM tracking_fact_undo_changes`),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_undo_changes
          (action_id, undone_action_id, restored_from_revision_id)
         VALUES (gen_random_uuid(), gen_random_uuid(), NULL)`,
      ),
    ).rejects.toMatchObject({ code: '23503' })
    const detail = await pool.query<{
      readonly undone_action_id: string
      readonly action_id: string
    }>(
      `SELECT undone_action_id::text, action_id::text
         FROM tracking_fact_undo_changes`,
    )
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_undo_changes
          (action_id, undone_action_id, restored_from_revision_id)
         VALUES (gen_random_uuid(), $1::uuid, NULL)`,
        [detail.rows[0]!.undone_action_id],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})
