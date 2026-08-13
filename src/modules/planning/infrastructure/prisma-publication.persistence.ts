import { randomUUID } from 'node:crypto'

import { Prisma } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  DraftEditorView,
  DraftGoalView,
} from '../application/draft-goal.types'
import {
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanMonthAlreadyPublishedError,
  PlanPublicationBlockedError,
  PublicationPreviewConflictError,
} from '../application/planning-errors'
import type {
  PublicationPersistencePort,
  PublicationRef,
  PublishMonthPersistenceInput,
} from '../application/publication-persistence.port'
import {
  PUBLICATION_PREVIEW_HASH_VERSION,
  PUBLICATION_PREVIEW_SCHEMA_VERSION,
  buildPublicationPreview,
} from '../application/publication-preview'
import {
  snapshotStoredDraftGoalConfig,
  snapshotSourceProvenance,
} from '../domain/goal-config'
import { validateGoalConfig } from '../domain/goal-validation'
import {
  buildPublicationMaterialization,
  type PublicationMaterializationIdentity,
} from '../domain/publication-builder'
import {
  PUBLISHED_SNAPSHOT_SCHEMA_VERSION,
  type PublishedCalculatedTarget,
  type PublishedGoalSnapshot,
  type PublishedSnapshot,
} from '../domain/publication'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

export type PublicationWritePhase =
  | 'publication'
  | 'goal_snapshots'
  | 'fixed_expectations'
  | 'flexible_periods'
  | 'month_pointer'
  | 'history'

export type PublicationWriteObserver = (
  phase: PublicationWritePhase,
) => void | Promise<void>

type LockedDraftRow = {
  readonly plan_month_id: string
  readonly space_id: string
  readonly target_month: string
  readonly status: string
  readonly active_publication_id: string | null
  readonly focus: string
  readonly plan_month_revision: bigint
  readonly draft_revision: bigint
  readonly goals: unknown
}

type StoredPublicationRow = {
  readonly publication_id: string
  readonly publication_revision: bigint
  readonly plan_month_id: string
  readonly space_id: string
  readonly target_month: string
  readonly source_plan_month_revision: bigint
  readonly source_draft_revision: bigint
  readonly source_preview_schema_version: string
  readonly preview_hash_version: string
  readonly preview_hash: string
  readonly activation_mode: 'immediate' | 'scheduled'
  readonly active_local_date: string
  readonly late_publication: boolean
  readonly focus: string
  readonly calendar_formula_version: 'planner.calendar-targets.v1'
  readonly evaluation_formula_version: 'planner.goal-evaluation.v1'
  readonly score_formula_version: 'planner.score-coverage.v1'
  readonly goals: unknown
}

const PUBLICATION_SELECT = Prisma.sql`
  SELECT publication.id::text publication_id,
         publication.publication_revision,
         publication.plan_month_id::text plan_month_id,
         publication.space_id::text space_id,
         to_char(month.month_start, 'YYYY-MM') target_month,
         publication.source_plan_month_revision,
         publication.source_draft_revision,
         publication.source_preview_schema_version,
         publication.preview_hash_version, publication.preview_hash,
         publication.activation_mode,
         publication.active_local_date::text active_local_date,
         publication.late_publication, publication.focus,
         publication.calendar_formula_version,
         publication.evaluation_formula_version,
         publication.score_formula_version,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'plan_goal_snapshot_id', snapshot.id::text,
             'source_plan_goal_id', snapshot.source_plan_goal_id::text,
             'goal_definition_id', snapshot.goal_definition_id::text,
             'goal_definition_version_id', snapshot.goal_definition_version_id::text,
             'goal_series_id', snapshot.goal_series_id::text,
             'title', snapshot.title, 'why', snapshot.why,
             'category', snapshot.category,
             'display_order', snapshot.display_order,
             'source_config_revision', snapshot.source_config_revision::text,
             'config', snapshot.config,
             'source_provenance', snapshot.source_provenance,
             'calendar', snapshot.calendar
           ) ORDER BY snapshot.display_order, snapshot.id)
             FROM plan_goal_snapshots snapshot
            WHERE snapshot.publication_id = publication.id
         ), '[]'::jsonb) goals
    FROM plan_publications publication
    JOIN plan_months month ON month.id = publication.plan_month_id
`

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function lockedGoals(value: unknown): {
  readonly goals: readonly DraftGoalView[]
  readonly sourceRevisionIds: ReadonlyMap<string, string>
} {
  if (!Array.isArray(value)) throw new Error('Invalid stored publication goals')
  const sourceRevisionIds = new Map<string, string>()
  const goals = value.map((item): DraftGoalView => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Invalid stored publication goal')
    }
    const row = item as Record<string, unknown>
    const planGoalId = String(row['plan_goal_id'])
    sourceRevisionIds.set(planGoalId, String(row['current_revision_id']))
    return {
      planGoalId,
      goalDefinitionId: String(row['goal_definition_id']),
      goalDefinitionVersionId: String(row['goal_definition_version_id']),
      goalSeriesId: String(row['goal_series_id']),
      title: String(row['title']),
      why: String(row['why']),
      category: String(row['category']),
      displayOrder: Number(row['display_order']),
      configRevision: BigInt(String(row['config_revision'])),
      config: snapshotStoredDraftGoalConfig(row['config']),
      sourceProvenance:
        row['source_provenance'] === null ||
        row['source_provenance'] === undefined
          ? null
          : snapshotSourceProvenance(row['source_provenance']),
      blockers: [],
    }
  })
  return { goals: Object.freeze(goals), sourceRevisionIds }
}

