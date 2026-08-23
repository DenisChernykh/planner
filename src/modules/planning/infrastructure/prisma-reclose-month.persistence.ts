import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  RecloseMonthPersistenceInput,
  RecloseMonthPersistencePort,
  RecloseMonthPersistenceResult,
} from '../application/reclose-month.command'
import type { CloseMonthReportPort } from '../application/close-month.command'
import {
  PlanMonthNotFoundError,
  PlanMonthRecloseConflictError,
  PlanMonthRevisionConflictError,
} from '../application/planning-errors'

type MonthRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly publication_id: string | null
  readonly publication_snapshot_hash: string | null
  readonly month_revision: bigint
  readonly facts_revision: bigint
  readonly month_start: string
  readonly status: 'draft' | 'published' | 'grace' | 'closed'
  readonly lifecycle_mode: 'ordinary' | 'reopened'
}

export class PrismaRecloseMonthPersistence implements RecloseMonthPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public reclose(
    input: RecloseMonthPersistenceInput,
    report: CloseMonthReportPort,
  ): Promise<RecloseMonthPersistenceResult> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<MonthRow[]>`
        SELECT month.id::text plan_month_id,
               month.space_id::text,
               publication.id::text publication_id,
               publication.preview_hash publication_snapshot_hash,
               month.revision month_revision,
               month.facts_revision,
               month.month_start::text,
               month.status,
               month.lifecycle_mode
          FROM plan_months month
          LEFT JOIN plan_publications publication
            ON publication.id = month.active_publication_id
         WHERE month.id = ${input.planMonthId}::uuid
           AND month.space_id = ${input.spaceId}::uuid
         FOR UPDATE OF month
      `
      const month = rows[0]
      if (month === undefined) throw new PlanMonthNotFoundError()
      if (month.month_revision !== input.expectedRevision) {
        throw new PlanMonthRevisionConflictError(
          input.expectedRevision,
          month.month_revision,
        )
      }
      if (
        month.status !== 'grace' ||
        month.lifecycle_mode !== 'reopened' ||
        month.publication_id === null ||
        month.publication_snapshot_hash === null
      ) {
        throw new PlanMonthRecloseConflictError(
          month.month_revision,
          month.status,
          month.lifecycle_mode,
        )
      }

      const dates = await client.$queryRaw<{ readonly month_end: string }[]>`
        SELECT (${month.month_start}::date + INTERVAL '1 month' - INTERVAL '1 day')::date::text month_end
      `
      const reportSnapshot = await report.persist({
        spaceId: month.space_id,
        planMonthId: month.plan_month_id,
        publicationId: month.publication_id,
        asOfLocalDate: dates[0]!.month_end,
        publicationSnapshotHash: month.publication_snapshot_hash,
        occurredAt: input.occurredAt,
        revisionStatus: 'revised',
        createdBy: { kind: 'member', id: input.memberId },
      })
      if (reportSnapshot.factsRevision !== month.facts_revision) {
        throw new Error('RecloseMonth report snapshot is stale')
      }

      const lifecycleRevision = month.month_revision + 1n
      const updated = await client.$executeRaw`
        UPDATE plan_months
           SET status = 'closed',
               lifecycle_mode = 'reopened',
               revision = ${lifecycleRevision},
               updated_at = ${input.occurredAt}
         WHERE id = ${month.plan_month_id}::uuid
           AND space_id = ${input.spaceId}::uuid
           AND revision = ${month.month_revision}
           AND status = 'grace'
           AND lifecycle_mode = 'reopened'
      `
      if (updated !== 1) {
        throw new PlanMonthRevisionConflictError(
          input.expectedRevision,
          lifecycleRevision,
        )
      }

      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${randomUUID()}::uuid, 'month_reclosed', 'member',
           ${input.actorScope}, ${input.memberId}::uuid, NULL,
           ${month.plan_month_id}::uuid, NULL,
           ${input.commandType}, ${input.commandId}::uuid,
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
