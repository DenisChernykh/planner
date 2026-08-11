import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  CreateDraftPersistenceInput,
  CreateDraftPersistenceResult,
  PlanDraftPersistencePort,
  PlanningCommandIdentity,
  PlanningDraftRef,
  UpdateFocusPersistenceInput,
} from '../application/plan-draft-persistence.port'
import {
  DraftRevisionConflictError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
} from '../application/planning-errors'
import type { DraftView } from '../application/planning.types'

type DraftRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly target_month: string
  readonly status: string
  readonly focus: string
  readonly plan_month_revision: bigint
  readonly draft_revision: bigint
}

function actorColumns(
  identity: PlanningCommandIdentity,
  resolvedMemberId: string,
): {
  readonly actorKind: 'member' | 'system'
  readonly memberId: string | null
  readonly systemActorId: 'planner-worker' | null
} {
  if (identity.actor.kind === 'member') {
    return {
      actorKind: 'member',
      memberId: resolvedMemberId,
      systemActorId: null,
    }
  }
  return {
    actorKind: 'system',
    memberId: null,
    systemActorId: 'planner-worker',
  }
}

function toDraftView(row: DraftRow): DraftView {
  if (row.status !== 'draft') throw new PlanDraftNotEditableError()
  return {
    planMonthId: row.plan_month_id,
    spaceId: row.space_id,
    targetMonth: row.target_month,
    status: 'draft',
    focus: row.focus,
    planMonthRevision: row.plan_month_revision,
    draftRevision: row.draft_revision,
  }
}