function publishedSnapshot(row: StoredPublicationRow): PublishedSnapshot {
  if (!Array.isArray(row.goals)) throw new Error('Invalid published snapshot')
  if (
    row.source_preview_schema_version !== PUBLICATION_PREVIEW_SCHEMA_VERSION ||
    row.preview_hash_version !== PUBLICATION_PREVIEW_HASH_VERSION
  ) {
    throw new Error('Invalid published snapshot version')
  }
  const goalSnapshots: PublishedGoalSnapshot[] = []
  const calculatedTargets: PublishedCalculatedTarget[] = []
  for (const value of row.goals) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Invalid published goal snapshot')
    }
    const goal = value as Record<string, unknown>
    const planGoalSnapshotId = String(goal['plan_goal_snapshot_id'])
    const sourcePlanGoalId = String(goal['source_plan_goal_id'])
    const storedConfig = snapshotStoredDraftGoalConfig(goal['config'])
    const refinedConfig = validateGoalConfig(sourcePlanGoalId, storedConfig)
    if (!refinedConfig.publishable) {
      throw new Error('Invalid published goal config')
    }
    goalSnapshots.push({
      planGoalSnapshotId,
      sourcePlanGoalId,
      sourceGoalDefinitionId: String(goal['goal_definition_id']),
      sourceGoalDefinitionVersionId: String(goal['goal_definition_version_id']),
      sourceGoalSeriesId: String(goal['goal_series_id']),
      title: String(goal['title']),
      why: String(goal['why']),
      category: String(goal['category']),
      displayOrder: Number(goal['display_order']),
      configRevision: String(goal['source_config_revision']),
      config: refinedConfig.config,
      sourceProvenance:
        goal['source_provenance'] === null
          ? null
          : snapshotSourceProvenance(goal['source_provenance']),
    })
    calculatedTargets.push({
      planGoalSnapshotId,
      sourcePlanGoalId,
      formulaVersion: row.calendar_formula_version,
      calendar: goal['calendar'] as PublishedCalculatedTarget['calendar'],
    })
  }
  return freeze({
    schemaVersion: PUBLISHED_SNAPSHOT_SCHEMA_VERSION,
    publicationId: row.publication_id,
    publicationRevision: row.publication_revision.toString(10),
    planMonthId: row.plan_month_id,
    spaceId: row.space_id,
    targetMonth: row.target_month,
    sourcePlanMonthRevision: row.source_plan_month_revision.toString(10),
    sourceDraftRevision: row.source_draft_revision.toString(10),
    sourcePreviewSchemaVersion: PUBLICATION_PREVIEW_SCHEMA_VERSION,
    publicationSnapshotHashVersion: PUBLICATION_PREVIEW_HASH_VERSION,
    publicationSnapshotHash: row.preview_hash,
    activation: {
      mode: row.activation_mode,
      activeLocalDate: row.active_local_date,
      latePublication: row.late_publication,
    },
    focus: row.focus,
    goalSnapshots,
    calculatedTargets,
    formulaVersions: {
      calendarTargets: row.calendar_formula_version,
      goalEvaluation: row.evaluation_formula_version,
      scoreCoverage: row.score_formula_version,
    },
  })
}

