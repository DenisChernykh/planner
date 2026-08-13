import type { GoalConfigV1 } from '@/modules/planning/domain/goal-config'
import type { PublicationCalendar } from '@/modules/planning/domain/publication'
import type { GoalProgressResult } from '@/modules/progress'
import type { CanonicalExactRatio } from '@/modules/progress'
import type { ActorRef } from '@/shared/application/application-command'

import type { TrackingStoredFactValueV1 } from './tracking.types'

export type GetTodayInput = {
  readonly trustedActor: ActorRef
}

export type GetMonthInput = {
  readonly trustedActor: ActorRef
  readonly targetMonth: string
}

export type TrackingMonthPhaseV1 = 'future' | 'active' | 'grace' | 'closed'
export type TrackingViewerAccessV1 =
  'personal_owner' | 'shared' | 'partner_read_only'
export type TrackingDayStateV1 =
  'future' | 'not_applicable' | 'no_data' | 'partial' | 'filled'
export type TrackingExpectationStateV1 =
  'no_data' | 'partial' | 'done' | 'not_done'

export type TrackingFactReadV1 = {
  readonly factRecordId: string
  readonly revision: bigint
  readonly factKind:
    | 'boolean'
    | 'quantity_add'
    | 'quantity_latest'
    | 'actual_time'
    | 'rating'
    | 'text'
    | 'checklist_item'
    | 'or_variant'
    | 'fixed_not_done'
  readonly contributionId: string | null
  readonly checklistItemId: string | null
  readonly orVariantId: string | null
  readonly revisionKind: 'recorded' | 'tombstoned'
  readonly value: TrackingStoredFactValueV1 | null
  readonly recordedByMemberId: string
}

export type TrackingFixedExpectationV1 = {
  readonly fixedExpectationId: string
  readonly componentKind: 'goal' | 'checkpoint' | 'checklist_item'
  readonly componentId: string | null
  readonly state: TrackingExpectationStateV1
  readonly facts: readonly TrackingFactReadV1[]
}

export type TrackingFlexiblePeriodV1 = {
  readonly flexiblePeriodId: string
  readonly periodKind: 'weekly' | 'monthly' | 'weekly_planned_task'
  readonly ordinal: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodTarget: number
  readonly eligibleOnDate: boolean
  readonly expectedProgress: number | null
  readonly actualProgress: CanonicalExactRatio | null
  readonly state: TrackingExpectationStateV1
  readonly facts: readonly TrackingFactReadV1[]
}

export type TrackingDayGoalV1 = {
  readonly planGoalSnapshotId: string
  readonly applicable: boolean
  readonly writable: boolean
  readonly state: TrackingDayStateV1
  readonly coverage: { readonly filled: string; readonly applicable: string }
  readonly progress: GoalProgressResult
  readonly fixedExpectations: readonly TrackingFixedExpectationV1[]
  readonly flexiblePeriods: readonly TrackingFlexiblePeriodV1[]
}

export type TrackingGoalReadV1 = {
  readonly planGoalSnapshotId: string
  readonly sourceGoalSeriesId: string
  readonly title: string
  readonly why: string
  readonly category: string
  readonly displayOrder: number
  readonly config: GoalConfigV1
  readonly calendar: PublicationCalendar
  readonly viewerAccess: TrackingViewerAccessV1
  readonly progress: GoalProgressResult
}

export type TrackingDayReadV1 = {
  readonly localDate: string
  readonly closure: {
    readonly state: 'open' | 'closed'
    readonly dayCloseId: string | null
    readonly revision: bigint | null
    readonly closedAt: Date | null
    readonly closedCount: number | null
  }
  readonly state: TrackingDayStateV1
  readonly coverage: { readonly filled: string; readonly applicable: string }
  readonly goals: readonly TrackingDayGoalV1[]
}

type TrackingReadBaseV1 = {
  readonly queryLocalDate: string
  readonly targetMonth: string
}

export type TrackingNoPlanReadV1 = TrackingReadBaseV1 & {
  readonly state: 'no_plan'
}

export type TrackingDraftReadV1 = TrackingReadBaseV1 & {
  readonly state: 'draft'
  readonly planMonthId: string
  readonly lifecycleRevision: bigint
  readonly draftRevision: bigint
  readonly focus: string
}

export type TrackingPublishedReadV1 = TrackingReadBaseV1 & {
  readonly state: 'published'
  readonly planMonthId: string
  readonly lifecycleRevision: bigint
  readonly factsRevision: bigint
  readonly monthStatus: 'published' | 'grace' | 'closed'
  readonly phase: TrackingMonthPhaseV1
  readonly publicationId: string
  readonly publicationRevision: bigint
  readonly activeLocalDate: string
  readonly latePublication: boolean
  readonly focus: string
  readonly goals: readonly TrackingGoalReadV1[]
  readonly days: readonly TrackingDayReadV1[]
}

export type TrackingMonthStateV1 =
  TrackingNoPlanReadV1 | TrackingDraftReadV1 | TrackingPublishedReadV1

export type TrackingMonthReadModelV1 = TrackingMonthStateV1 & {
  readonly schemaVersion: 'tracking.month.v1'
}

export type TrackingTodayReadModelV1 =
  | (TrackingNoPlanReadV1 & {
      readonly schemaVersion: 'tracking.today.v1'
    })
  | (TrackingDraftReadV1 & {
      readonly schemaVersion: 'tracking.today.v1'
    })
  | (Omit<TrackingPublishedReadV1, 'days'> & {
      readonly schemaVersion: 'tracking.today.v1'
      readonly day: TrackingDayReadV1
    })
