import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  CloseMonthLifecycleRepositoryPort,
  CloseMonthPersistenceInput,
  CloseMonthPersistenceResult,
  CloseMonthReportPort,
  StartMonthGracePersistenceInput,
  StartMonthGracePersistenceResult,
} from '../application/close-month.command'
import { CloseMonthNoWorkError } from '../application/close-month.command'
import { StartMonthGraceNoWorkError } from '../application/start-month-grace.command'
import type {
  CloseWeekPersistenceInput,
  CloseWeekPersistenceResult,
  DueLifecycleRepositoryPort,
  DueWeekGroup,
} from '../application/close-week.command'
import { CloseWeekNoWorkError } from '../application/close-week.command'

type DueGroupRow = {
  readonly base_command_id: string
  readonly closure_generation: bigint
  readonly publication_id: string
  readonly period_start: string
  readonly period_end: string
}

function generatedCommandId(baseCommandId: string, generation: bigint): string {
  if (generation === 0n) return baseCommandId
  const hash = createHash('md5')
    .update(`planning.close-week.v1:${baseCommandId}:${generation}`)
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-3${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

type MonthRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly lifecycle_mode: 'ordinary' | 'reopened'
  readonly active_publication_id: string | null
  readonly active_local_date: string
}

type TargetRow = {
  readonly flexible_period_id: string
  readonly plan_goal_snapshot_id: string
  readonly period_start: string
  readonly period_end: string
  readonly fact_record_id: string | null
  readonly current_revision_id: string | null
  readonly revision_number: bigint | null
  readonly revision_kind: 'recorded' | 'tombstoned' | null
}

type Effect = {
  readonly factRecordId: string
  readonly beforeRevisionId: string | null
  readonly afterRevisionId: string
}

export type CloseWeekWritePhase =
  'records' | 'revisions' | 'pointers' | 'facts_revision' | 'history'

export type CloseWeekWriteObserver = (
  phase: CloseWeekWritePhase,
) => void | Promise<void>

type DueMonthRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly publication_id: string
  readonly publication_revision: bigint
  readonly publication_snapshot_hash: string
  readonly month_revision: bigint
  readonly facts_revision: bigint
  readonly month_start: string
  readonly status: 'published' | 'grace'
  readonly lifecycle_mode: 'ordinary' | 'reopened'
}

