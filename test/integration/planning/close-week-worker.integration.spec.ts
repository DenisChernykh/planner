import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool, type PoolClient } from 'pg'

import {
  PlanningDependencyUnavailableError,
  createPlanningApplication,
  createPlanningLifecycleWorker,
  type PlanningApplication,
  type PlanningLifecycleWorker,
} from '@/modules/planning'
import { PrismaDueLifecycleRepository } from '@/modules/planning/infrastructure/due-lifecycle.repository'
import {
  WeeklyTaskAlreadySystemClosedError,
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const partnerUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const partnerMemberId = '55555555-5555-4555-8555-555555555555'

const migrationsThroughT09 = [
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
  '20260811167000_weekly_task_result',
] as const
const T10_MIGRATION = '20260811168000_close_week'

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly periodId: string
  readonly periodStart: string
  readonly periodEnd: string
}

type ForgedEnvelopeKind =
  'actor' | 'period' | 'effect_set' | 'value' | 'receipt'

describe('T10 CloseWeek worker on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t10_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrationsThroughT09) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    const runtimeConfig = {
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
    const members = new PrismaWorkspaceMemberResolver(provider)
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

    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${partnerUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${partnerMemberId}'::uuid, '${spaceId}'::uuid,
         '${partnerUserId}'::uuid, 2);
    `)
    const populated = await fixture(2)
    clock.set(new Date(`${populated.periodStart}T07:00:00.000Z`))
    await tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: populated.publicationId,
        flexiblePeriodId: populated.periodId,
        result: 'done',
      },
    })
    const beforeUpgrade = await legacyTrackingDigest()
    await pool.query(
      readFileSync(`prisma/migrations/${T10_MIGRATION}/migration.sql`, 'utf8'),
    )
    expect(await legacyTrackingDigest()).toBe(beforeUpgrade)
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    clock.set(new Date('2026-03-30T07:00:00.000Z'))
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${partnerUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${partnerMemberId}'::uuid, '${spaceId}'::uuid,
         '${partnerUserId}'::uuid, 2);
    `)
    clock.set(new Date('2026-03-30T07:00:00.000Z'))
  })

  function actor(): { readonly kind: 'member'; readonly id: string } {
    return { kind: 'member', id: memberId }
  }

  async function legacyTrackingDigest(): Promise<string> {
    const value = await pool.query<{ readonly digest: string }>(`
      SELECT jsonb_build_object(
        'records', (
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
            FROM (
              SELECT id, space_id, plan_month_id, publication_id,
                     plan_goal_snapshot_id, local_date, fact_kind,
                     fixed_expectation_id, flexible_period_id,
                     contribution_id, checklist_item_id, or_variant_id,
                     current_revision_id, created_by_member_id,
                     created_at, updated_at
                FROM tracking_fact_records
            ) row_value
        ),
        'revisions', (
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
            FROM (
              SELECT id, fact_record_id, revision_number, revision_kind,
                     boolean_result, quantity_value, actual_time_value,
                     rating_value, text_value, text_result,
                     checklist_item_state, or_variant_value, fixed_outcome,
                     recorded_by_member_id, created_at
                FROM tracking_fact_revisions
            ) row_value
        ),
        'actions', (
          SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
            FROM (
              SELECT id, action_kind, actor_kind, actor_scope, member_id,
                     space_id, plan_month_id, publication_id,
                     plan_goal_snapshot_id, command_type, command_id,
                     before_facts_revision, after_facts_revision, reason,
                     occurred_at
                FROM tracking_action_groups
            ) row_value
        ),
        'changes', (
          SELECT jsonb_agg(to_jsonb(row_value)
                           ORDER BY row_value.action_id, row_value.fact_record_id)
            FROM tracking_fact_changes row_value
        ),
        'receipts', (
          SELECT jsonb_agg(to_jsonb(row_value)
                           ORDER BY row_value.actor_scope,
                                    row_value.command_type,
                                    row_value.command_id)
            FROM command_receipts row_value
        )
      )::text digest
    `)
    return value.rows[0]!.digest
  }

  async function fixture(
    ordinal = 1,
    duplicateWeeklyTask = false,
  ): Promise<Fixture> {
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    if (duplicateWeeklyTask) {
      const editor = await planning.getDraftEditor.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      })
      if (editor === null) throw new Error('draft editor missing')
      const weekly = editor.goals.find(
        (goal) => goal.config.repetition.kind === 'weekly_planned_task',
      )
      const duplicate = editor.goals.find(
        (goal) => goal.planGoalId !== weekly?.planGoalId,
      )
      if (weekly === undefined || duplicate === undefined) {
        throw new Error('weekly duplication fixture missing')
      }
      await planning.updateDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: editor.draftRevision,
        payload: {
          planMonthId: draft.aggregateId,
          planGoalId: duplicate.planGoalId,
          goalDefinitionVersionId: duplicate.goalDefinitionVersionId,
          config: weekly.config,
          sourceProvenance: duplicate.sourceProvenance,
        },
      })
    }
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: userId,
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
      readonly id: string
      readonly period_start: string
      readonly period_end: string
    }>(
      `SELECT id::text, period_start::text, period_end::text
         FROM flexible_periods
        WHERE publication_id = $1::uuid
          AND period_kind = 'weekly_planned_task'
          AND ordinal = $2
        ORDER BY id
        LIMIT 1`,
      [publication.aggregateId, ordinal],
    )
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      periodId: period.rows[0]!.id,
      periodStart: period.rows[0]!.period_start,
      periodEnd: period.rows[0]!.period_end,
    }
  }

  function worker(
    repository = new PrismaDueLifecycleRepository(provider),
  ): PlanningLifecycleWorker {
    return createPlanningLifecycleWorker({
      database: provider,
      transaction,
      clock,
      lifecycle: repository,
    })
  }

  async function forgedEnvelopeCode(
    client: PoolClient,
    value: Fixture,
    kind: ForgedEnvelopeKind,
  ): Promise<string | undefined> {
    const factRecordId = randomUUID()
    const factRevisionId = randomUUID()
    const actionId = randomUUID()
    const target = await client.query<{
      readonly space_id: string
      readonly facts_revision: string
      readonly plan_goal_snapshot_id: string
      readonly period_start: string
      readonly period_end: string
      readonly stable_command_id: string
    }>(
      `SELECT month.space_id::text, month.facts_revision::text,
              period.plan_goal_snapshot_id::text,
              period.period_start::text, period.period_end::text,
              (
                SELECT stable.id::text FROM flexible_periods stable
                 WHERE stable.publication_id = period.publication_id
                   AND stable.period_kind = period.period_kind
                   AND stable.period_start = period.period_start
                   AND stable.period_end = period.period_end
                 ORDER BY stable.id LIMIT 1
              ) stable_command_id
         FROM flexible_periods period
         JOIN plan_publications publication
           ON publication.id = period.publication_id
         JOIN plan_months month ON month.id = publication.plan_month_id
        WHERE period.id = $1::uuid`,
      [value.periodId],
    )
    const row = target.rows[0]
    if (row === undefined) throw new Error('forged target missing')
    const occurredAt = new Date('2026-04-06T19:00:00.000Z')
    const afterFactsRevision = BigInt(row.facts_revision) + 1n
    const actorScope =
      kind === 'actor' ? `member:${memberId}` : 'system:planner-worker'
    const commandId = kind === 'period' ? randomUUID() : row.stable_command_id
    const receiptAggregateId = kind === 'receipt' ? randomUUID() : actionId

    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           fixed_expectation_id, flexible_period_id, contribution_id,
           checklist_item_id, or_variant_id, current_revision_id,
           created_by_member_id, created_by_system_actor_id,
           created_at, updated_at)
         VALUES
          ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date,
           'weekly_task_result', NULL, $7::uuid, NULL, NULL, NULL, NULL,
           NULL, 'planner-worker', $8, $8)`,
        [
          factRecordId,
          row.space_id,
          value.planMonthId,
          value.publicationId,
          row.plan_goal_snapshot_id,
          row.period_start,
          value.periodId,
          occurredAt,
        ],
      )
      await client.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           fixed_outcome, recorded_by_member_id,
           recorded_by_system_actor_id, created_at)
         VALUES
          ($1::uuid, $2::uuid, 1, 'recorded', $3, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, 'planner-worker', $4)`,
        [
          factRevisionId,
          factRecordId,
          kind === 'value' ? 'done' : 'not_done',
          occurredAt,
        ],
      )
      await client.query(
        `UPDATE tracking_fact_records
            SET current_revision_id = $1::uuid
          WHERE id = $2::uuid`,
        [factRevisionId, factRecordId],
      )
      await client.query(
        `UPDATE plan_months SET facts_revision = $1
          WHERE id = $2::uuid AND facts_revision = $3`,
        [afterFactsRevision, value.planMonthId, row.facts_revision],
      )
      await client.query(
        `INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, command_type, command_id,
           before_facts_revision, after_facts_revision, reason, occurred_at)
         VALUES
          ($1::uuid, 'week_closed', $2, $3, $4::uuid, $5, $6::uuid,
           $7::uuid, $8::uuid, NULL, 'planning.close-week.v1', $9::uuid,
           $10, $11, NULL, $12)`,
        [
          actionId,
          kind === 'actor' ? 'member' : 'system',
          actorScope,
          kind === 'actor' ? memberId : null,
          kind === 'actor' ? null : 'planner-worker',
          row.space_id,
          value.planMonthId,
          value.publicationId,
          commandId,
          row.facts_revision,
          afterFactsRevision,
          occurredAt,
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
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES
          ($1, 'planning.close-week.v1', $2::uuid, repeat('a', 64),
           'planning.week-close.v1', $3::uuid, $4, $5)`,
        [
          actorScope,
          commandId,
          receiptAggregateId,
          afterFactsRevision,
          occurredAt,
        ],
      )
      await client.query('COMMIT')
      return undefined
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined)
      return (error as { readonly code?: string }).code
    }
  }

  it('closes a due period as system not_done and exposes the author', async () => {
    const value = await fixture(1, true)
    clock.set(new Date('2026-04-06T19:00:00.000Z'))
    await worker().tick()

    const result = await pool.query<{
      readonly facts_revision: string
      readonly action_kind: string
      readonly actor_kind: string
      readonly system_actor_id: string
      readonly boolean_result: string
      readonly recorded_by_member_id: string | null
      readonly recorded_by_system_actor_id: string
    }>(
      `SELECT month.facts_revision::text, action.action_kind,
              action.actor_kind, action.system_actor_id,
              revision.boolean_result,
              revision.recorded_by_member_id::text,
              revision.recorded_by_system_actor_id
         FROM plan_months month
         JOIN tracking_action_groups action
           ON action.plan_month_id = month.id
          AND action.command_type = 'planning.close-week.v1'
         JOIN tracking_fact_changes change ON change.action_id = action.id
         JOIN tracking_fact_revisions revision
           ON revision.id = change.after_revision_id
        WHERE month.id = $1::uuid`,
      [value.planMonthId],
    )
    expect(result.rows).toHaveLength(2)
    expect(
      new Set(
        result.rows.map((row) =>
          [
            row.facts_revision,
            row.action_kind,
            row.actor_kind,
            row.system_actor_id,
            row.boolean_result,
            row.recorded_by_member_id ?? 'null',
            row.recorded_by_system_actor_id,
          ].join(':'),
        ),
      ),
    ).toEqual(
      new Set([
        '1:week_closed:system:planner-worker:not_done:null:planner-worker',
      ]),
    )

    const month = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published read missing')
    const weeklyFact = month.days
      .flatMap((day) => day.goals)
      .flatMap((goal) => goal.flexiblePeriods)
      .flatMap((period) => period.facts)
      .find((fact) => fact.factKind === 'weekly_task_result')
    expect(weeklyFact).toMatchObject({
      recordedByMemberId: null,
      recordedBySystemActorId: 'planner-worker',
      value: { kind: 'boolean', result: 'not_done' },
    })
    await expect(
      tracking.recordWeeklyTaskResult.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: value.publicationId,
          flexiblePeriodId: value.periodId,
          result: 'done',
        },
      }),
    ).rejects.toBeInstanceOf(WeeklyTaskAlreadySystemClosedError)
  })

  it('preserves user results and serializes duplicate runners', async () => {
    const value = await fixture(2, true)
    clock.set(new Date(`${value.periodStart}T07:00:00.000Z`))
    await tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        flexiblePeriodId: value.periodId,
        result: 'done',
      },
    })
    const third = await pool.query<{
      readonly id: string
      readonly period_end: string
    }>(
      `SELECT id::text, period_end::text FROM flexible_periods
        WHERE publication_id = $1::uuid
          AND period_kind = 'weekly_planned_task' AND ordinal = 3`,
      [value.publicationId],
    )
    clock.set(new Date('2026-04-20T19:00:00.000Z'))
    await Promise.all([worker().tick(), worker().tick()])

    const counts = await pool.query<{
      readonly close_actions: string
      readonly user_done: string
      readonly system_not_done: string
    }>(
      `SELECT
         count(*) FILTER (WHERE action.command_type = 'planning.close-week.v1')::text close_actions,
         count(*) FILTER (WHERE revision.boolean_result = 'done')::text user_done,
         count(*) FILTER (
           WHERE revision.boolean_result = 'not_done'
             AND revision.recorded_by_system_actor_id = 'planner-worker'
         )::text system_not_done
       FROM tracking_action_groups action
       JOIN tracking_fact_changes change ON change.action_id = action.id
       JOIN tracking_fact_revisions revision ON revision.id = change.after_revision_id`,
    )
    expect(third.rows[0]).toBeDefined()
    expect(counts.rows[0]).toEqual({
      close_actions: '3',
      user_done: '1',
      system_not_done: '3',
    })
    const userCurrent = await pool.query<{ readonly result: string }>(
      `SELECT revision.boolean_result result
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
        WHERE record.flexible_period_id = $1::uuid`,
      [value.periodId],
    )
    expect(userCurrent.rows[0]?.result).toBe('done')
  })

  it('serializes a member write that races the system close', async () => {
    const value = await fixture(1)
    clock.set(new Date('2026-04-06T19:00:00.000Z'))
    let release: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedRecords: (() => void) | undefined
    const recordsReached = new Promise<void>((resolve) => {
      reachedRecords = resolve
    })
    const repository = new PrismaDueLifecycleRepository(
      provider,
      async (phase) => {
        if (phase !== 'records') return
        reachedRecords?.()
        await hold
      },
    )
    const systemWrite = worker(repository).tick()
    await recordsReached
    const memberWrite = tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        flexiblePeriodId: value.periodId,
        result: 'done',
      },
    })
    release?.()

    await expect(systemWrite).resolves.toBeUndefined()
    await expect(memberWrite).rejects.toBeInstanceOf(
      WeeklyTaskAlreadySystemClosedError,
    )
    const result = await pool.query<{
      readonly records: string
      readonly system_actions: string
      readonly member_actions: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM tracking_fact_records) records,
        count(*) FILTER (WHERE actor_kind = 'system')::text system_actions,
        count(*) FILTER (WHERE actor_kind = 'member')::text member_actions
      FROM tracking_action_groups
    `)
    expect(result.rows[0]).toEqual({
      records: '1',
      system_actions: '1',
      member_actions: '0',
    })
  })

  it('uses a new deterministic generation after a system result is deleted', async () => {
    const value = await fixture(1)
    clock.set(new Date('2026-04-06T19:00:00.000Z'))
    await worker().tick()
    const first = await pool.query<{
      readonly record_id: string
      readonly revision_number: string
    }>(
      `SELECT record.id::text record_id, revision.revision_number::text
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
        WHERE record.flexible_period_id = $1::uuid`,
      [value.periodId],
    )
    const record = first.rows[0]
    if (record === undefined) throw new Error('first system result missing')
    await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(record.revision_number),
      payload: {
        factRecordId: record.record_id,
        reason: 'Задача снова осталась незаполненной',
      },
    })
    await Promise.all([worker().tick(), worker().tick()])

    const result = await pool.query<{
      readonly revision_number: string
      readonly revision_kind: string
      readonly boolean_result: string
      readonly system_actor: string
      readonly close_actions: string
      readonly close_receipts: string
      readonly command_ids: string
      readonly facts_revision: string
    }>(
      `SELECT revision.revision_number::text, revision.revision_kind,
              revision.boolean_result,
              revision.recorded_by_system_actor_id system_actor,
              (
                SELECT count(*)::text FROM tracking_action_groups action
                 WHERE action.command_type = 'planning.close-week.v1'
              ) close_actions,
              (
                SELECT count(*)::text FROM command_receipts receipt
                 WHERE receipt.command_type = 'planning.close-week.v1'
              ) close_receipts,
              (
                SELECT count(DISTINCT action.command_id)::text
                  FROM tracking_action_groups action
                 WHERE action.command_type = 'planning.close-week.v1'
              ) command_ids,
              month.facts_revision::text
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
         JOIN plan_months month ON month.id = record.plan_month_id
        WHERE record.id = $1::uuid`,
      [record.record_id],
    )
    expect(result.rows[0]).toEqual({
      revision_number: '3',
      revision_kind: 'recorded',
      boolean_result: 'not_done',
      system_actor: 'planner-worker',
      close_actions: '2',
      close_receipts: '2',
      command_ids: '2',
      facts_revision: '3',
    })
  })

  it('closes the final clipped week exactly at the month boundary', async () => {
    const value = await fixture(5)
    expect(value.periodEnd).toBe('2026-04-30')
    clock.set(new Date('2026-04-30T18:59:59.000Z'))
    await worker().tick()
    const before = await pool.query<{
      readonly facts_revision: string
      readonly target_records: string
    }>(
      `SELECT month.facts_revision::text,
              count(record.id) FILTER (
                WHERE record.flexible_period_id = $2::uuid
              )::text target_records
         FROM plan_months month
         LEFT JOIN tracking_fact_records record
           ON record.plan_month_id = month.id
        WHERE month.id = $1::uuid
        GROUP BY month.id`,
      [value.planMonthId, value.periodId],
    )
    expect(before.rows[0]?.target_records).toBe('0')

    clock.set(new Date('2026-04-30T19:00:00.000Z'))
    await Promise.all([worker().tick(), worker().tick()])
    const after = await pool.query<{
      readonly facts_revision: string
      readonly target_records: string
      readonly target_actions: string
    }>(
      `SELECT month.facts_revision::text,
              count(DISTINCT record.id) FILTER (
                WHERE record.flexible_period_id = $2::uuid
              )::text target_records,
              count(DISTINCT action.id) FILTER (
                WHERE record.flexible_period_id = $2::uuid
              )::text target_actions
         FROM plan_months month
         LEFT JOIN tracking_fact_records record
           ON record.plan_month_id = month.id
         LEFT JOIN tracking_fact_changes change
           ON change.fact_record_id = record.id
         LEFT JOIN tracking_action_groups action ON action.id = change.action_id
        WHERE month.id = $1::uuid
        GROUP BY month.id`,
      [value.planMonthId, value.periodId],
    )
    expect(after.rows[0]).toEqual({
      facts_revision: (BigInt(before.rows[0]!.facts_revision) + 1n).toString(),
      target_records: '1',
      target_actions: '1',
    })
  })

  it('recloses a tombstone and keeps correction, delete and Undo compatible', async () => {
    const value = await fixture(4)
    clock.set(new Date(`${value.periodStart}T07:00:00.000Z`))
    const recorded = await tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        flexiblePeriodId: value.periodId,
        result: 'done',
      },
    })
    const tombstone = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: recorded.aggregateRevision,
      payload: {
        factRecordId: recorded.aggregateId,
        reason: 'Отменён преждевременный результат',
      },
    })
    expect(tombstone.aggregateRevision).toBe(2n)

    clock.set(new Date('2026-04-26T19:00:00.000Z'))
    await worker().tick()
    const systemRevision = await pool.query<{
      readonly revision_number: string
      readonly before_revision_id: string
      readonly recorded_by_system_actor_id: string
    }>(
      `SELECT revision.revision_number::text,
              change.before_revision_id::text,
              revision.recorded_by_system_actor_id
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
         JOIN tracking_fact_changes change
           ON change.after_revision_id = revision.id
        WHERE record.id = $1::uuid`,
      [recorded.aggregateId],
    )
    expect(systemRevision.rows[0]?.revision_number).toBe('3')
    expect(typeof systemRevision.rows[0]?.before_revision_id).toBe('string')
    expect(systemRevision.rows[0]?.recorded_by_system_actor_id).toBe(
      'planner-worker',
    )

    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 3n,
      payload: {
        factRecordId: recorded.aggregateId,
        value: { kind: 'boolean', result: 'done' },
        reason: 'Результат восстановлен в grace window',
      },
    })
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: corrected.aggregateRevision,
      payload: {
        factRecordId: recorded.aggregateId,
        reason: 'Проверка удаления системного результата',
      },
    })
    const restored = await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: deleted.aggregateRevision,
      payload: { factRecordId: recorded.aggregateId },
    })
    expect(restored.aggregateRevision).toBe(6n)
    const current = await pool.query<{
      readonly boolean_result: string
      readonly recorded_by_member_id: string
    }>(
      `SELECT revision.boolean_result,
              revision.recorded_by_member_id::text
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.id = record.current_revision_id
        WHERE record.id = $1::uuid`,
      [recorded.aggregateId],
    )
    expect(current.rows[0]).toEqual({
      boolean_result: 'done',
      recorded_by_member_id: memberId,
    })
  })

  it('rolls back every write phase and rejects orphan receipts', async () => {
    const phases = [
      'records',
      'revisions',
      'pointers',
      'facts_revision',
      'history',
    ] as const
    for (const phase of phases) {
      await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
      await pool.query(`
        INSERT INTO users (id) VALUES
          ('${userId}'::uuid), ('${partnerUserId}'::uuid);
        INSERT INTO spaces (id, singleton_key)
        VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot) VALUES
          ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
          ('${partnerMemberId}'::uuid, '${spaceId}'::uuid,
           '${partnerUserId}'::uuid, 2);
      `)
      clock.set(new Date('2026-03-30T07:00:00.000Z'))
      const value = await fixture(1)
      clock.set(new Date('2026-04-06T19:00:00.000Z'))
      const repository = new PrismaDueLifecycleRepository(provider, (seen) => {
        if (seen === phase) throw new Error(`fail:${phase}`)
      })
      await expect(worker(repository).tick()).rejects.toBeInstanceOf(
        PlanningDependencyUnavailableError,
      )
      const residue = await pool.query<{ readonly count: string }>(
        `SELECT (
           (SELECT count(*) FROM tracking_fact_records) +
           (SELECT count(*) FROM tracking_fact_revisions) +
           (SELECT count(*) FROM tracking_action_groups) +
           (SELECT count(*) FROM tracking_fact_changes) +
           (SELECT count(*) FROM command_receipts
             WHERE command_type = 'planning.close-week.v1')
         )::text count`,
      )
      expect(residue.rows[0]?.count).toBe('0')
      expect(
        (
          await pool.query<{ readonly facts_revision: string }>(
            'SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid',
            [value.planMonthId],
          )
        ).rows[0]?.facts_revision,
      ).toBe('0')
    }

    await expect(
      pool.query(`
        BEGIN;
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('system:planner-worker', 'planning.close-week.v1',
           gen_random_uuid(), repeat('a', 64), 'planning.week-close.v1',
           gen_random_uuid(), 1, now());
        COMMIT;
      `),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query('ROLLBACK').catch(() => undefined)
  })

  it.each<ForgedEnvelopeKind>([
    'actor',
    'period',
    'effect_set',
    'value',
    'receipt',
  ])('rejects a forged %s CloseWeek envelope at commit', async (kind) => {
    const value = await fixture(1, kind === 'effect_set')
    const client = await pool.connect()
    try {
      await expect(forgedEnvelopeCode(client, value, kind)).resolves.toBe(
        '23514',
      )
    } finally {
      client.release()
    }
    expect(
      (
        await pool.query<{ readonly facts_revision: string }>(
          'SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid',
          [value.planMonthId],
        )
      ).rows[0]?.facts_revision,
    ).toBe('0')
  })

  it('keeps system revisions, actions and changes immutable', async () => {
    await fixture(1)
    clock.set(new Date('2026-04-06T19:00:00.000Z'))
    await worker().tick()
    const history = await pool.query<{
      readonly action_id: string
      readonly revision_id: string
    }>(
      `SELECT action.id::text action_id, revision.id::text revision_id
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change ON change.action_id = action.id
         JOIN tracking_fact_revisions revision
           ON revision.id = change.after_revision_id
        WHERE action.command_type = 'planning.close-week.v1'
        LIMIT 1`,
    )
    const row = history.rows[0]
    if (row === undefined) throw new Error('system history missing')
    await expect(
      pool.query(
        `UPDATE tracking_fact_revisions SET boolean_result = 'done'
          WHERE id = $1::uuid`,
        [row.revision_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `UPDATE tracking_action_groups SET occurred_at = occurred_at + interval '1 second'
          WHERE id = $1::uuid`,
        [row.action_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        'DELETE FROM tracking_fact_changes WHERE action_id = $1::uuid',
        [row.action_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})
