import type {
  DraftGoalConfigV1,
  GoalConfigV1,
  SourceProvenanceV1,
} from './goal-config'

export const PUBLISHED_SNAPSHOT_SCHEMA_VERSION =
  'planner.published-snapshot.v1' as const
export const PLANNING_TIME_ZONE = 'Asia/Yekaterinburg' as const

export type PublicationCalendar =
  | {
      readonly targetMonth: string
      readonly activeLocalDate: string
      readonly timeZone: typeof PLANNING_TIME_ZONE
      readonly kind: 'fixed'
      readonly expectationDates: readonly string[]
    }
  | {
      readonly targetMonth: string
      readonly activeLocalDate: string
      readonly timeZone: typeof PLANNING_TIME_ZONE
      readonly kind: 'quota'
      readonly cadence: 'weekly' | 'monthly'
      readonly periods: readonly {
        readonly cadence: 'weekly' | 'monthly'
        readonly ordinal: number
        readonly periodStart: string
        readonly periodEnd: string
        readonly periodDays: number
        readonly activeDates: readonly string[]
        readonly eligibleDates: readonly string[]
        readonly periodTarget: number
      }[]
    }
  | {
      readonly targetMonth: string
      readonly activeLocalDate: string
      readonly timeZone: typeof PLANNING_TIME_ZONE
      readonly kind: 'weekly_planned_task'
      readonly periods: readonly {
        readonly cadence: 'weekly'
        readonly ordinal: number
        readonly periodStart: string
        readonly periodEnd: string
        readonly periodTarget: 1
      }[]
    }

export type PublicationMaterializationPreview = {
  readonly schemaVersion: 'planner.publication-preview.v1'
  readonly planMonthId: string
  readonly spaceId: string
  readonly targetMonth: string
  readonly planMonthRevision: string
  readonly draftRevision: string
  readonly previewHashVersion: 'planner.publication-preview-hash.v1'
  readonly previewHash: string
  readonly activation: {
    readonly mode: 'immediate' | 'scheduled' | 'blocked'
    readonly activeLocalDate: string
    readonly latePublication: boolean
  }
  readonly focus: string
  readonly goals: readonly {
    readonly planGoalId: string
    readonly goalDefinitionId: string
    readonly goalDefinitionVersionId: string
    readonly goalSeriesId: string
    readonly title: string
    readonly why: string
    readonly category: string
    readonly displayOrder: number
    readonly configRevision: string
    readonly config: DraftGoalConfigV1
    readonly sourceProvenance: SourceProvenanceV1 | null
  }[]
  readonly calculatedTargets: readonly {
    readonly planGoalId: string
    readonly formulaVersion: 'planner.calendar-targets.v1'
    readonly calendar: PublicationCalendar
  }[]
  readonly blockers: readonly unknown[]
  readonly formulaVersions: {
    readonly calendarTargets: 'planner.calendar-targets.v1'
    readonly goalEvaluation: 'planner.goal-evaluation.v1'
    readonly scoreCoverage: 'planner.score-coverage.v1'
  }
}

export type PublishedGoalSnapshot = {
  readonly planGoalSnapshotId: string
  readonly sourcePlanGoalId: string
  readonly sourceGoalDefinitionId: string
  readonly sourceGoalDefinitionVersionId: string
  readonly sourceGoalSeriesId: string
  readonly title: string
  readonly why: string
  readonly category: string
  readonly displayOrder: number
  readonly configRevision: string
  readonly config: GoalConfigV1
  readonly sourceProvenance: SourceProvenanceV1 | null
}

export type PublishedCalculatedTarget = {
  readonly planGoalSnapshotId: string
  readonly sourcePlanGoalId: string
  readonly formulaVersion: 'planner.calendar-targets.v1'
  readonly calendar: PublicationCalendar
}

export type PublishedSnapshot = {
  readonly schemaVersion: typeof PUBLISHED_SNAPSHOT_SCHEMA_VERSION
  readonly publicationId: string
  readonly publicationRevision: string
  readonly planMonthId: string
  readonly spaceId: string
  readonly targetMonth: string
  readonly sourcePlanMonthRevision: string
  readonly sourceDraftRevision: string
  readonly sourcePreviewSchemaVersion: 'planner.publication-preview.v1'
  readonly publicationSnapshotHashVersion: 'planner.publication-preview-hash.v1'
  readonly publicationSnapshotHash: string
  readonly activation: {
    readonly mode: 'immediate' | 'scheduled'
    readonly activeLocalDate: string
    readonly latePublication: boolean
  }
  readonly focus: string
  readonly goalSnapshots: readonly PublishedGoalSnapshot[]
  readonly calculatedTargets: readonly PublishedCalculatedTarget[]
  readonly formulaVersions: PublicationMaterializationPreview['formulaVersions']
}

export type PublicationGoalSnapshotRow = PublishedGoalSnapshot & {
  readonly publicationId: string
  readonly planMonthId: string
  readonly spaceId: string
  readonly sourceDraftGoalRevisionId: string
  readonly calendar: PublicationCalendar
}

export type FixedExpectationRow = {
  readonly id: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly expectationDate: string
  readonly componentKind: 'goal' | 'checkpoint' | 'checklist_item'
  readonly componentId: string | null
}

export type FlexiblePeriodRow = {
  readonly id: string
  readonly publicationId: string
  readonly planGoalSnapshotId: string
  readonly periodKind: 'weekly' | 'monthly' | 'weekly_planned_task'
  readonly ordinal: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodDays: number | null
  readonly activeDates: readonly string[]
  readonly eligibleDates: readonly string[]
  readonly periodTarget: number
}

export type PublicationMaterialization = {
  readonly snapshot: PublishedSnapshot
  readonly goalSnapshots: readonly PublicationGoalSnapshotRow[]
  readonly fixedExpectations: readonly FixedExpectationRow[]
  readonly flexiblePeriods: readonly FlexiblePeriodRow[]
}
