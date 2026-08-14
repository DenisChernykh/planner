import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

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

export class PrismaDueLifecycleRepository implements DueLifecycleRepositoryPort {
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
        !['published', 'grace'].includes(month.status)
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
}
