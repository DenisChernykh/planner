import { randomUUID } from 'node:crypto'

import { Prisma } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { CommandValidationError } from '@/shared/application/application-command'

import type {
  CreateDraftFromPublicationPersistenceInput,
  CreateDraftFromSeedPersistenceInput,
  CreateDraftPersistenceInput,
  CreateDraftPersistenceResult,
  PlanDraftPersistencePort,
  PlanningCommandIdentity,
  PlanningDraftRef,
  UpdateFocusPersistenceInput,
} from '../application/plan-draft-persistence.port'
import {
  PlanSeedAlreadyConsumedError,
  DraftRevisionConflictError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanPublicationNotFoundError,
} from '../application/planning-errors'
import type { DraftView } from '../application/planning.types'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

export type DraftCopyWritePhase =
  | 'month'
  | 'draft'
  | 'goal_roots'
  | 'goal_revisions'
  | 'goal_pointers'
  | 'history'

export type DraftCopyWriteObserver = (
  phase: DraftCopyWritePhase,
) => void | Promise<void>

export type SeedDraftWritePhase =
  | 'month'
  | 'draft'
  | 'definitions'
  | 'series'
  | 'definition_versions'
  | 'goal_roots'
  | 'goal_revisions'
  | 'goal_pointers'
  | 'action'
  | 'consumption'

export type SeedDraftWriteObserver = (
  phase: SeedDraftWritePhase,
) => void | Promise<void>

type DraftRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly target_month: string
  readonly status: string
  readonly focus: string
  readonly plan_month_revision: bigint
  readonly draft_revision: bigint
}

type CopySourceRow = {
  readonly publication_id: string
  readonly source_plan_month_id: string
  readonly focus: string
  readonly goal_count: number
}

type SeedConsumptionRow = {
  readonly plan_month_id: string
  readonly seed_version: number
}