export class PrismaPublicationPersistence implements PublicationPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: PublicationWriteObserver = () => {},
  ) {}

  public publish(input: PublishMonthPersistenceInput): Promise<PublicationRef> {
    return this.database.withClient(async (client) => {
      const draft = await this.lockDraft(client, input.planMonthId)
      if (draft === null || draft.space_id !== input.spaceId) {
        throw new PlanDraftNotFoundError()
      }
      if (draft.status !== 'draft') {
        if (
          draft.status === 'published' &&
          draft.active_publication_id !== null
        ) {
          const revision = await client.$queryRaw<
            { readonly publication_revision: bigint }[]
          >`SELECT publication_revision FROM plan_publications
             WHERE id = ${draft.active_publication_id}::uuid`
          throw new PlanMonthAlreadyPublishedError(
            draft.active_publication_id,
            revision[0]?.publication_revision ?? 1n,
          )
        }
        throw new PlanDraftNotEditableError()
      }
      const parsed = lockedGoals(draft.goals)
      const editor: DraftEditorView = {
        planMonthId: draft.plan_month_id,
        spaceId: draft.space_id,
        targetMonth: draft.target_month,
        status: 'draft',
        focus: draft.focus,
        planMonthRevision: draft.plan_month_revision,
        draftRevision: draft.draft_revision,
        goals: parsed.goals,
        blockers: [],
      }
      const preview = buildPublicationPreview(editor, input.localDate)
      if (
        draft.draft_revision !== input.expectedDraftRevision ||
        input.previewSchemaVersion !== PUBLICATION_PREVIEW_SCHEMA_VERSION ||
        input.previewHashVersion !== PUBLICATION_PREVIEW_HASH_VERSION ||
        input.previewHash !== preview.previewHash
      ) {
        throw new PublicationPreviewConflictError(
          draft.draft_revision,
          preview.schemaVersion,
          preview.previewHashVersion,
          preview.previewHash,
        )
      }
      if (preview.blockers.length !== 0) {
        throw new PlanPublicationBlockedError(preview.blockers)
      }

      const existing = await client.$queryRaw<
        { readonly revision: bigint }[]
      >`SELECT COALESCE(max(publication_revision), 0) + 1 revision
           FROM plan_publications WHERE plan_month_id = ${input.planMonthId}::uuid`
      const publicationRevision = existing[0]?.revision ?? 1n
      const publicationId = randomUUID()
      const identity: PublicationMaterializationIdentity = {
        publicationId,
        publicationRevision,
        publishedByMemberId: input.memberId,
        occurredAt: input.occurredAt,
        sourceRevisionIdByPlanGoalId: parsed.sourceRevisionIds,
        nextId: randomUUID,
      }
      const materialization = buildPublicationMaterialization(preview, identity)
      await this.insertPublication(client, input, materialization.snapshot)
      await this.afterWritePhase('publication')
      if (materialization.goalSnapshots.length !== 0) {
        const rows = materialization.goalSnapshots.map((goal) => ({
          id: goal.planGoalSnapshotId,
          publication_id: goal.publicationId,
          space_id: goal.spaceId,
          plan_month_id: goal.planMonthId,
          source_plan_goal_id: goal.sourcePlanGoalId,
          source_draft_goal_revision_id: goal.sourceDraftGoalRevisionId,
          source_config_revision: goal.configRevision,
          goal_definition_id: goal.sourceGoalDefinitionId,
          goal_definition_version_id: goal.sourceGoalDefinitionVersionId,
          goal_series_id: goal.sourceGoalSeriesId,
          display_order: goal.displayOrder,
          title: goal.title,
          why: goal.why,
          category: goal.category,
          scope_kind: goal.config.scope.kind,
          owner_member_id:
            goal.config.scope.kind === 'personal'
              ? goal.config.scope.ownerMemberId
              : null,
          config: goal.config,
          source_provenance: goal.sourceProvenance,
          calendar: goal.calendar,
        }))
        await client.$executeRaw`
          INSERT INTO plan_goal_snapshots
            (id, publication_id, space_id, plan_month_id,
             source_plan_goal_id, source_draft_goal_revision_id,
             source_config_revision, goal_definition_id,
             goal_definition_version_id, goal_series_id, display_order,
             title, why, category, scope_kind, owner_member_id,
             config, source_provenance, calendar)
          SELECT row.id::uuid, row.publication_id::uuid, row.space_id::uuid,
                 row.plan_month_id::uuid, row.source_plan_goal_id::uuid,
                 row.source_draft_goal_revision_id::uuid,
                 row.source_config_revision::bigint,
                 row.goal_definition_id::uuid,
                 row.goal_definition_version_id::uuid,
                 row.goal_series_id::uuid, row.display_order, row.title,
                 row.why, row.category, row.scope_kind,
                 row.owner_member_id::uuid, row.config,
                 row.source_provenance, row.calendar
            FROM jsonb_to_recordset(${json(rows)}::jsonb) AS row(
              id text, publication_id text, space_id text, plan_month_id text,
              source_plan_goal_id text, source_draft_goal_revision_id text,
              source_config_revision text, goal_definition_id text,
              goal_definition_version_id text, goal_series_id text,
              display_order integer, title text, why text, category text,
              scope_kind text, owner_member_id text, config jsonb,
              source_provenance jsonb, calendar jsonb
            )
        `
      }
      await this.afterWritePhase('goal_snapshots')
      if (materialization.fixedExpectations.length !== 0) {
        const rows = materialization.fixedExpectations.map((expectation) => ({
          id: expectation.id,
          publication_id: expectation.publicationId,
          plan_goal_snapshot_id: expectation.planGoalSnapshotId,
          expectation_date: expectation.expectationDate,
          component_kind: expectation.componentKind,
          component_id: expectation.componentId,
        }))
        await client.$executeRaw`
          INSERT INTO fixed_expectations
            (id, publication_id, plan_goal_snapshot_id, expectation_date,
             component_kind, component_id)
          SELECT row.id::uuid, row.publication_id::uuid,
                 row.plan_goal_snapshot_id::uuid, row.expectation_date::date,
                 row.component_kind, row.component_id::uuid
            FROM jsonb_to_recordset(
              ${json(rows)}::jsonb
            ) AS row(
              id text, publication_id text, plan_goal_snapshot_id text,
              expectation_date text, component_kind text, component_id text
            )
        `
      }
      await this.afterWritePhase('fixed_expectations')
      if (materialization.flexiblePeriods.length !== 0) {
        const rows = materialization.flexiblePeriods.map((period) => ({
          id: period.id,
          publication_id: period.publicationId,
          plan_goal_snapshot_id: period.planGoalSnapshotId,
          period_kind: period.periodKind,
          ordinal: period.ordinal,
          period_start: period.periodStart,
          period_end: period.periodEnd,
          period_days: period.periodDays,
          active_dates: period.activeDates,
          eligible_dates: period.eligibleDates,
          period_target: period.periodTarget,
        }))
        await client.$executeRaw`
          INSERT INTO flexible_periods
            (id, publication_id, plan_goal_snapshot_id, period_kind, ordinal,
             period_start, period_end, period_days, active_dates,
             eligible_dates, period_target)
          SELECT row.id::uuid, row.publication_id::uuid,
                 row.plan_goal_snapshot_id::uuid, row.period_kind,
                 row.ordinal, row.period_start::date, row.period_end::date,
                 row.period_days,
                 ARRAY(SELECT jsonb_array_elements_text(row.active_dates))::date[],
                 ARRAY(SELECT jsonb_array_elements_text(row.eligible_dates))::date[],
                 row.period_target
            FROM jsonb_to_recordset(
              ${json(rows)}::jsonb
            ) AS row(
              id text, publication_id text, plan_goal_snapshot_id text,
              period_kind text, ordinal integer, period_start text,
              period_end text, period_days integer, active_dates jsonb,
              eligible_dates jsonb, period_target integer
            )
        `
      }
      await this.afterWritePhase('flexible_periods')
      const nextMonthRevision = draft.plan_month_revision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET status = 'published', revision = ${nextMonthRevision},
               active_publication_id = ${publicationId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${input.planMonthId}::uuid
      `
      await this.afterWritePhase('month_pointer')
      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          (${actionId}::uuid, 'month_published', 'member', ${input.actorScope},
           ${input.memberId}::uuid, NULL, ${input.planMonthId}::uuid, NULL,
           ${input.commandType}, ${input.commandId}::uuid,
           ${draft.plan_month_revision}, ${nextMonthRevision},
           ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO planning_publication_changes
          (action_id, publication_id, confirmed_draft_revision,
           confirmed_preview_schema_version, confirmed_preview_hash_version,
           confirmed_preview_hash, before_active_publication_id,
           after_active_publication_id)
        VALUES
          (${actionId}::uuid, ${publicationId}::uuid,
           ${draft.draft_revision}, ${preview.schemaVersion},
           ${preview.previewHashVersion}, ${preview.previewHash}, NULL,
           ${publicationId}::uuid)
      `
      await this.afterWritePhase('history')
      return { publicationId, publicationRevision }
    })
  }

  public findPublished(
    spaceId: string,
    publicationId: string,
  ): Promise<PublishedSnapshot | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<StoredPublicationRow[]>`
          ${PUBLICATION_SELECT}
           WHERE publication.space_id = ${spaceId}::uuid
             AND publication.id = ${publicationId}::uuid
        `
      return rows[0] === undefined ? null : publishedSnapshot(rows[0])
    })
  }

  public findActive(
    spaceId: string,
    localDate: string,
  ): Promise<PublishedSnapshot | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<StoredPublicationRow[]>`
          ${PUBLICATION_SELECT}
           WHERE publication.space_id = ${spaceId}::uuid
             AND month.month_start = ${`${localDate.slice(0, 7)}-01`}::date
             AND month.status = 'published'
             AND month.active_publication_id = publication.id
             AND publication.active_local_date <= ${localDate}::date
        `
      return rows[0] === undefined ? null : publishedSnapshot(rows[0])
    })
  }

  private lockDraft(
    client: Client,
    planMonthId: string,
  ): Promise<LockedDraftRow | null> {
    return client.$queryRaw<LockedDraftRow[]>`
      SELECT month.id::text plan_month_id, month.space_id::text space_id,
             to_char(month.month_start, 'YYYY-MM') target_month, month.status,
             month.active_publication_id::text, draft.focus,
             month.revision plan_month_revision, draft.revision draft_revision,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
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
               ) ORDER BY root.display_order, root.id)
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
       WHERE month.id = ${planMonthId}::uuid
       FOR UPDATE OF month, draft
    `.then((rows) => rows[0] ?? null)
  }

  private insertPublication(
    client: Client,
    input: PublishMonthPersistenceInput,
    snapshot: PublishedSnapshot,
  ): Promise<number> {
    return client.$executeRaw`
      INSERT INTO plan_publications
        (id, space_id, plan_month_id, publication_revision,
         source_draft_revision, source_plan_month_revision, focus,
         activation_mode, active_local_date, late_publication, time_zone,
         source_preview_schema_version, preview_hash_version, preview_hash,
         calendar_formula_version, evaluation_formula_version,
         score_formula_version, published_by_member_id, published_at)
      VALUES
        (${snapshot.publicationId}::uuid, ${snapshot.spaceId}::uuid,
         ${snapshot.planMonthId}::uuid, ${BigInt(snapshot.publicationRevision)},
         ${BigInt(snapshot.sourceDraftRevision)},
         ${BigInt(snapshot.sourcePlanMonthRevision)}, ${snapshot.focus},
         ${snapshot.activation.mode}, ${snapshot.activation.activeLocalDate}::date,
         ${snapshot.activation.latePublication}, 'Asia/Yekaterinburg',
         ${snapshot.sourcePreviewSchemaVersion},
         ${snapshot.publicationSnapshotHashVersion},
         ${snapshot.publicationSnapshotHash},
         ${snapshot.formulaVersions.calendarTargets},
         ${snapshot.formulaVersions.goalEvaluation},
         ${snapshot.formulaVersions.scoreCoverage}, ${input.memberId}::uuid,
         ${input.occurredAt})
    `
  }
}
