import type {
  AggregateMetric,
  CanonicalExactRatio,
  EvaluateGoalProgressInput,
  EvaluationCheckpointSatisfactionV1,
  EvaluationMeasurementV1,
  EvaluationMetric,
  GoalEvaluationFactV1,
  GoalFactValueV1,
} from '@/modules/progress'
import type { ActorRef } from '@/shared/application/application-command'

export const PILOT_REPORT_SCHEMA_VERSION = 'reporting.pilot-report.v1' as const
export const PILOT_REPORT_READ_SCHEMA_VERSION =
  'reporting.pilot-report-read.v1' as const

export type CalculatePilotReportInput = {
  readonly spaceId: string
  readonly publicationId: string
  readonly asOfLocalDate: string
}

export type BuildPilotReportInput = {
  readonly trustedActor: ActorRef
  readonly targetMonth: string
}

export type PilotReportMonthSourceInput = {
  readonly spaceId: string
  readonly targetMonth: string
  readonly asOfLocalDate: string
}

export type PilotReportMonthSourceV1 = {
  readonly source: PilotReportSourceV1
  readonly lifecycleStatus: 'published' | 'grace'
  readonly activeLocalDate: string
}

export type PilotReportFormulaVersionsV1 = {
  readonly calendar: 'planner.calendar-targets.v1'
  readonly evaluation: 'planner.goal-evaluation.v1'
  readonly scoreCoverage: 'planner.score-coverage.v1'
}

export type PilotReportFactTargetV1 =
  | {
      readonly available: true
      readonly kind: 'fixed'
      readonly units: readonly {
        readonly localDate: string
        readonly componentId: string | null
        readonly fact: GoalFactValueV1 | null
        readonly target: {
          readonly measurement: EvaluationMeasurementV1
          readonly satisfaction: EvaluationCheckpointSatisfactionV1 | null
        }
      }[]
    }
  | {
      readonly available: true
      readonly kind: 'flexible'
      readonly periods: readonly {
        readonly periodStart: string
        readonly periodEnd: string
        readonly fact: CanonicalExactRatio
        readonly target: string
      }[]
    }
  | {
      readonly available: true
      readonly kind: 'weekly_planned_task'
      readonly periods: readonly {
        readonly periodStart: string
        readonly periodEnd: string
        readonly fact: 'done' | 'not_done' | 'no_data'
        readonly target: 'done'
      }[]
    }
  | {
      readonly available: true
      readonly kind: 'informational_quantity'
      readonly fact: readonly GoalEvaluationFactV1[]
      readonly measurement: {
        readonly kind: 'quantity'
        readonly mode: 'informational'
        readonly precision: 0 | 1 | 2 | 3
        readonly aggregation: 'add' | 'latest'
        readonly target: null
      }
      readonly target: null
    }
  | {
      readonly available: false
      readonly kind: 'not_applicable'
      readonly fact: null
      readonly target: null
      readonly reason: 'no_applicable_units'
    }

export type PilotReportGoalV1 = {
  readonly planGoalSnapshotId: string
  readonly title: string
  readonly displayOrder: number
  readonly goalScore: EvaluationMetric
  readonly progressPercent: EvaluationMetric
  readonly factTarget: PilotReportFactTargetV1
  readonly coverage: {
    readonly filled: string
    readonly applicable: string
  }
  readonly overperformance: EvaluationMetric
}

export type PilotReportSectionV1 = {
  readonly kind: 'personal' | 'shared'
  readonly ownerMemberId: string | null
  readonly monthScore: AggregateMetric
  readonly coverage: AggregateMetric
  readonly goals: readonly PilotReportGoalV1[]
}

export type PilotReportV1 = {
  readonly schemaVersion: typeof PILOT_REPORT_SCHEMA_VERSION
  readonly source: {
    readonly spaceId: string
    readonly planMonthId: string
    readonly publicationId: string
    readonly publicationRevision: bigint
    readonly factsRevision: bigint
    readonly asOfLocalDate: string
    readonly formulaVersions: PilotReportFormulaVersionsV1
  }
  readonly sections: readonly [
    PilotReportSectionV1,
    PilotReportSectionV1,
    PilotReportSectionV1,
  ]
}

export type PilotReportHeatmapStateV1 =
  'done' | 'not_done' | 'no_data' | 'not_applicable'

export type PilotReportHeatmapPointV1 = {
  readonly localDate: string
  readonly state: PilotReportHeatmapStateV1
}

export type PilotReportSeriesPointV1 = {
  readonly localDate: string
  readonly componentId: string | null
  readonly value: string | number
}

export type PilotReportGoalSeriesV1 = {
  readonly heatmap: readonly PilotReportHeatmapPointV1[]
  readonly cumulativeQuantity: readonly PilotReportSeriesPointV1[] | null
  readonly actualTime: readonly PilotReportSeriesPointV1[] | null
  readonly rating: readonly PilotReportSeriesPointV1[] | null
}

export type PilotReportReadGoalV1 = PilotReportGoalV1 & {
  readonly series: PilotReportGoalSeriesV1
}

export type PilotReportReadSectionV1 = Omit<PilotReportSectionV1, 'goals'> & {
  readonly goals: readonly PilotReportReadGoalV1[]
}

export type PilotReportReadModelV1 = {
  readonly schemaVersion: typeof PILOT_REPORT_READ_SCHEMA_VERSION
  readonly status: 'current' | 'preliminary'
  readonly source: PilotReportV1['source']
  readonly sections: readonly [
    PilotReportReadSectionV1,
    PilotReportReadSectionV1,
    PilotReportReadSectionV1,
  ]
}

export type PilotReportSourceGoalV1 = {
  readonly planGoalSnapshotId: string
  readonly title: string
  readonly displayOrder: number
  readonly scope:
    | { readonly kind: 'personal'; readonly ownerMemberId: string }
    | { readonly kind: 'shared' }
  readonly progressInput: EvaluateGoalProgressInput
}

export type PilotReportSourceV1 = {
  readonly spaceId: string
  readonly planMonthId: string
  readonly publicationId: string
  readonly publicationRevision: bigint
  readonly factsRevision: bigint
  readonly formulaVersions: PilotReportFormulaVersionsV1
  readonly memberIds: readonly [string, string]
  readonly goals: readonly PilotReportSourceGoalV1[]
}