function localDateAt(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

export class PrismaDueLifecycleRepository
  implements DueLifecycleRepositoryPort, CloseMonthLifecycleRepositoryPort
{
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: CloseWeekWriteObserver = () => undefined,
  ) {}

  public findDueWeekGroups(input: {
    readonly currentLocalDate: string
    readonly limit: number
  }): Promise<readonly DueWeekGroup[]> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<DueGroupRow[]>`
        SELECT (
                 SELECT stable_period.id
                   FROM flexible_periods stable_period
                  WHERE stable_period.publication_id = period.publication_id
                    AND stable_period.period_kind = 'weekly_planned_task'
                    AND stable_period.period_start = period.period_start
                    AND stable_period.period_end = period.period_end
                  ORDER BY stable_period.id
                  LIMIT 1
               )::text base_command_id,
               (
                 SELECT count(DISTINCT prior_action.id)
                   FROM tracking_action_groups prior_action
                   JOIN tracking_fact_changes prior_change
                     ON prior_change.action_id = prior_action.id
                   JOIN tracking_fact_records prior_record
                     ON prior_record.id = prior_change.fact_record_id
                   JOIN flexible_periods prior_period
                     ON prior_period.id = prior_record.flexible_period_id
                  WHERE prior_action.command_type = 'planning.close-week.v1'
                    AND prior_action.publication_id = period.publication_id
                    AND prior_period.period_start = period.period_start
                    AND prior_period.period_end = period.period_end
               ) closure_generation,
               period.publication_id::text,
               period.period_start::text,
               period.period_end::text
          FROM flexible_periods period
          JOIN plan_publications publication
            ON publication.id = period.publication_id
          JOIN plan_months month
            ON month.id = publication.plan_month_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.id = period.plan_goal_snapshot_id
           AND snapshot.publication_id = period.publication_id
          LEFT JOIN tracking_fact_records record
            ON record.flexible_period_id = period.id
           AND record.fact_kind = 'weekly_task_result'
          LEFT JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
         WHERE period.period_kind = 'weekly_planned_task'
           AND period.period_target = 1
           AND snapshot.config #>> '{repetition,kind}' = 'weekly_planned_task'
           AND snapshot.config #>> '{measurement,kind}' = 'boolean'
           AND month.active_publication_id = publication.id
           AND month.status IN ('published', 'grace')
           AND month.lifecycle_mode = 'ordinary'
           AND period.period_end < ${input.currentLocalDate}::date
           AND (record.id IS NULL OR revision.revision_kind = 'tombstoned')
         GROUP BY period.publication_id, period.period_start, period.period_end
         ORDER BY period.period_end, period.publication_id, period.period_start
         LIMIT ${input.limit}
      `
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            commandId: generatedCommandId(
              row.base_command_id,
              row.closure_generation,
            ),
            publicationId: row.publication_id,
            periodStart: row.period_start,
            periodEnd: row.period_end,
          }),
        ),
      )
    })
  }

  public closeWeek(
    input: CloseWeekPersistenceInput,
  ): Promise<CloseWeekPersistenceResult> {
    return this.database.withClient(async (client) => {
      const months = await client.$queryRaw<MonthRow[]>`
        SELECT month.id::text plan_month_id, month.space_id::text,
               month.facts_revision, month.status,
               COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') lifecycle_mode,
               month.active_publication_id::text,
               publication.active_local_date::text
          FROM plan_publications publication
          JOIN plan_months month ON month.id = publication.plan_month_id
         WHERE publication.id = ${input.publicationId}::uuid
         FOR UPDATE OF month
      `
      const month = months[0]
      if (
        month === undefined ||
        month.active_publication_id !== input.publicationId ||
        !['published', 'grace'].includes(month.status) ||
        month.lifecycle_mode !== 'ordinary'
      ) {
        throw new CloseWeekNoWorkError()
      }
      const occurredLocalDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Yekaterinburg',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(input.occurredAt)
      if (occurredLocalDate <= input.periodEnd) {
        throw new CloseWeekNoWorkError()
      }

      const targets = await client.$queryRaw<TargetRow[]>`
        SELECT period.id::text flexible_period_id,
               period.plan_goal_snapshot_id::text,
               period.period_start::text, period.period_end::text,
               record.id::text fact_record_id,
               record.current_revision_id::text,
               revision.revision_number, revision.revision_kind
          FROM flexible_periods period
          JOIN plan_goal_snapshots snapshot
            ON snapshot.id = period.plan_goal_snapshot_id
           AND snapshot.publication_id = period.publication_id
          LEFT JOIN tracking_fact_records record
            ON record.flexible_period_id = period.id
           AND record.fact_kind = 'weekly_task_result'
          LEFT JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
         WHERE period.publication_id = ${input.publicationId}::uuid
           AND period.period_start = ${input.periodStart}::date
           AND period.period_end = ${input.periodEnd}::date
           AND period.period_kind = 'weekly_planned_task'
           AND period.period_target = 1
           AND snapshot.config #>> '{repetition,kind}' = 'weekly_planned_task'
           AND snapshot.config #>> '{measurement,kind}' = 'boolean'
           AND snapshot.config -> 'checkpoints' = 'null'::jsonb
         ORDER BY period.id
      `
      const unresolved = targets.filter(
        (target) =>
          target.fact_record_id === null ||
          target.revision_kind === 'tombstoned',
      )
      if (unresolved.length === 0) throw new CloseWeekNoWorkError()
      if (unresolved.length > 200) {
        throw new Error('CloseWeek exceeds the publication goal limit')
      }

      const effects: Effect[] = []
      for (const target of unresolved) {
        const factRecordId = target.fact_record_id ?? randomUUID()
        const afterRevisionId = randomUUID()
        if (target.fact_record_id === null) {
          await client.$executeRaw`
            INSERT INTO tracking_fact_records
              (id, space_id, plan_month_id, publication_id,
               plan_goal_snapshot_id, local_date, fact_kind,
               fixed_expectation_id, flexible_period_id, contribution_id,
               checklist_item_id, or_variant_id, current_revision_id,
               created_by_member_id, created_by_system_actor_id,
               created_at, updated_at)
            VALUES
              (${factRecordId}::uuid, ${month.space_id}::uuid,
               ${month.plan_month_id}::uuid, ${input.publicationId}::uuid,
               ${target.plan_goal_snapshot_id}::uuid,
               ${target.period_start}::date, 'weekly_task_result', NULL,
               ${target.flexible_period_id}::uuid, NULL, NULL, NULL, NULL,
               NULL, 'planner-worker', ${input.occurredAt}, ${input.occurredAt})
          `
        }
        const revisionNumber = (target.revision_number ?? 0n) + 1n
        await client.$executeRaw`
          INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, actual_time_value, rating_value,
             text_value, text_result, checklist_item_state, or_variant_value,
             fixed_outcome, recorded_by_member_id,
             recorded_by_system_actor_id, created_at)
          VALUES
            (${afterRevisionId}::uuid, ${factRecordId}::uuid,
             ${revisionNumber}, 'recorded', 'not_done', NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, 'planner-worker',
             ${input.occurredAt})
        `
        effects.push({
          factRecordId,
          beforeRevisionId: target.current_revision_id,
          afterRevisionId,
        })
      }
      await this.afterWritePhase('records')
      await this.afterWritePhase('revisions')

      for (const effect of effects) {
        await client.$executeRaw`
          UPDATE tracking_fact_records
             SET current_revision_id = ${effect.afterRevisionId}::uuid,
                 updated_at = ${input.occurredAt}
           WHERE id = ${effect.factRecordId}::uuid
        `
      }
      await this.afterWritePhase('pointers')

      const afterFactsRevision = month.facts_revision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${month.plan_month_id}::uuid
           AND facts_revision = ${month.facts_revision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, command_type, command_id,
           before_facts_revision, after_facts_revision, reason, occurred_at)
        VALUES
          (${actionId}::uuid, 'week_closed', 'system',
           'system:planner-worker', NULL, 'planner-worker',
           ${month.space_id}::uuid, ${month.plan_month_id}::uuid,
           ${input.publicationId}::uuid, NULL, 'planning.close-week.v1',
           ${input.commandId}::uuid, ${month.facts_revision},
           ${afterFactsRevision}, NULL, ${input.occurredAt})
      `
      for (const effect of effects) {
        await client.$executeRaw`
          INSERT INTO tracking_fact_changes
            (action_id, fact_record_id, before_revision_id, after_revision_id)
          VALUES
            (${actionId}::uuid, ${effect.factRecordId}::uuid,
             ${effect.beforeRevisionId}::uuid,
             ${effect.afterRevisionId}::uuid)
        `
      }
      await this.afterWritePhase('history')
      return { actionId, factsRevision: afterFactsRevision }
    })
  }

  public findDueMonthGrace(input: {
    readonly currentLocalDate: string
    readonly limit: number
  }): Promise<
    readonly {
      readonly commandId: string
      readonly planMonthId: string
      readonly expectedRevision: string
    }[]
  > {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<
        { readonly plan_month_id: string; readonly revision: bigint }[]
      >`
        SELECT month.id::text plan_month_id, month.revision
          FROM plan_months month
         WHERE month.status = 'published'
           AND COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') = 'ordinary'
           AND month.active_publication_id IS NOT NULL
           AND month.month_start + INTERVAL '1 month'
                 <= ${input.currentLocalDate}::date
         ORDER BY month.month_start, month.id
         LIMIT ${input.limit}
      `
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            commandId: row.plan_month_id,
            planMonthId: row.plan_month_id,
            expectedRevision: row.revision.toString(10),
          }),
        ),
      )
    })
  }

  public startMonthGrace(
    input: StartMonthGracePersistenceInput,
  ): Promise<StartMonthGracePersistenceResult> {
    return this.database.withClient(async (client) => {
      const months = await client.$queryRaw<
        {
          readonly plan_month_id: string
          readonly revision: bigint
          readonly status: 'published' | 'grace' | 'closed' | 'draft'
          readonly active_publication_id: string | null
        }[]
      >`
        SELECT month.id::text plan_month_id, month.revision, month.status,
               month.active_publication_id::text
          FROM plan_months month
         WHERE month.id = ${input.planMonthId}::uuid
         FOR UPDATE
      `
      const month = months[0]
      if (
        month === undefined ||
        month.status !== 'published' ||
        month.active_publication_id === null ||
        month.revision !== input.expectedRevision
      ) {
        throw new StartMonthGraceNoWorkError()
      }
      const due = await client.$queryRaw<{ readonly due: boolean }[]>`
        SELECT (
          (SELECT month_start FROM plan_months WHERE id = ${input.planMonthId}::uuid)
          + INTERVAL '1 month' <= ${localDateAt(input.occurredAt)}::date
        ) due
      `
      if (due[0]?.due !== true) throw new StartMonthGraceNoWorkError()
      const nextRevision = input.expectedRevision + 1n
      const updated = await client.$executeRaw`
        UPDATE plan_months
           SET status = 'grace', revision = ${nextRevision},
               updated_at = ${input.occurredAt}
         WHERE id = ${input.planMonthId}::uuid
           AND status = 'published'
           AND revision = ${input.expectedRevision}
      `
      if (updated !== 1) throw new StartMonthGraceNoWorkError()
      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'month_grace_started', 'system',
           'system:planner-worker', NULL, 'planner-worker',
           ${input.planMonthId}::uuid, NULL,
           'planning.start-month-grace.v1', ${input.commandId}::uuid,
           ${input.expectedRevision}, ${nextRevision}, ${input.occurredAt})
      `
      return { lifecycleRevision: nextRevision }
    })
  }

  public findDueMonthClosures(input: {
    readonly currentLocalDate: string
    readonly limit: number
  }): Promise<
    readonly { readonly commandId: string; readonly planMonthId: string }[]
  > {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<{ readonly plan_month_id: string }[]>`
        SELECT month.id::text plan_month_id
          FROM plan_months month
         WHERE month.status = 'grace'
           AND COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') = 'ordinary'
           AND month.active_publication_id IS NOT NULL
           AND month.month_start + INTERVAL '1 month' + INTERVAL '3 days'
                 <= ${input.currentLocalDate}::date
         ORDER BY month.month_start, month.id
         LIMIT ${input.limit}
      `
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            commandId: row.plan_month_id,
            planMonthId: row.plan_month_id,
          }),
        ),
      )
    })
  }

  public closeMonth(
    input: CloseMonthPersistenceInput,
    report: CloseMonthReportPort,
  ): Promise<CloseMonthPersistenceResult> {
    return this.database.withClient(async (client) => {
      const months = await client.$queryRaw<DueMonthRow[]>`
        SELECT month.id::text plan_month_id,
               month.space_id::text,
               publication.id::text publication_id,
               publication.publication_revision,
               publication.preview_hash publication_snapshot_hash,
               month.revision month_revision,
               month.facts_revision,
               month.month_start::text,
               month.status,
               COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary') lifecycle_mode
          FROM plan_months month
          JOIN plan_publications publication
            ON publication.id = month.active_publication_id
         WHERE month.id = ${input.planMonthId}::uuid
         FOR UPDATE OF month
      `
      const month = months[0]
      if (
        month === undefined ||
        month.status !== 'grace' ||
        month.lifecycle_mode !== 'ordinary' ||
        month.publication_id === undefined
      ) {
        throw new CloseMonthNoWorkError()
      }
      const currentLocalDate = localDateAt(input.occurredAt)
      const due = await client.$queryRaw<{ readonly due: boolean }[]>`
        SELECT (
          ${month.month_start}::date + INTERVAL '1 month' + INTERVAL '3 days'
          <= ${currentLocalDate}::date
        ) due
      `
      if (due[0]?.due !== true) throw new CloseMonthNoWorkError()

      const unresolvedWeeks = await client.$queryRaw<
        { readonly due: boolean }[]
      >`
        SELECT EXISTS (
          SELECT 1
            FROM flexible_periods period
            JOIN plan_goal_snapshots snapshot
              ON snapshot.id = period.plan_goal_snapshot_id
             AND snapshot.publication_id = period.publication_id
            LEFT JOIN tracking_fact_records record
              ON record.flexible_period_id = period.id
             AND record.fact_kind = 'weekly_task_result'
            LEFT JOIN tracking_fact_revisions revision
              ON revision.id = record.current_revision_id
           WHERE period.publication_id = ${month.publication_id}::uuid
             AND period.period_kind = 'weekly_planned_task'
             AND period.period_target = 1
             AND snapshot.config #>> '{repetition,kind}' = 'weekly_planned_task'
             AND snapshot.config #>> '{measurement,kind}' = 'boolean'
             AND period.period_end < ${currentLocalDate}::date
             AND (record.id IS NULL OR revision.revision_kind = 'tombstoned')
        ) due
      `
      if (unresolvedWeeks[0]?.due === true) throw new CloseMonthNoWorkError()

      const asOfLocalDate = await client.$queryRaw<
        { readonly month_end: string }[]
      >`
        SELECT (${month.month_start}::date + INTERVAL '1 month' - INTERVAL '1 day')::date::text month_end
      `
      const reportSnapshot = await report.persist({
        spaceId: month.space_id,
        planMonthId: month.plan_month_id,
        publicationId: month.publication_id,
        asOfLocalDate: asOfLocalDate[0]!.month_end,
        publicationSnapshotHash: month.publication_snapshot_hash,
        occurredAt: input.occurredAt,
        revisionStatus: input.revisionStatus,
        createdBy: input.createdBy,
      })
      if (reportSnapshot.factsRevision !== month.facts_revision) {
        throw new Error('CloseMonth report snapshot is stale')
      }
      const lifecycleRevision = month.month_revision + 1n
      const updated = await client.$executeRaw`
        UPDATE plan_months
           SET status = 'closed',
               revision = ${lifecycleRevision},
               updated_at = ${input.occurredAt}
         WHERE id = ${month.plan_month_id}::uuid
           AND revision = ${month.month_revision}
           AND status = 'grace'
           AND lifecycle_mode = 'ordinary'
      `
      if (updated !== 1) throw new Error('CloseMonth lifecycle CAS failed')
      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'month_closed', 'system',
           'system:planner-worker', NULL, 'planner-worker',
           ${month.plan_month_id}::uuid, NULL,
           'planning.close-month.v1', ${input.commandId}::uuid,
           ${month.month_revision}, ${lifecycleRevision}, ${input.occurredAt})
      `
      return {
        reportRevisionId: reportSnapshot.reportRevisionId,
        reportRevision: reportSnapshot.revision,
        lifecycleRevision,
      }
    })
  }
}
