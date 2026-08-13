import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  RecordWeeklyTaskResultPersistenceInput,
  WeeklyTaskResultPersistencePort,
  WeeklyTaskResultWritePhase,
} from '../application/weekly-task-result-persistence.port'
import type { FactRecordRef } from '../application/fact-persistence.port'
import {
  FactCorrectionRequiredError,
  TrackingAuthorizationDeniedError,
  WeeklyTaskAlreadySystemClosedError,
  WeeklyTaskTargetNotFoundError,
  WeeklyTaskTargetUnavailableError,
} from '../application/tracking-errors'

type WeeklyTaskTargetRow = {
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly active_publication_id: string | null
  readonly active_local_date: string
  readonly plan_goal_snapshot_id: string
  readonly period_start: string
  readonly period_end: string
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
}

type ExistingWeeklyTaskResultRow = {
  readonly existing_record_id: string
  readonly existing_revision: bigint
  readonly existing_actor_kind: string
}

export type WeeklyTaskResultWriteObserver = (
  phase: WeeklyTaskResultWritePhase,
) => void | Promise<void>

export class PrismaWeeklyTaskResultPersistence implements WeeklyTaskResultPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: WeeklyTaskResultWriteObserver = () =>
      undefined,
  ) {}

  public record(
    input: RecordWeeklyTaskResultPersistenceInput,
  ): Promise<FactRecordRef> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<WeeklyTaskTargetRow[]>`
        SELECT month.id::text plan_month_id, month.facts_revision,
               month.status, month.active_publication_id::text,
               publication.active_local_date::text,
               snapshot.id::text plan_goal_snapshot_id,
               period.period_start::text, period.period_end::text,
               snapshot.scope_kind, snapshot.owner_member_id::text
          FROM flexible_periods period
          JOIN plan_publications publication
            ON publication.id = period.publication_id
          JOIN plan_months month ON month.id = publication.plan_month_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.publication_id = period.publication_id
           AND snapshot.id = period.plan_goal_snapshot_id
         WHERE period.id = ${input.flexiblePeriodId}::uuid
           AND period.publication_id = ${input.publicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
           AND period.period_kind = 'weekly_planned_task'
           AND period.period_target = 1
           AND snapshot.config #>> '{repetition,kind}' = 'weekly_planned_task'
           AND snapshot.config #>> '{measurement,kind}' = 'boolean'
           AND snapshot.config -> 'checkpoints' = 'null'::jsonb
         FOR UPDATE OF month, period
      `
      const target = rows[0]
      if (target === undefined) throw new WeeklyTaskTargetNotFoundError()
      if (target.status === 'closed') {
        throw new WeeklyTaskTargetUnavailableError('closed')
      }
      if (
        target.active_publication_id !== input.publicationId ||
        target.status !== 'published'
      ) {
        throw new WeeklyTaskTargetUnavailableError('not_active')
      }
      if (input.currentLocalDate < target.active_local_date) {
        throw new WeeklyTaskTargetUnavailableError('preactivation')
      }
      if (input.currentLocalDate < target.period_start) {
        throw new WeeklyTaskTargetUnavailableError('future_period')
      }
      if (input.currentLocalDate > target.period_end) {
        throw new WeeklyTaskTargetUnavailableError('stale_period')
      }
      if (
        target.scope_kind === 'personal' &&
        target.owner_member_id !== input.memberId
      ) {
        throw new TrackingAuthorizationDeniedError()
      }
      // This second statement intentionally obtains a fresh READ COMMITTED
      // snapshot after a concurrent writer releases the month lock.
      const existingRows = await client.$queryRaw<
        ExistingWeeklyTaskResultRow[]
      >`
        SELECT record.id::text existing_record_id,
               revision.revision_number existing_revision,
               action.actor_kind existing_actor_kind
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN tracking_fact_changes change
            ON change.after_revision_id = revision.id
          JOIN tracking_action_groups action ON action.id = change.action_id
         WHERE record.flexible_period_id = ${input.flexiblePeriodId}::uuid
           AND record.fact_kind = 'weekly_task_result'
      `
      const existing = existingRows[0]
      if (existing !== undefined) {
        const existingRef = {
          factRecordId: existing.existing_record_id,
          revision: existing.existing_revision,
        }
        if (existing.existing_actor_kind === 'system') {
          throw new WeeklyTaskAlreadySystemClosedError(existingRef)
        }
        throw new FactCorrectionRequiredError(existingRef)
      }

      const factRecordId = randomUUID()
      const factRevisionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           fixed_expectation_id, flexible_period_id, contribution_id,
           checklist_item_id, or_variant_id, current_revision_id,
           created_by_member_id, created_at, updated_at)
        VALUES
          (${factRecordId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
           ${target.plan_goal_snapshot_id}::uuid, ${target.period_start}::date,
           'weekly_task_result', NULL, ${input.flexiblePeriodId}::uuid, NULL,
           NULL, NULL, NULL, ${input.memberId}::uuid,
           ${input.occurredAt}, ${input.occurredAt})
      `
      await this.afterWritePhase('record')
      await client.$executeRaw`
        INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           fixed_outcome, recorded_by_member_id, created_at)
        VALUES
          (${factRevisionId}::uuid, ${factRecordId}::uuid, 1, 'recorded',
           ${input.result}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           ${input.memberId}::uuid, ${input.occurredAt})
      `
      await this.afterWritePhase('revision')
      await client.$executeRaw`
        UPDATE tracking_fact_records
           SET current_revision_id = ${factRevisionId}::uuid
         WHERE id = ${factRecordId}::uuid
      `
      await this.afterWritePhase('pointer')

      const afterFactsRevision = target.facts_revision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${target.plan_month_id}::uuid
           AND facts_revision = ${target.facts_revision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
        VALUES
          (${actionId}::uuid, 'fact_recorded', 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
           ${target.plan_goal_snapshot_id}::uuid,
           'tracking.record-weekly-task-result.v1', ${input.commandId}::uuid,
           ${target.facts_revision}, ${afterFactsRevision}, NULL,
           ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
        VALUES
          (${actionId}::uuid, ${factRecordId}::uuid, NULL,
           ${factRevisionId}::uuid)
      `
      await this.afterWritePhase('history')
      return { factRecordId, factRevision: 1n }
    })
  }
}
