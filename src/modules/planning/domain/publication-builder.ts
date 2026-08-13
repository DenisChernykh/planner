import { snapshotStoredDraftGoalConfig, type GoalConfigV1 } from './goal-config'
import { validateGoalConfig } from './goal-validation'
import {
  PUBLISHED_SNAPSHOT_SCHEMA_VERSION,
  type FixedExpectationRow,
  type FlexiblePeriodRow,
  type PublicationMaterialization,
  type PublicationMaterializationPreview,
  type PublishedCalculatedTarget,
  type PublishedGoalSnapshot,
} from './publication'

export type PublicationMaterializationIdentity = {
  readonly publicationId: string
  readonly publicationRevision: bigint
  readonly publishedByMemberId: string
  readonly occurredAt: Date
  readonly sourceRevisionIdByPlanGoalId: ReadonlyMap<string, string>
  readonly nextId: () => string
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T
  }
  return value
}

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

function components(config: GoalConfigV1): readonly {
  readonly kind: FixedExpectationRow['componentKind']
  readonly id: string | null
}[] {
  if (config.checkpoints !== null) {
    return config.checkpoints.items.map((item) => ({
      kind: 'checkpoint' as const,
      id: item.checkpointId,
    }))
  }
  if (config.measurement.kind === 'checklist') {
    return config.measurement.items.map((item) => ({
      kind: 'checklist_item' as const,
      id: item.itemId,
    }))
  }
  return [{ kind: 'goal', id: null }]
}

function assertPublishablePreview(
  preview: PublicationMaterializationPreview,
): void {
  if (
    preview.blockers.length !== 0 ||
    preview.activation.mode === 'blocked' ||
    preview.goals.length !== preview.calculatedTargets.length
  ) {
    throw new TypeError('Publication preview is not materializable')
  }
  const goalIds = new Set(preview.goals.map((goal) => goal.planGoalId))
  const targetIds = new Set(
    preview.calculatedTargets.map((target) => target.planGoalId),
  )
  if (
    goalIds.size !== preview.goals.length ||
    targetIds.size !== preview.calculatedTargets.length ||
    [...goalIds].some((id) => !targetIds.has(id))
  ) {
    throw new TypeError('Publication preview targets are incomplete')
  }
}

function refinedGoalConfigs(
  preview: PublicationMaterializationPreview,
): ReadonlyMap<string, GoalConfigV1> {
  const result = new Map<string, GoalConfigV1>()
  for (const goal of preview.goals) {
    try {
      const validation = validateGoalConfig(
        goal.planGoalId,
        snapshotStoredDraftGoalConfig(goal.config),
      )
      if (!validation.publishable) {
        throw new TypeError(
          'Publication preview goal config is not publishable',
        )
      }
      result.set(goal.planGoalId, validation.config)
    } catch (error: unknown) {
      if (
        error instanceof TypeError &&
        error.message === 'Publication preview goal config is not publishable'
      ) {
        throw error
      }
      throw new TypeError(
        'Publication preview goal config is not publishable',
        {
          cause: error,
        },
      )
    }
  }
  return result
}

