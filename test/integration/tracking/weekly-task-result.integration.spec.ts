import { randomUUID } from 'node:crypto'
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
  FactCorrectionRequiredError,
  PrismaWeeklyTaskResultPersistence,
  RecordWeeklyTaskResultCommand,
  TrackingAuthorizationDeniedError,
  WeeklyTaskTargetNotFoundError,
  createTrackingApplication,
  type TrackingApplication,
  type WeeklyTaskResultWritePhase,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const migrationsThroughT08 = [
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
  '20260811165000_fact_undo',
  '20260811166000_close_day',
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly flexiblePeriodId: string
  readonly periodStart: string
  readonly periodEnd: string
}

async function applyMigration(target: Pool, name: string): Promise<void> {
  await target.query(
    readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
  )
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

describe('T09 weekly planned task result on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let runtimeConfig: ConstructorParameters<typeof PrismaClientProvider>[0]

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t09_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrationsThroughT08) {
      await applyMigration(pool, migration)
    }
    runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 12,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 30_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(3_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-03-30T07:00:00.000Z'))
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

    await resetPair()
    const value = await publishedSeedFixture(false)
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const water = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid AND title = 'Вода 1200 мл'`,
      [value.publicationId],
    )
    const representative = await pool.query<{
      readonly wake_id: string
      readonly text_id: string
      readonly or_id: string
      readonly variant_id: string
    }>(
      `SELECT
         max(id::text) FILTER (WHERE title = 'Показатель 103') wake_id,
         max(id::text) FILTER (WHERE title = 'Важная задача дня') text_id,
         max(id::text) FILTER (WHERE title = 'Массаж лица') or_id,
         max(config #>> '{measurement,variants,0,variantId}')
           FILTER (WHERE title = 'Массаж лица') variant_id
       FROM plan_goal_snapshots WHERE publication_id = $1::uuid`,
      [value.publicationId],
    )
    const targets = representative.rows[0]!
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: water.rows[0]!.id,
        localDate: '2026-04-09',
        value: { kind: 'quantity', value: '600' },
      },
    })
    const wake = await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: targets.wake_id,
        expectationDate: '2026-04-09',
        value: '08:30',
      },
    })
    const text = await tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: targets.text_id,
        expectationDate: '2026-04-09',
        checkpointId: null,
        text: 'Позвонить партнёру',
        result: 'done',
      },
    })
    await tracking.recordCompositeOccurrence.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: targets.or_id,
        localDate: '2026-04-09',
        component: {
          kind: 'or_variant',
          variantId: targets.variant_id,
          value: '1',
        },
      },
    })
    const correctedText = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: text.aggregateRevision,
      payload: {
        factRecordId: text.aggregateId,
        value: {
          kind: 'text',
          text: 'Партнёр подтвердил встречу',
          result: 'done',
        },
        reason: 'Уточнён результат',
      },
    })
    expect(correctedText.aggregateRevision).toBe(2n)
    const deletedWake = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: wake.aggregateRevision,
      payload: { factRecordId: wake.aggregateId, reason: 'Проверка tombstone' },
    })
    const restoredWake = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: deletedWake.aggregateRevision,
      payload: { factRecordId: wake.aggregateId },
    })
    const closePreview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-08',
    })
    if (closePreview.state !== 'ready') {
      throw new Error('T08 upgrade preview missing')
    }
    expect(closePreview.unresolved.length).toBeGreaterThan(1)
    await tracking.closeDay.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: closePreview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate: '2026-04-08',
        previewSchemaVersion: closePreview.schemaVersion,
        previewHashVersion: closePreview.previewHashVersion,
        previewHash: closePreview.previewHash,
      },
    })
    const beforeUpgrade = await digest()
    await applyMigration(pool, '20260811167000_weekly_task_result')
    expect(await digest()).toBe(beforeUpgrade)
    const postUpgradeCorrection = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: restoredWake.aggregateRevision,
      payload: {
        factRecordId: wake.aggregateId,
        value: { kind: 'actual_time', value: '09:00' },
        reason: 'Проверка T05 dispatcher после T09',
      },
    })
    await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: postUpgradeCorrection.aggregateRevision,
      payload: { factRecordId: wake.aggregateId },
    })
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  beforeEach(async () => {
    await resetPair()
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
    clock.set(new Date('2026-03-30T07:00:00.000Z'))
  }

  async function digest(): Promise<string> {
    const rows = await pool.query<{ readonly digest: string }>(`
      SELECT jsonb_build_object(
        'months', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id)
          FROM (SELECT id, facts_revision FROM plan_months) value),
        'records', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id)
          FROM (SELECT * FROM tracking_fact_records) value),
        'revisions', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id)
          FROM (SELECT * FROM tracking_fact_revisions) value),
        'actions', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.id)
          FROM (SELECT * FROM tracking_action_groups) value),
        'changes', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.action_id)
          FROM (SELECT * FROM tracking_fact_changes) value),
        'receipts', (SELECT jsonb_agg(to_jsonb(value) ORDER BY value.command_id)
          FROM (SELECT * FROM command_receipts) value)
      )::text digest
    `)
    return rows.rows[0]!.digest
  }

  async function publishedSeedFixture(
    chooseWeekThree = true,
    publishAt?: Date,
  ): Promise<Fixture> {
    if (publishAt !== undefined) clock.set(publishAt)
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('publication preview missing')
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
    const periods = await pool.query<{
      readonly plan_goal_snapshot_id: string
      readonly flexible_period_id: string
      readonly period_start: string
      readonly period_end: string
    }>(
      `SELECT snapshot.id::text plan_goal_snapshot_id,
              period.id::text flexible_period_id,
              period.period_start::text, period.period_end::text
         FROM flexible_periods period
         JOIN plan_goal_snapshots snapshot
           ON snapshot.id = period.plan_goal_snapshot_id
        WHERE period.publication_id = $1::uuid
          AND period.period_kind = 'weekly_planned_task'
          AND snapshot.title = $2
        ORDER BY period.ordinal`,
      [
        publication.aggregateId,
        chooseWeekThree ? 'Outreach: неделя 3' : 'Outreach: неделя 1',
      ],
    )
    const period = periods.rows[0]!
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      planGoalSnapshotId: period.plan_goal_snapshot_id,
      flexiblePeriodId: period.flexible_period_id,
      periodStart: period.period_start,
      periodEnd: period.period_end,
    }
  }

  async function sharedFixture(): Promise<Fixture> {
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'Shared weekly task' },
    })
    const definition = await planning.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Shared week', why: 'Pair task', category: 'Work' },
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
          scope: { kind: 'shared' },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '3',
            taskText: 'Сделать вместе',
          },
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
    if (preview === null) throw new Error('publication preview missing')
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
    const period = await pool.query<{
      readonly plan_goal_snapshot_id: string
      readonly flexible_period_id: string
      readonly period_start: string
      readonly period_end: string
    }>(
      `SELECT plan_goal_snapshot_id::text, id::text flexible_period_id,
              period_start::text, period_end::text
         FROM flexible_periods WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      planGoalSnapshotId: period.rows[0]!.plan_goal_snapshot_id,
      flexiblePeriodId: period.rows[0]!.flexible_period_id,
      periodStart: period.rows[0]!.period_start,
      periodEnd: period.rows[0]!.period_end,
    }
  }

  function recordCommand(
    value: Fixture,
    commandId = randomUUID(),
    result: 'done' | 'not_done' = 'done',
  ): Parameters<TrackingApplication['recordWeeklyTaskResult']['execute']>[0] {
    return {
      commandId,
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        flexiblePeriodId: value.flexiblePeriodId,
        result,
      },
    }
  }

  async function expectForgedEnvelopeRejected(
    value: Fixture,
    forgery: 'period' | 'scope' | 'value' | 'action' | 'receipt',
  ): Promise<void> {
    const alternative = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM flexible_periods
        WHERE publication_id = $1::uuid
          AND period_kind = 'weekly_planned_task'
          AND id <> $2::uuid
        ORDER BY id LIMIT 1`,
      [value.publicationId, value.flexiblePeriodId],
    )
    const factRecordId = randomUUID()
    const factRevisionId = randomUUID()
    const actionId = randomUUID()
    const commandId = randomUUID()
    const memberId = forgery === 'scope' ? secondMemberId : firstMemberId
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      await client.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           flexible_period_id, current_revision_id, created_by_member_id,
           created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::date, 'weekly_task_result', $7::uuid, NULL, $8::uuid,
                 $9::timestamptz, $9::timestamptz)`,
        [
          factRecordId,
          spaceId,
          value.planMonthId,
          value.publicationId,
          value.planGoalSnapshotId,
          value.periodStart,
          forgery === 'period'
            ? alternative.rows[0]!.id
            : value.flexiblePeriodId,
          memberId,
          '2026-04-15T07:00:00.000Z',
        ],
      )
      await client.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, recorded_by_member_id, created_at)
         VALUES ($1::uuid, $2::uuid, 1, $3, $4, $5::uuid,
                 $6::timestamptz)`,
        [
          factRevisionId,
          factRecordId,
          forgery === 'value' ? 'tombstoned' : 'recorded',
          forgery === 'value' ? null : 'done',
          memberId,
          '2026-04-15T07:00:00.000Z',
        ],
      )
      await client.query(
        `UPDATE tracking_fact_records SET current_revision_id = $2::uuid
          WHERE id = $1::uuid`,
        [factRecordId, factRevisionId],
      )
      await client.query(
        `UPDATE plan_months SET facts_revision = 1
          WHERE id = $1::uuid AND facts_revision = 0`,
        [value.planMonthId],
      )
      await client.query(
        `INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
         VALUES ($1::uuid, $2, 'member', $3, $4::uuid, $5::uuid,
                 $6::uuid, $7::uuid, $8::uuid,
                 'tracking.record-weekly-task-result.v1', $9::uuid,
                 0, 1, $10, $11::timestamptz)`,
        [
          actionId,
          forgery === 'action' ? 'fact_corrected' : 'fact_recorded',
          `member:${memberId}`,
          memberId,
          spaceId,
          value.planMonthId,
          value.publicationId,
          value.planGoalSnapshotId,
          commandId,
          forgery === 'action' ? 'Forged action' : null,
          '2026-04-15T07:00:00.000Z',
        ],
      )
      await client.query(
        `INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid)`,
        [actionId, factRecordId, factRevisionId],
      )
      await client.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint,
           result_kind, aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'tracking.record-weekly-task-result.v1', $2::uuid,
                 repeat('a', 64), 'tracking.fact-record.v1', $3::uuid,
                 1, $4::timestamptz)`,
        [
          `member:${memberId}`,
          commandId,
          forgery === 'receipt' ? randomUUID() : factRecordId,
          '2026-04-15T07:00:00.000Z',
        ],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const residue = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count FROM tracking_fact_records
        WHERE id = $1::uuid`,
      [factRecordId],
    )
    expect(residue.rows[0]!.count).toBe('0')
  }

  it('records one revisioned result, replays exactly and projects it for the whole week', async () => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const command = recordCommand(value)
    const result = await tracking.recordWeeklyTaskResult.execute(command)
    expect(result).toMatchObject({
      kind: 'tracking.fact-record.v1',
      aggregateRevision: 1n,
    })
    await expect(
      tracking.recordWeeklyTaskResult.execute(command),
    ).resolves.toEqual(result)
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ).rejects.toMatchObject({
      existingRef: { factRecordId: result.aggregateId, revision: 1n },
    })

    const stored = await pool.query<Record<string, string>>(
      `SELECT record.local_date::text local_date,
              revision.boolean_result, month.facts_revision::text,
              (SELECT count(*)::text FROM fixed_expectations expectation
                WHERE expectation.plan_goal_snapshot_id = record.plan_goal_snapshot_id)
                fixed_count
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
         JOIN plan_months month ON month.id = record.plan_month_id
        WHERE record.id = $1::uuid`,
      [result.aggregateId],
    )
    expect(stored.rows[0]).toMatchObject({
      local_date: value.periodStart,
      boolean_result: 'done',
      facts_revision: '1',
      fixed_count: '0',
    })

    const month = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published month expected')
    for (const date of ['2026-04-13', '2026-04-15', '2026-04-19']) {
      const goal = month.days
        .find((day) => day.localDate === date)!
        .goals.find(
          (candidate) =>
            candidate.planGoalSnapshotId === value.planGoalSnapshotId,
        )!
      expect(goal.flexiblePeriods[0]).toMatchObject({
        flexiblePeriodId: value.flexiblePeriodId,
        state: 'done',
        facts: [
          expect.objectContaining({
            factRecordId: result.aggregateId,
            revision: 1n,
            factKind: 'weekly_task_result',
            recordedByMemberId: firstMemberId,
            value: { kind: 'boolean', result: 'done' },
          }),
        ],
      })
      expect(goal.progress.progress).toMatchObject({ basisPoints: '10000' })
    }
  })

  it('uses existing correction, personal delete and Undo rules for a weekly result', async () => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const first = await tracking.recordWeeklyTaskResult.execute(
      recordCommand(value),
    )
    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'Уточнён недельный результат',
      },
    })
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: corrected.aggregateRevision,
      payload: { factRecordId: first.aggregateId, reason: 'Удалено ошибочно' },
    })
    const restored = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: deleted.aggregateRevision,
      payload: { factRecordId: first.aggregateId },
    })
    expect(restored.aggregateRevision).toBe(4n)
    const audit = await pool.query<Record<string, string>>(
      `SELECT record.created_by_member_id::text created_by_member_id,
              revision.revision_kind, revision.boolean_result,
              revision.recorded_by_member_id::text recorded_by_member_id,
              count(all_revision.id)::text revisions
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
         JOIN tracking_fact_revisions all_revision
           ON all_revision.fact_record_id = record.id
        WHERE record.id = $1::uuid
        GROUP BY record.created_by_member_id, revision.revision_kind,
                 revision.boolean_result, revision.recorded_by_member_id`,
      [first.aggregateId],
    )
    expect(audit.rows[0]).toEqual({
      created_by_member_id: firstMemberId,
      revision_kind: 'recorded',
      boolean_result: 'not_done',
      recorded_by_member_id: firstMemberId,
      revisions: '4',
    })
  })

  it('enforces personal ownership while allowing shared create and correction', async () => {
    const personal = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute({
        ...recordCommand(personal),
        trustedActor: actor(secondMemberId),
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    expect(await digest()).not.toContain('weekly_task_result')

    await resetPair()
    const shared = await sharedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const first = await tracking.recordWeeklyTaskResult.execute({
      ...recordCommand(shared, randomUUID(), 'not_done'),
      trustedActor: actor(secondMemberId),
    })
    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'boolean', result: 'done' },
        reason: 'Общий результат уточнён',
      },
    })
    expect(corrected.aggregateRevision).toBe(2n)
    await expect(
      tracking.deleteRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: corrected.aggregateRevision,
        payload: { factRecordId: first.aggregateId, reason: 'Не разрешено' },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
  })

  it('rejects future, stale, missing and foreign periods without writes', async () => {
    const value = await publishedSeedFixture()
    const before = await digest()
    clock.set(new Date('2026-04-12T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ).rejects.toMatchObject({ reason: 'future_period' })
    clock.set(new Date('2026-04-20T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ).rejects.toMatchObject({ reason: 'stale_period' })
    await expect(
      tracking.recordWeeklyTaskResult.execute({
        ...recordCommand(value),
        payload: {
          ...recordCommand(value).payload,
          flexiblePeriodId: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(WeeklyTaskTargetNotFoundError)
    await expect(
      tracking.recordWeeklyTaskResult.execute({
        ...recordCommand(value),
        trustedActor: actor(secondMemberId),
        payload: {
          ...recordCommand(value).payload,
          publicationId: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(WeeklyTaskTargetNotFoundError)
    expect(await digest()).toBe(before)
  })

  it('rejects a pre-activation period before its late publication date', async () => {
    const value = await publishedSeedFixture(
      true,
      new Date('2026-04-15T07:00:00.000Z'),
    )
    const before = await digest()
    clock.set(new Date('2026-04-14T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ).rejects.toMatchObject({ reason: 'preactivation' })
    expect(await digest()).toBe(before)
  })

  it('serializes concurrent creates into one logical result', async () => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const results = await Promise.allSettled([
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(
      (
        results.find(
          (item) => item.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toBeInstanceOf(FactCorrectionRequiredError)
    const stored = await pool.query<Record<string, string>>(
      `SELECT count(*)::text records,
              (SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid)
                facts_revision
         FROM tracking_fact_records WHERE fact_kind = 'weekly_task_result'`,
      [value.planMonthId],
    )
    expect(stored.rows[0]).toEqual({ records: '1', facts_revision: '1' })
  })

  it.each<WeeklyTaskResultWritePhase>([
    'record',
    'revision',
    'pointer',
    'facts_revision',
    'history',
  ])('rolls back the complete transaction after %s', async (phase) => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const before = await digest()
    const failing = new RecordWeeklyTaskResultCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      new PrismaWeeklyTaskResultPersistence(provider, (current) => {
        if (current === phase) throw new Error(`fail after ${phase}`)
      }),
    )
    await expect(failing.execute(recordCommand(value))).rejects.toThrow(
      'Tracking dependency is unavailable',
    )
    expect(await digest()).toBe(before)
  })

  it('rejects duplicate, forged and mutable weekly result history in direct SQL', async () => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const result = await tracking.recordWeeklyTaskResult.execute(
      recordCommand(value),
    )
    const history = await pool.query<{
      readonly revision_id: string
      readonly action_id: string
    }>(
      `SELECT revision.id::text revision_id, action.id::text action_id
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
         JOIN tracking_fact_changes change
           ON change.after_revision_id = revision.id
         JOIN tracking_action_groups action ON action.id = change.action_id
        WHERE record.id = $1::uuid`,
      [result.aggregateId],
    )
    await expect(
      pool.query(
        `UPDATE tracking_fact_records SET local_date = local_date + 1
          WHERE id = $1::uuid`,
        [result.aggregateId],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `UPDATE tracking_fact_revisions SET boolean_result = 'not_done'
          WHERE id = $1::uuid`,
        [history.rows[0]!.revision_id],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `UPDATE tracking_action_groups SET occurred_at = occurred_at + interval '1 second'
          WHERE id = $1::uuid`,
        [history.rows[0]!.action_id],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `DELETE FROM tracking_fact_changes WHERE action_id = $1::uuid`,
        [history.rows[0]!.action_id],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           flexible_period_id, created_by_member_id, created_at, updated_at)
         SELECT gen_random_uuid(), space_id, plan_month_id, publication_id,
                plan_goal_snapshot_id, local_date, fact_kind,
                flexible_period_id, created_by_member_id, created_at, updated_at
           FROM tracking_fact_records WHERE id = $1::uuid`,
        [result.aggregateId],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint,
           result_kind, aggregate_id, aggregate_revision, completed_at)
         VALUES ('member:${firstMemberId}',
                 'tracking.record-weekly-task-result.v1', gen_random_uuid(),
                 repeat('0', 64), 'tracking.fact-record.v1', gen_random_uuid(),
                 1, now())`,
      ),
    ).rejects.toThrow()
  })

  it.each(['period', 'scope', 'value', 'action', 'receipt'] as const)(
    'rejects a complete direct-SQL envelope with forged %s',
    async (forgery) => {
      const value = await publishedSeedFixture()
      clock.set(new Date('2026-04-15T07:00:00.000Z'))
      await expectForgedEnvelopeRejected(value, forgery)
    },
  )

  it('uses the dedicated finite inactive error', async () => {
    const value = await publishedSeedFixture()
    clock.set(new Date('2026-03-31T07:00:00.000Z'))
    const cancelled = await planning.cancelPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: value.planMonthId,
        publicationId: value.publicationId,
      },
    })
    expect(cancelled.aggregateRevision).toBe(3n)
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(value)),
    ).rejects.toMatchObject({ reason: 'not_active' })

    await resetPair()
    const closed = await publishedSeedFixture()
    await pool.query(`
      ALTER TABLE plan_months DISABLE TRIGGER USER;
      UPDATE plan_months SET status = 'closed'
       WHERE id = '${closed.planMonthId}'::uuid;
      ALTER TABLE plan_months ENABLE TRIGGER USER;
    `)
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    await expect(
      tracking.recordWeeklyTaskResult.execute(recordCommand(closed)),
    ).rejects.toMatchObject({ reason: 'closed' })
  })
})
