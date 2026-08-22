import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  ReopenMonthPersistenceInput,
  ReopenMonthPersistencePort,
  ReopenMonthPersistenceResult,
} from '../application/reopen-month.command'
import {
  PlanMonthNotFoundError,
  PlanMonthReopenConflictError,
  PlanMonthRevisionConflictError,
} from '../application/planning-errors'

type MonthRow = {
  readonly plan_month_id: string
  readonly revision: bigint
  readonly status: 'draft' | 'published' | 'grace' | 'closed'
  readonly lifecycle_mode: 'ordinary' | 'reopened'
  readonly active_publication_id: string | null
}

export class PrismaReopenMonthPersistence implements ReopenMonthPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public reopen(
    input: ReopenMonthPersistenceInput,
  ): Promise<ReopenMonthPersistenceResult> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<MonthRow[]>`
        SELECT id::text plan_month_id,
               revision,
               status,
               lifecycle_mode,
               active_publication_id::text
          FROM plan_months
         WHERE id = ${input.planMonthId}::uuid
           AND space_id = ${input.spaceId}::uuid
         FOR UPDATE
      `
      const month = rows[0]
      if (month === undefined) throw new PlanMonthNotFoundError()
      if (month.revision !== input.expectedRevision) {
        throw new PlanMonthRevisionConflictError(
          input.expectedRevision,
          month.revision,
        )
      }
      if (month.status !== 'closed' || month.active_publication_id === null) {
        throw new PlanMonthReopenConflictError(
          month.lifecycle_mode === 'reopened'
            ? 'already_reopened'
            : 'not_closed',
          month.revision,
          month.status,
        )
      }

      const nextRevision = month.revision + 1n
      const updated = await client.$executeRaw`
        UPDATE plan_months
           SET status = 'grace',
               lifecycle_mode = 'reopened',
               revision = ${nextRevision},
               updated_at = ${input.occurredAt}
         WHERE id = ${input.planMonthId}::uuid
           AND space_id = ${input.spaceId}::uuid
           AND status = 'closed'
           AND revision = ${input.expectedRevision}
      `
      if (updated !== 1) {
        throw new PlanMonthRevisionConflictError(
          input.expectedRevision,
          nextRevision,
        )
      }

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'month_reopened', 'member',
           ${input.actorScope}, ${input.memberId}::uuid, NULL,
           ${input.planMonthId}::uuid, NULL,
           ${input.commandType}, ${input.commandId}::uuid,
           ${input.expectedRevision}, ${nextRevision}, ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO planning_month_reopen_changes (action_id, reason)
        VALUES (${actionId}::uuid, ${input.reason})
      `

      return {
        planMonthId: input.planMonthId,
        lifecycleRevision: nextRevision,
      }
    })
  }
}