export function buildPublicationMaterialization(
  preview: PublicationMaterializationPreview,
  identity: PublicationMaterializationIdentity,
): PublicationMaterialization {
  assertPublishablePreview(preview)
  const configByGoalId = refinedGoalConfigs(preview)
  if (identity.publicationRevision <= 0n) {
    throw new TypeError('Publication revision must be positive')
  }

  const targetByGoal = new Map(
    preview.calculatedTargets.map((target) => [target.planGoalId, target]),
  )
  const goalSnapshots: PublishedGoalSnapshot[] = []
  const calculatedTargets: PublishedCalculatedTarget[] = []
  const persistenceGoals: PublicationMaterialization['goalSnapshots'][number][] =
    []
  const fixedExpectations: FixedExpectationRow[] = []
  const flexiblePeriods: FlexiblePeriodRow[] = []

  for (const goal of preview.goals) {
    const target = targetByGoal.get(goal.planGoalId)
    if (target === undefined) {
      throw new TypeError('Publication preview target is missing')
    }
    const config = configByGoalId.get(goal.planGoalId)
    if (config === undefined) {
      throw new TypeError('Publication preview goal config is not publishable')
    }
    const planGoalSnapshotId = identity.nextId()
    const publishedGoal: PublishedGoalSnapshot = {
      planGoalSnapshotId,
      sourcePlanGoalId: goal.planGoalId,
      sourceGoalDefinitionId: goal.goalDefinitionId,
      sourceGoalDefinitionVersionId: goal.goalDefinitionVersionId,
      sourceGoalSeriesId: goal.goalSeriesId,
      title: goal.title,
      why: goal.why,
      category: goal.category,
      displayOrder: goal.displayOrder,
      configRevision: goal.configRevision,
      config: clone(config),
      sourceProvenance: clone(goal.sourceProvenance),
    }
    goalSnapshots.push(publishedGoal)
    calculatedTargets.push({
      planGoalSnapshotId,
      sourcePlanGoalId: goal.planGoalId,
      formulaVersion: target.formulaVersion,
      calendar: clone(target.calendar),
    })
    persistenceGoals.push({
      ...publishedGoal,
      publicationId: identity.publicationId,
      planMonthId: preview.planMonthId,
      spaceId: preview.spaceId,
      sourceDraftGoalRevisionId:
        identity.sourceRevisionIdByPlanGoalId.get(goal.planGoalId) ??
        (() => {
          throw new TypeError('Publication source revision is missing')
        })(),
      calendar: clone(target.calendar),
    })

    if (target.calendar.kind === 'fixed') {
      for (const expectationDate of target.calendar.expectationDates) {
        for (const component of components(config)) {
          fixedExpectations.push({
            id: identity.nextId(),
            publicationId: identity.publicationId,
            planGoalSnapshotId,
            expectationDate,
            componentKind: component.kind,
            componentId: component.id,
          })
        }
      }
      continue
    }
    if (target.calendar.kind === 'quota') {
      for (const period of target.calendar.periods) {
        flexiblePeriods.push({
          id: identity.nextId(),
          publicationId: identity.publicationId,
          planGoalSnapshotId,
          periodKind: target.calendar.cadence,
          ordinal: period.ordinal,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          periodDays: period.periodDays,
          activeDates: [...period.activeDates],
          eligibleDates: [...period.eligibleDates],
          periodTarget: period.periodTarget,
        })
      }
    } else {
      for (const period of target.calendar.periods) {
        flexiblePeriods.push({
          id: identity.nextId(),
          publicationId: identity.publicationId,
          planGoalSnapshotId,
          periodKind: 'weekly_planned_task',
          ordinal: period.ordinal,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          periodDays: null,
          activeDates: [],
          eligibleDates: [],
          periodTarget: period.periodTarget,
        })
      }
    }
  }

  return freeze({
    snapshot: {
      schemaVersion: PUBLISHED_SNAPSHOT_SCHEMA_VERSION,
      publicationId: identity.publicationId,
      publicationRevision: identity.publicationRevision.toString(10),
      planMonthId: preview.planMonthId,
      spaceId: preview.spaceId,
      targetMonth: preview.targetMonth,
      sourcePlanMonthRevision: preview.planMonthRevision,
      sourceDraftRevision: preview.draftRevision,
      sourcePreviewSchemaVersion: preview.schemaVersion,
      publicationSnapshotHashVersion: preview.previewHashVersion,
      publicationSnapshotHash: preview.previewHash,
      activation: clone(preview.activation) as {
        readonly mode: 'immediate' | 'scheduled'
        readonly activeLocalDate: string
        readonly latePublication: boolean
      },
      focus: preview.focus,
      goalSnapshots,
      calculatedTargets,
      formulaVersions: clone(preview.formulaVersions),
    },
    goalSnapshots: persistenceGoals,
    fixedExpectations,
    flexiblePeriods,
  })
}