type SeedMaterializedGoal = {
  readonly definition_id: string
  readonly series_id: string
  readonly version_id: string
  readonly plan_goal_id: string
  readonly goal_revision_id: string
  readonly display_order: number
  readonly title: string
  readonly why: string
  readonly category: string
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
  readonly config: unknown
  readonly source_provenance: unknown
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
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterCopyWritePhase: DraftCopyWriteObserver = () => {},
    private readonly afterSeedWritePhase: SeedDraftWriteObserver = () => {},
  ) {}

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

  public createFromPublication(
    input: CreateDraftFromPublicationPersistenceInput,
  ): Promise<CreateDraftPersistenceResult> {
    return this.database.withClient(async (client) => {
      const sourceRows = await client.$queryRaw<CopySourceRow[]>`
        SELECT publication.id::text publication_id,
               publication.plan_month_id::text source_plan_month_id,
               publication.focus,
               count(snapshot.id)::int goal_count
          FROM plan_publications publication
          LEFT JOIN plan_goal_snapshots snapshot
            ON snapshot.publication_id = publication.id
         WHERE publication.id = ${input.sourcePublicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
         GROUP BY publication.id
      `
      const source = sourceRows[0]
      if (source === undefined) throw new PlanPublicationNotFoundError()
      if (source.goal_count > 200) throw new CommandValidationError()

      const planMonthId = randomUUID()
      const inserted = await client.$queryRaw<{ readonly id: string }[]>`
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, facts_revision,
           active_publication_id, created_at, updated_at)
        VALUES
          (${planMonthId}::uuid, ${input.spaceId}::uuid,
           ${`${input.targetMonth}-01`}::date, 'draft', 1, 0, NULL,
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
      await this.afterCopyWritePhase('month')

      await client.planDraft.create({
        data: {
          planMonthId,
          focus: source.focus,
          revision: 1n,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        },
      })
      await this.afterCopyWritePhase('draft')

      await client.$executeRaw`
        INSERT INTO plan_draft_goals
          (id, space_id, plan_month_id, goal_definition_id, display_order,
           current_revision_id, attached_at, detached_at, created_at, updated_at)
        SELECT gen_random_uuid(), snapshot.space_id, ${planMonthId}::uuid,
               snapshot.goal_definition_id, snapshot.display_order,
               NULL, ${input.occurredAt}, NULL,
               ${input.occurredAt}, ${input.occurredAt}
          FROM plan_goal_snapshots snapshot
         WHERE snapshot.publication_id = ${input.sourcePublicationId}::uuid
         ORDER BY snapshot.display_order, snapshot.id
      `
      await this.afterCopyWritePhase('goal_roots')

      await client.$executeRaw`
        INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config, source_provenance, created_at)
        SELECT gen_random_uuid(), root.id, root.space_id,
               snapshot.goal_definition_id, 1,
               snapshot.goal_definition_version_id, snapshot.goal_series_id,
               snapshot.scope_kind, snapshot.owner_member_id,
               snapshot.config, snapshot.source_provenance,
               ${input.occurredAt}
          FROM plan_goal_snapshots snapshot
          JOIN plan_draft_goals root
            ON root.plan_month_id = ${planMonthId}::uuid
           AND root.display_order = snapshot.display_order
           AND root.goal_definition_id = snapshot.goal_definition_id
         WHERE snapshot.publication_id = ${input.sourcePublicationId}::uuid
         ORDER BY snapshot.display_order, snapshot.id
      `
      await this.afterCopyWritePhase('goal_revisions')

      await client.$executeRaw`
        UPDATE plan_draft_goals root
           SET current_revision_id = revision.id
          FROM plan_draft_goal_revisions revision
         WHERE root.plan_month_id = ${planMonthId}::uuid
           AND revision.plan_goal_id = root.id
           AND revision.revision_number = 1
      `
      await this.afterCopyWritePhase('goal_pointers')

      const orderRows = await client.$queryRaw<{ readonly id: string }[]>`
        SELECT id::text FROM plan_draft_goals
         WHERE plan_month_id = ${planMonthId}::uuid AND detached_at IS NULL
         ORDER BY display_order, id
      `
      const afterOrder = orderRows.map((row) => row.id)
      const actor = actorColumns(input, input.memberId)
      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'draft_copied', ${actor.actorKind},
           ${input.actorScope}, ${actor.memberId}::uuid,
           ${actor.systemActorId}, ${planMonthId}::uuid, NULL,
           ${input.commandType}, ${input.commandId}::uuid, NULL, 1,
           ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO planning_month_copy_changes
          (action_id, source_publication_id, copied_goal_count, after_order)
        VALUES
          (${actionId}::uuid, ${input.sourcePublicationId}::uuid,
           ${source.goal_count}, ${afterOrder}::uuid[])
      `
      await this.afterCopyWritePhase('history')

      return {
        status: 'created',
        draft: { planMonthId, draftRevision: 1n },
      }
    })
  }

  public createFromSeed(
    input: CreateDraftFromSeedPersistenceInput,
  ): Promise<CreateDraftPersistenceResult> {
    if (
      input.seed.seedId !== 'april-plan' ||
      input.seed.seedVersion !== 1 ||
      input.seed.schemaVersion !== 'planner.april-plan-seed.v1' ||
      input.seed.goals.length !== 41 ||
      input.seed.goals.length > 200
    ) {
      throw new CommandValidationError()
    }

    return this.database.withClient(async (client) => {
      await client.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`planning.seed:${input.spaceId}:${input.seed.seedId}`}, 0)
        )::text AS locked
      `
      const consumed = await client.$queryRaw<SeedConsumptionRow[]>`
        SELECT plan_month_id::text, seed_version
          FROM planning_seed_consumptions
         WHERE space_id = ${input.spaceId}::uuid
           AND seed_id = ${input.seed.seedId}
      `
      const existingConsumption = consumed[0]
      if (existingConsumption !== undefined) {
        throw new PlanSeedAlreadyConsumedError(
          existingConsumption.plan_month_id,
          input.seed.seedId,
          1,
        )
      }

      const planMonthId = randomUUID()
      const inserted = await client.$queryRaw<{ readonly id: string }[]>`
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, facts_revision,
           active_publication_id, created_at, updated_at)
        VALUES
          (${planMonthId}::uuid, ${input.spaceId}::uuid,
           ${`${input.targetMonth}-01`}::date, 'draft', 1, 0, NULL,
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
      await this.afterSeedWritePhase('month')

      await client.planDraft.create({
        data: {
          planMonthId,
          focus: input.seed.focus,
          revision: 1n,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        },
      })
      await this.afterSeedWritePhase('draft')

      const goals: readonly SeedMaterializedGoal[] = input.seed.goals.map(
        (goal, displayOrder) => {
          const scope = goal.config.scope
          return {
            definition_id: randomUUID(),
            series_id: randomUUID(),
            version_id: randomUUID(),
            plan_goal_id: randomUUID(),
            goal_revision_id: randomUUID(),
            display_order: displayOrder,
            title: goal.title,
            why: goal.why,
            category: goal.category,
            scope_kind: scope.kind,
            owner_member_id:
              scope.kind === 'personal' ? scope.ownerMemberId : null,
            config: goal.config,
            source_provenance: goal.sourceProvenance,
          }
        },
      )
      const serializedGoals = JSON.stringify(goals)

      await client.$executeRaw`
        INSERT INTO goal_definitions
          (id, space_id, state, revision, created_at, updated_at, archived_at)
        SELECT goal.definition_id, ${input.spaceId}::uuid,
               'active', 1, ${input.occurredAt}, ${input.occurredAt}, NULL
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            definition_id uuid
          )
      `
      await this.afterSeedWritePhase('definitions')

      await client.$executeRaw`
        INSERT INTO goal_series (id, goal_definition_id, created_at)
        SELECT goal.series_id, goal.definition_id, ${input.occurredAt}
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            definition_id uuid, series_id uuid
          )
      `
      await this.afterSeedWritePhase('series')

      await client.$executeRaw`
        INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
        SELECT goal.version_id, goal.definition_id, 1, goal.series_id,
               'new', goal.title, goal.why, goal.category, ${input.occurredAt}
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            definition_id uuid, series_id uuid, version_id uuid,
            title text, why text, category text
          )
      `
      await this.afterSeedWritePhase('definition_versions')

      await client.$executeRaw`
        INSERT INTO plan_draft_goals
          (id, space_id, plan_month_id, goal_definition_id, display_order,
           current_revision_id, attached_at, detached_at, created_at, updated_at)
        SELECT goal.plan_goal_id, ${input.spaceId}::uuid, ${planMonthId}::uuid,
               goal.definition_id, goal.display_order, NULL,
               ${input.occurredAt}, NULL, ${input.occurredAt}, ${input.occurredAt}
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            definition_id uuid, plan_goal_id uuid, display_order integer
          )
         ORDER BY goal.display_order
      `
      await this.afterSeedWritePhase('goal_roots')

      await client.$executeRaw`
        INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config, source_provenance, created_at)
        SELECT goal.goal_revision_id, goal.plan_goal_id, ${input.spaceId}::uuid,
               goal.definition_id, 1, goal.version_id, goal.series_id,
               goal.scope_kind, goal.owner_member_id, goal.config,
               goal.source_provenance, ${input.occurredAt}
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            definition_id uuid, series_id uuid, version_id uuid,
            plan_goal_id uuid, goal_revision_id uuid, scope_kind text,
            owner_member_id uuid, config jsonb, source_provenance jsonb
          )
      `
      await this.afterSeedWritePhase('goal_revisions')

      await client.$executeRaw`
        UPDATE plan_draft_goals root
           SET current_revision_id = goal.goal_revision_id
          FROM jsonb_to_recordset(${serializedGoals}::jsonb) AS goal(
            plan_goal_id uuid, goal_revision_id uuid
          )
         WHERE root.id = goal.plan_goal_id
           AND root.plan_month_id = ${planMonthId}::uuid
      `
      await this.afterSeedWritePhase('goal_pointers')

      const actionId = randomUUID()
      const actor = actorColumns(input, input.memberId)
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'draft_created_from_seed', ${actor.actorKind},
           ${input.actorScope}, ${actor.memberId}::uuid,
           ${actor.systemActorId}, ${planMonthId}::uuid, NULL,
           ${input.commandType}, ${input.commandId}::uuid, NULL, 1,
           ${input.occurredAt})
      `
      await this.afterSeedWritePhase('action')

      const goalDefinitionIds = goals.map((goal) => goal.definition_id)
      const afterOrder = goals.map((goal) => goal.plan_goal_id)
      await client.$executeRaw`
        INSERT INTO planning_seed_consumptions
          (action_id, space_id, plan_month_id, seed_id, seed_version,
           seed_schema_version, actor_persona, member_a_member_id,
           member_b_member_id, seeded_goal_count, goal_definition_ids,
           after_order)
        VALUES
          (${actionId}::uuid, ${input.spaceId}::uuid, ${planMonthId}::uuid,
           ${input.seed.seedId}, ${input.seed.seedVersion},
           ${input.seed.schemaVersion}, ${input.actorPersona},
           ${input.denisMemberId}::uuid, ${input.tanyaMemberId}::uuid,
           ${goals.length}, ${goalDefinitionIds}::uuid[], ${afterOrder}::uuid[])
      `
      await this.afterSeedWritePhase('consumption')

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
      const before = await this.findDraftById(client, input.planMonthId, true)
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
    client: Client,
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
    client: Client,
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
    client: Client,
    planMonthId: string,
    lock = false,
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
       ${lock ? Prisma.sql`FOR UPDATE OF month, draft` : Prisma.empty}
    `
    return rows[0] ?? null
  }
}
