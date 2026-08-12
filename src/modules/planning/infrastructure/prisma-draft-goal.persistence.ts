import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { CommandValidationError } from '@/shared/application/application-command'

import type {
  AddDraftGoalPersistenceInput,
  DraftGoalPersistencePort,
  RemoveDraftGoalPersistenceInput,
  ReorderDraftGoalsPersistenceInput,
  UpdateDraftGoalPersistenceInput,
} from '../application/draft-goal-persistence.port'
import type {
  DraftEditorView,
  DraftGoalView,
} from '../application/draft-goal.types'
import { isGeneratedDraftGoalChildId } from '../application/draft-goal.validation'
import type {
  PlanningCommandIdentity,
  PlanningDraftRef,
} from '../application/plan-draft-persistence.port'
import {
  DraftGoalNotFoundError,
  DraftRevisionConflictError,
  GoalDefinitionVersionNotFoundError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
} from '../application/planning-errors'
import {
  draftGoalSeriesDecision,
  snapshotStoredDraftGoalConfig,
  snapshotSourceProvenance,
  type DraftGoalConfigV1,
} from '../domain/goal-config'
import { draftGoalPublishBlockers } from '../domain/goal-validation'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]
type DraftRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly target_month: string
  readonly status: string
  readonly focus: string
  readonly plan_month_revision: bigint
  readonly draft_revision: bigint
}
type CatalogRow = {
  readonly goal_definition_id: string
  readonly goal_definition_version_id: string
  readonly goal_series_id: string
  readonly title: string
  readonly why: string
  readonly category: string
}
type GoalRow = CatalogRow & {
  readonly plan_goal_id: string
  readonly display_order: number
  readonly config_revision: bigint
  readonly current_revision_id: string
  readonly config: unknown
  readonly source_provenance: unknown
}
type CurrentGoalRow = GoalRow & {
  readonly source_catalog_series_id: string
}