export class PrismaPlanDraftPersistence implements PlanDraftPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public createEmptyDraft(
    input: CreateDraftPersistenceInput,
  ): Promise<CreateDraftPersistenceResult> {
    return this.database.withClient(async (client) => {
      const planMonthId = randomUUID()
      const inserted = await client.$queryRaw<{ readonly id: string }[]>`
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, created_at, updated_at)
        VALUES
          (${planMonthId}::uuid, ${input.spaceId}::uuid,
           ${`${input.targetMonth}-01`}::date, 'draft', 1,
           ${input.occurredAt}, ${input.occurredAt})
        ON CONFLICT (space_id, month_start) DO NOTHING
        RETURNING id::text
      `
      if (inserted.length === 0) {
        const existing = await this.findDraftRow(
          client,
          input.spaceId,
          input.targetMonth,
        )
        if (existing === null) throw new PlanDraftNotFoundError()
        return {
          status: 'exists',
          draft: {
            planMonthId: existing.plan_month_id,
            draftRevision: existing.draft_revision,
          },
        }
      }

      await client.planDraft.create({
        data: {
          planMonthId,
          focus: input.focus,
          revision: 1n,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        },
      })
      await this.insertHistory(client, input, {
        actionKind: 'draft_created',
        planMonthId,
        beforeRevision: null,
        afterRevision: 1n,
        beforeFocus: null,
        afterFocus: input.focus,
      })
      return {
        status: 'created',
        draft: { planMonthId, draftRevision: 1n },
      }
    })
  }

  public updateFocus(
    input: UpdateFocusPersistenceInput,
  ): Promise<PlanningDraftRef> {
    return this.database.withClient(async (client) => {
      const before = await this.findDraftById(client, input.planMonthId)
      if (before === null || before.space_id !== input.spaceId) {
        throw new PlanDraftNotFoundError()
      }
      if (before.status !== 'draft') throw new PlanDraftNotEditableError()
      if (before.draft_revision !== input.expectedRevision) {
        throw new DraftRevisionConflictError(
          input.expectedRevision,
          before.draft_revision,
        )
      }

      const updated = await client.$queryRaw<{ readonly revision: bigint }[]>`
        UPDATE plan_drafts AS draft
           SET focus = ${input.focus},
               revision = draft.revision + 1,
               updated_at = ${input.occurredAt}
          FROM plan_months AS month
         WHERE draft.plan_month_id = ${input.planMonthId}::uuid
           AND month.id = draft.plan_month_id
           AND month.space_id = ${input.spaceId}::uuid
           AND month.status = 'draft'
           AND draft.revision = ${input.expectedRevision}
        RETURNING draft.revision
      `
      if (updated.length === 0) {
        const current = await this.findDraftById(client, input.planMonthId)
        if (current === null || current.space_id !== input.spaceId) {
          throw new PlanDraftNotFoundError()
        }
        if (current.status !== 'draft') throw new PlanDraftNotEditableError()
        throw new DraftRevisionConflictError(
          input.expectedRevision,
          current.draft_revision,
        )
      }
      const revision = updated[0]?.revision
      if (revision === undefined) throw new PlanDraftNotFoundError()

      await this.insertHistory(client, input, {
        actionKind: 'month_focus_updated',
        planMonthId: input.planMonthId,
        beforeRevision: before.draft_revision,
        afterRevision: revision,
        beforeFocus: before.focus,
        afterFocus: input.focus,
      })
      return { planMonthId: input.planMonthId, draftRevision: revision }
    })
  }

  public findDraft(
    spaceId: string,
    targetMonth: string,
  ): Promise<DraftView | null> {
    return this.database.withClient(async (client) => {
      const row = await this.findDraftRow(client, spaceId, targetMonth)
      return row === null ? null : toDraftView(row)
    })
  }

  private async insertHistory(
    client: Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0],
    identity: PlanningCommandIdentity & { readonly memberId: string },
    change: {
      readonly actionKind: 'draft_created' | 'month_focus_updated'
      readonly planMonthId: string
      readonly beforeRevision: bigint | null
      readonly afterRevision: bigint
      readonly beforeFocus: string | null
      readonly afterFocus: string
    },
  ): Promise<void> {
    const actor = actorColumns(identity, identity.memberId)
    await client.planningActionGroup.create({
      data: {
        id: randomUUID(),
        actionKind: change.actionKind,
        actorKind: actor.actorKind,
        actorScope: identity.actorScope,
        memberId: actor.memberId,
        systemActorId: actor.systemActorId,
        planMonthId: change.planMonthId,
        commandType: identity.commandType,
        commandId: identity.commandId,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
        occurredAt: identity.occurredAt,
        focusChange: {
          create: {
            beforeFocus: change.beforeFocus,
            afterFocus: change.afterFocus,
          },
        },
      },
    })
  }

  private async findDraftRow(
    client: Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0],
    spaceId: string,
    targetMonth: string,
  ): Promise<DraftRow | null> {
    const rows = await client.$queryRaw<DraftRow[]>`
      SELECT month.id::text AS plan_month_id,
             month.space_id::text AS space_id,
             to_char(month.month_start, 'YYYY-MM') AS target_month,
             month.status,
             draft.focus,
             month.revision AS plan_month_revision,
             draft.revision AS draft_revision
        FROM plan_months AS month
        JOIN plan_drafts AS draft ON draft.plan_month_id = month.id
       WHERE month.space_id = ${spaceId}::uuid
         AND month.month_start = ${`${targetMonth}-01`}::date
    `
    return rows[0] ?? null
  }

  private async findDraftById(
    client: Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0],
    planMonthId: string,
  ): Promise<DraftRow | null> {
    const rows = await client.$queryRaw<DraftRow[]>`
      SELECT month.id::text AS plan_month_id,
             month.space_id::text AS space_id,
             to_char(month.month_start, 'YYYY-MM') AS target_month,
             month.status,
             draft.focus,
             month.revision AS plan_month_revision,
             draft.revision AS draft_revision
        FROM plan_months AS month
        JOIN plan_drafts AS draft ON draft.plan_month_id = month.id
       WHERE month.id = ${planMonthId}::uuid
    `
    return rows[0] ?? null
  }
}