function actorColumns(
  identity: PlanningCommandIdentity,
  memberId: string,
): {
  readonly actorKind: 'member' | 'system'
  readonly memberId: string | null
  readonly systemActorId: 'planner-worker' | null
} {
  return identity.actor.kind === 'member'
    ? { actorKind: 'member', memberId, systemActorId: null }
    : {
        actorKind: 'system',
        memberId: null,
        systemActorId: 'planner-worker',
      }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

type ChildFamily = 'checklist' | 'any_of' | 'checkpoint'
function collectIds(config: DraftGoalConfigV1): Map<string, ChildFamily> {
  const values = new Map<string, ChildFamily>()
  if (config.measurement.kind === 'checklist') {
    config.measurement.items.forEach((item) => {
      if (item.itemId !== null) values.set(item.itemId, 'checklist')
    })
  }
  if (config.measurement.kind === 'any_of') {
    config.measurement.variants.forEach((variant) => {
      if (variant.variantId !== null) values.set(variant.variantId, 'any_of')
    })
  }
  config.checkpoints?.items.forEach((checkpoint) => {
    if (checkpoint.checkpointId !== null) {
      values.set(checkpoint.checkpointId, 'checkpoint')
    }
  })
  return values
}

function freezeGoal(row: GoalRow): DraftGoalView {
  const config = snapshotStoredDraftGoalConfig(row.config)
  const blockers = draftGoalPublishBlockers([
    { planGoalId: row.plan_goal_id, displayOrder: row.display_order, config },
  ])
  return Object.freeze({
    planGoalId: row.plan_goal_id,
    goalDefinitionId: row.goal_definition_id,
    goalDefinitionVersionId: row.goal_definition_version_id,
    goalSeriesId: row.goal_series_id,
    title: row.title,
    why: row.why,
    category: row.category,
    displayOrder: row.display_order,
    configRevision: row.config_revision,
    config,
    sourceProvenance:
      row.source_provenance === null
        ? null
        : snapshotSourceProvenance(row.source_provenance),
    blockers,
  })
}

export class PrismaDraftGoalPersistence implements DraftGoalPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public add(input: AddDraftGoalPersistenceInput): Promise<PlanningDraftRef> {
    return this.database.withClient(async (client) => {
      const draft = await this.lockDraft(client, input)
      const duplicateRows = await client.$queryRaw<
        { readonly exists: boolean }[]
      >`
        SELECT EXISTS (
          SELECT 1 FROM plan_draft_goals
           WHERE plan_month_id = ${input.planMonthId}::uuid
             AND goal_definition_id = ${input.goalDefinitionId}::uuid
             AND detached_at IS NULL
        ) exists
      `
      if (duplicateRows[0]?.exists === true) {
        throw new CommandValidationError()
      }
      const catalog = await this.currentCatalog(
        client,
        input.spaceId,
        input.goalDefinitionId,
      )
      if (catalog === null) throw new GoalDefinitionVersionNotFoundError()
      await this.assertOwner(client, input.spaceId, input.config)
      const countRows = await client.$queryRaw<{ readonly count: number }[]>`
        SELECT count(*)::int count FROM plan_draft_goals
         WHERE plan_month_id = ${input.planMonthId}::uuid AND detached_at IS NULL
      `
      const count = countRows[0]?.count ?? 0
      if (count >= 200) throw new CommandValidationError()
      const planGoalId = randomUUID()
      const revisionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO plan_draft_goals
          (id, space_id, plan_month_id, goal_definition_id, display_order,
           current_revision_id, attached_at, detached_at, created_at, updated_at)
        VALUES (${planGoalId}::uuid, ${input.spaceId}::uuid,
                ${input.planMonthId}::uuid, ${input.goalDefinitionId}::uuid,
                ${count}, NULL, ${input.occurredAt}, NULL,
                ${input.occurredAt}, ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config,
           source_provenance, created_at)
        VALUES (${revisionId}::uuid, ${planGoalId}::uuid, ${input.spaceId}::uuid,
                ${input.goalDefinitionId}::uuid, 1,
                ${catalog.goal_definition_version_id}::uuid,
                ${catalog.goal_series_id}::uuid, ${input.config.scope.kind},
                ${input.config.scope.kind === 'personal' ? input.config.scope.ownerMemberId : null}::uuid,
                ${json(input.config)}::jsonb,
                ${input.sourceProvenance === null ? null : json(input.sourceProvenance)}::jsonb,
                ${input.occurredAt})
      `
      await client.$executeRaw`
        UPDATE plan_draft_goals SET current_revision_id = ${revisionId}::uuid
         WHERE id = ${planGoalId}::uuid
      `
      const revision = await this.incrementDraft(client, input, draft)
      await this.history(client, input, {
        actionKind: 'draft_goal_added',
        beforeRevision: draft.draft_revision,
        afterRevision: revision,
        planGoalId,
        beforeRevisionId: null,
        afterRevisionId: revisionId,
        reorderedGoalCount: null,
      })
      return { planMonthId: input.planMonthId, draftRevision: revision }
    })
  }

  public update(
    input: UpdateDraftGoalPersistenceInput,
  ): Promise<PlanningDraftRef> {
    return this.database.withClient(async (client) => {
      const draft = await this.lockDraft(client, input)
      const before = await this.currentGoal(
        client,
        input.spaceId,
        input.planMonthId,
        input.planGoalId,
      )
      if (before === null) throw new DraftGoalNotFoundError()
      const selected = await this.catalogVersion(
        client,
        input.spaceId,
        before.goal_definition_id,
        input.goalDefinitionVersionId,
      )
      if (selected === null) throw new GoalDefinitionVersionNotFoundError()
      const beforeConfig = snapshotStoredDraftGoalConfig(before.config)
      const historicalIds = await this.historicalChildIds(
        client,
        input.planGoalId,
      )
      this.assertStableIds(
        beforeConfig,
        input.config,
        input.commandId,
        historicalIds,
      )
      await this.assertOwner(client, input.spaceId, input.config)

      let seriesId = before.goal_series_id
      if (
        selected.goal_definition_version_id !==
          before.goal_definition_version_id &&
        selected.goal_series_id !== before.source_catalog_series_id
      ) {
        seriesId = selected.goal_series_id
      } else if (
        draftGoalSeriesDecision(beforeConfig, input.config) === 'new'
      ) {
        seriesId = randomUUID()
        await client.$executeRaw`
          INSERT INTO goal_series (id, goal_definition_id, created_at)
          VALUES (${seriesId}::uuid, ${before.goal_definition_id}::uuid,
                  ${input.occurredAt})
        `
      }
      const revisionId = randomUUID()
      const configRevision = before.config_revision + 1n
      await client.$executeRaw`
        INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config,
           source_provenance, created_at)
        VALUES (${revisionId}::uuid, ${input.planGoalId}::uuid,
                ${input.spaceId}::uuid, ${before.goal_definition_id}::uuid,
                ${configRevision}, ${input.goalDefinitionVersionId}::uuid,
                ${seriesId}::uuid, ${input.config.scope.kind},
                ${input.config.scope.kind === 'personal' ? input.config.scope.ownerMemberId : null}::uuid,
                ${json(input.config)}::jsonb,
                ${input.sourceProvenance === null ? null : json(input.sourceProvenance)}::jsonb,
                ${input.occurredAt})
      `
      await client.$executeRaw`
        UPDATE plan_draft_goals
           SET current_revision_id = ${revisionId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${input.planGoalId}::uuid
      `
      const revision = await this.incrementDraft(client, input, draft)
      await this.history(client, input, {
        actionKind: 'draft_goal_updated',
        beforeRevision: draft.draft_revision,
        afterRevision: revision,
        planGoalId: input.planGoalId,
        beforeRevisionId: before.current_revision_id,
        afterRevisionId: revisionId,
        reorderedGoalCount: null,
      })
      return { planMonthId: input.planMonthId, draftRevision: revision }
    })
  }

  public remove(
    input: RemoveDraftGoalPersistenceInput,
  ): Promise<PlanningDraftRef> {
    return this.database.withClient(async (client) => {
      const draft = await this.lockDraft(client, input)
      const before = await this.currentGoal(
        client,
        input.spaceId,
        input.planMonthId,
        input.planGoalId,
      )
      if (before === null) throw new DraftGoalNotFoundError()
      const beforeOrder = await this.activeOrder(client, input.planMonthId)
      const revision = await this.incrementDraft(client, input, draft)
      await this.history(client, input, {
        actionKind: 'draft_goal_removed',
        beforeRevision: draft.draft_revision,
        afterRevision: revision,
        planGoalId: input.planGoalId,
        beforeRevisionId: before.current_revision_id,
        afterRevisionId: null,
        reorderedGoalCount: null,
        beforeOrder,
        afterOrder: beforeOrder.filter((id) => id !== input.planGoalId),
      })
      await client.$executeRaw`
        UPDATE plan_draft_goals
           SET detached_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
         WHERE id = ${input.planGoalId}::uuid
      `
      await client.$executeRaw`
        UPDATE plan_draft_goals
           SET display_order = display_order - 1, updated_at = ${input.occurredAt}
         WHERE plan_month_id = ${input.planMonthId}::uuid
           AND detached_at IS NULL AND display_order > ${before.display_order}
      `
      return { planMonthId: input.planMonthId, draftRevision: revision }
    })
  }

  public reorder(
    input: ReorderDraftGoalsPersistenceInput,
  ): Promise<PlanningDraftRef> {
    return this.database.withClient(async (client) => {
      const draft = await this.lockDraft(client, input)
      const rows = await client.$queryRaw<{ readonly id: string }[]>`
        SELECT id::text FROM plan_draft_goals
         WHERE plan_month_id = ${input.planMonthId}::uuid
           AND space_id = ${input.spaceId}::uuid AND detached_at IS NULL
         ORDER BY display_order, id
         FOR UPDATE
      `
      const existing = rows.map((row) => row.id).sort()
      const beforeOrder = rows.map((row) => row.id)
      const requested = [...input.orderedPlanGoalIds].sort()
      if (
        existing.length !== requested.length ||
        existing.some((id, index) => id !== requested[index])
      ) {
        throw new DraftGoalNotFoundError()
      }
      const revision = await this.incrementDraft(client, input, draft)
      await this.history(client, input, {
        actionKind: 'draft_goals_reordered',
        beforeRevision: draft.draft_revision,
        afterRevision: revision,
        planGoalId: null,
        beforeRevisionId: null,
        afterRevisionId: null,
        reorderedGoalCount: input.orderedPlanGoalIds.length,
        beforeOrder,
        afterOrder: input.orderedPlanGoalIds,
      })
      await client.$executeRaw`
        UPDATE plan_draft_goals SET display_order = display_order + 200
         WHERE plan_month_id = ${input.planMonthId}::uuid AND detached_at IS NULL
      `
      for (const [
        displayOrder,
        planGoalId,
      ] of input.orderedPlanGoalIds.entries()) {
        await client.$executeRaw`
          UPDATE plan_draft_goals
             SET display_order = ${displayOrder}, updated_at = ${input.occurredAt}
           WHERE id = ${planGoalId}::uuid
        `
      }
      return { planMonthId: input.planMonthId, draftRevision: revision }
    })
  }

  public findEditor(
    spaceId: string,
    targetMonth: string,
  ): Promise<DraftEditorView | null> {
    return this.database.withClient(async (client) => {
      type EditorRow = DraftRow & { readonly goals: unknown }
      const editorRows = await client.$queryRaw<EditorRow[]>`
        SELECT month.id::text plan_month_id, month.space_id::text space_id,
               to_char(month.month_start, 'YYYY-MM') target_month, month.status,
               draft.focus, month.revision plan_month_revision,
               draft.revision draft_revision,
               COALESCE((
                 SELECT jsonb_agg(
                   jsonb_build_object(
                     'plan_goal_id', root.id::text,
                     'goal_definition_id', root.goal_definition_id::text,
                     'display_order', root.display_order,
                     'config_revision', revision.revision_number::text,
                     'current_revision_id', root.current_revision_id::text,
                     'goal_definition_version_id', revision.goal_definition_version_id::text,
                     'goal_series_id', revision.goal_series_id::text,
                     'config', revision.config,
                     'source_provenance', revision.source_provenance,
                     'title', version.title, 'why', version.why,
                     'category', version.category
                   ) ORDER BY root.display_order, root.id
                 )
                   FROM plan_draft_goals root
                   JOIN plan_draft_goal_revisions revision
                     ON revision.plan_goal_id = root.id
                    AND revision.id = root.current_revision_id
                   JOIN goal_definition_versions version
                     ON version.goal_definition_id = root.goal_definition_id
                    AND version.id = revision.goal_definition_version_id
                  WHERE root.plan_month_id = month.id
                    AND root.detached_at IS NULL
               ), '[]'::jsonb) goals
          FROM plan_months month JOIN plan_drafts draft ON draft.plan_month_id = month.id
         WHERE month.space_id = ${spaceId}::uuid
           AND month.month_start = ${`${targetMonth}-01`}::date
      `
      const draft = editorRows[0]
      if (draft === undefined) return null
      if (draft.status !== 'draft') throw new PlanDraftNotEditableError()
      if (!Array.isArray(draft.goals)) throw new Error('Invalid stored goals')
      const rows = draft.goals.map((value) => {
        if (typeof value !== 'object' || value === null) {
          throw new Error('Invalid stored goal')
        }
        const row = value as Record<string, unknown>
        return {
          plan_goal_id: String(row['plan_goal_id']),
          goal_definition_id: String(row['goal_definition_id']),
          goal_definition_version_id: String(row['goal_definition_version_id']),
          goal_series_id: String(row['goal_series_id']),
          title: String(row['title']),
          why: String(row['why']),
          category: String(row['category']),
          display_order: Number(row['display_order']),
          config_revision: BigInt(String(row['config_revision'])),
          current_revision_id: String(row['current_revision_id']),
          config: row['config'],
          source_provenance: row['source_provenance'] ?? null,
        } satisfies GoalRow
      })
      const goals = Object.freeze(rows.map(freezeGoal))
      const blockers = draftGoalPublishBlockers(
        goals.map((goal) => ({
          planGoalId: goal.planGoalId,
          displayOrder: goal.displayOrder,
          config: goal.config,
        })),
      )
      return Object.freeze({
        planMonthId: draft.plan_month_id,
        spaceId: draft.space_id,
        targetMonth: draft.target_month,
        status: 'draft' as const,
        focus: draft.focus,
        planMonthRevision: draft.plan_month_revision,
        draftRevision: draft.draft_revision,
        goals,
        blockers,
      })
    })
  }

  private async lockDraft(
    client: Client,
    input: {
      readonly planMonthId: string
      readonly spaceId: string
      readonly expectedRevision: bigint
    },
  ): Promise<DraftRow> {
    const rows = await client.$queryRaw<DraftRow[]>`
      SELECT month.id::text plan_month_id, month.space_id::text space_id,
             to_char(month.month_start, 'YYYY-MM') target_month, month.status,
             draft.focus, month.revision plan_month_revision,
             draft.revision draft_revision
        FROM plan_months month JOIN plan_drafts draft ON draft.plan_month_id = month.id
       WHERE month.id = ${input.planMonthId}::uuid
       FOR UPDATE OF month, draft
    `
    const draft = rows[0]
    if (draft === undefined || draft.space_id !== input.spaceId) {
      throw new PlanDraftNotFoundError()
    }
    if (draft.status !== 'draft') throw new PlanDraftNotEditableError()
    if (draft.draft_revision !== input.expectedRevision) {
      throw new DraftRevisionConflictError(
        input.expectedRevision,
        draft.draft_revision,
      )
    }
    return draft
  }

  private async incrementDraft(
    client: Client,
    input: { readonly planMonthId: string; readonly occurredAt: Date },
    draft: DraftRow,
  ): Promise<bigint> {
    const revision = draft.draft_revision + 1n
    await client.$executeRaw`
      UPDATE plan_drafts SET revision = ${revision}, updated_at = ${input.occurredAt}
       WHERE plan_month_id = ${input.planMonthId}::uuid
    `
    return revision
  }

  private currentCatalog(
    client: Client,
    spaceId: string,
    definitionId: string,
  ): Promise<CatalogRow | null> {
    return client.$queryRaw<CatalogRow[]>`
      SELECT definition.id::text goal_definition_id,
             version.id::text goal_definition_version_id,
             version.goal_series_id::text goal_series_id,
             version.title, version.why, version.category
        FROM goal_definitions definition
        JOIN LATERAL (
          SELECT * FROM goal_definition_versions
           WHERE goal_definition_id = definition.id
           ORDER BY version_number DESC LIMIT 1
        ) version ON TRUE
       WHERE definition.id = ${definitionId}::uuid
         AND definition.space_id = ${spaceId}::uuid
         AND definition.state = 'active'
       FOR SHARE OF definition
    `.then((rows) => rows[0] ?? null)
  }

  private catalogVersion(
    client: Client,
    spaceId: string,
    definitionId: string,
    versionId: string,
  ): Promise<CatalogRow | null> {
    return client.$queryRaw<CatalogRow[]>`
      SELECT definition.id::text goal_definition_id,
             version.id::text goal_definition_version_id,
             version.goal_series_id::text goal_series_id,
             version.title, version.why, version.category
        FROM goal_definitions definition
        JOIN goal_definition_versions version
          ON version.goal_definition_id = definition.id
       WHERE definition.id = ${definitionId}::uuid
         AND definition.space_id = ${spaceId}::uuid
         AND version.id = ${versionId}::uuid
    `.then((rows) => rows[0] ?? null)
  }

  private currentGoal(
    client: Client,
    spaceId: string,
    planMonthId: string,
    planGoalId: string,
  ): Promise<CurrentGoalRow | null> {
    return client.$queryRaw<CurrentGoalRow[]>`
      SELECT root.id::text plan_goal_id, root.goal_definition_id::text,
             root.display_order, root.current_revision_id::text,
             revision.revision_number config_revision,
             revision.goal_definition_version_id::text,
             revision.goal_series_id::text,
             version.goal_series_id::text source_catalog_series_id,
             revision.config,
             revision.source_provenance, version.title, version.why,
             version.category
        FROM plan_draft_goals root
        JOIN plan_draft_goal_revisions revision
          ON revision.plan_goal_id = root.id AND revision.id = root.current_revision_id
        JOIN goal_definition_versions version
          ON version.goal_definition_id = root.goal_definition_id
         AND version.id = revision.goal_definition_version_id
       WHERE root.id = ${planGoalId}::uuid
         AND root.plan_month_id = ${planMonthId}::uuid
         AND root.space_id = ${spaceId}::uuid AND root.detached_at IS NULL
       FOR UPDATE OF root
    `.then((rows) => rows[0] ?? null)
  }

  private async assertOwner(
    client: Client,
    spaceId: string,
    config: DraftGoalConfigV1,
  ): Promise<void> {
    if (
      config.scope.kind !== 'personal' ||
      config.scope.ownerMemberId === null
    ) {
      return
    }
    const rows = await client.$queryRaw<{ readonly exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM memberships
         WHERE id = ${config.scope.ownerMemberId}::uuid
           AND space_id = ${spaceId}::uuid
      ) exists
    `
    if (rows[0]?.exists !== true) throw new DraftGoalNotFoundError()
  }

  private activeOrder(
    client: Client,
    planMonthId: string,
  ): Promise<readonly string[]> {
    return client.$queryRaw<{ readonly id: string }[]>`
      SELECT id::text FROM plan_draft_goals
       WHERE plan_month_id = ${planMonthId}::uuid AND detached_at IS NULL
       ORDER BY display_order, id
    `.then((rows) => rows.map((row) => row.id))
  }

  private assertStableIds(
    before: DraftGoalConfigV1,
    after: DraftGoalConfigV1,
    commandId: string,
    historical: ReadonlyMap<string, ChildFamily>,
  ): void {
    const known = collectIds(before)
    for (const [id, family] of collectIds(after)) {
      if (
        (known.has(id) && known.get(id) !== family) ||
        (!known.has(id) &&
          (historical.has(id) || !isGeneratedDraftGoalChildId(commandId, id)))
      ) {
        throw new CommandValidationError()
      }
    }
  }

  private async historicalChildIds(
    client: Client,
    planGoalId: string,
  ): Promise<ReadonlyMap<string, ChildFamily>> {
    const rows = await client.$queryRaw<{ readonly config: unknown }[]>`
      SELECT config FROM plan_draft_goal_revisions
       WHERE plan_goal_id = ${planGoalId}::uuid
       ORDER BY revision_number
    `
    const result = new Map<string, ChildFamily>()
    for (const row of rows) {
      for (const [id, family] of collectIds(
        snapshotStoredDraftGoalConfig(row.config),
      )) {
        const previousFamily = result.get(id)
        if (previousFamily !== undefined && previousFamily !== family) {
          throw new Error('Stored draft-goal child identity changed family')
        }
        result.set(id, family)
      }
    }
    return result
  }

  private async history(
    client: Client,
    input: PlanningCommandIdentity & {
      readonly memberId: string
      readonly planMonthId: string
    },
    change: {
      readonly actionKind:
        | 'draft_goal_added'
        | 'draft_goal_updated'
        | 'draft_goal_removed'
        | 'draft_goals_reordered'
      readonly beforeRevision: bigint
      readonly afterRevision: bigint
      readonly planGoalId: string | null
      readonly beforeRevisionId: string | null
      readonly afterRevisionId: string | null
      readonly reorderedGoalCount: number | null
      readonly beforeOrder?: readonly string[] | null
      readonly afterOrder?: readonly string[] | null
    },
  ): Promise<void> {
    const actionId = randomUUID()
    const actor = actorColumns(input, input.memberId)
    await client.$executeRaw`
      INSERT INTO planning_action_groups
        (id, action_kind, actor_kind, actor_scope, member_id, system_actor_id,
         plan_month_id, goal_definition_id, command_type, command_id,
         before_revision, after_revision, occurred_at)
      VALUES (${actionId}::uuid, ${change.actionKind}, ${actor.actorKind},
              ${input.actorScope}, ${actor.memberId}::uuid,
              ${actor.systemActorId}, ${input.planMonthId}::uuid, NULL,
              ${input.commandType}, ${input.commandId}::uuid,
              ${change.beforeRevision}, ${change.afterRevision},
              ${input.occurredAt})
    `
    await client.$executeRaw`
      INSERT INTO planning_draft_goal_changes
        (action_id, plan_goal_id, before_revision_id, after_revision_id,
         reordered_goal_count, before_order, after_order)
      VALUES (${actionId}::uuid, ${change.planGoalId}::uuid,
              ${change.beforeRevisionId}::uuid, ${change.afterRevisionId}::uuid,
              ${change.reorderedGoalCount},
              ${change.beforeOrder ?? []}::uuid[],
              ${change.afterOrder ?? []}::uuid[])
    `
  }
}
