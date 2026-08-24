export type PlanMonthLifecycleStatus =
  'draft' | 'published' | 'grace' | 'closed'

export type PlanMonthLifecycleMode = 'ordinary' | 'reopened'

export interface PlanMonthReadRecord {
  readonly planMonthId: string
  readonly targetMonth: string
  readonly monthStart: string
  readonly status: PlanMonthLifecycleStatus
  readonly mode: PlanMonthLifecycleMode
  readonly revision: string
  readonly factsRevision: string
  readonly draftRevision: string | null
  readonly latestPublication: {
    readonly publicationId: string
    readonly revision: string
    readonly activeLocalDate: string
    readonly isActive: boolean
  } | null
  readonly latestReport: {
    readonly reportRevisionId: string
    readonly revision: string
    readonly status: 'original' | 'revised'
  } | null
}

export interface ListPlanMonthsReadInput {
  readonly spaceId: string
  readonly limit: number
  readonly cursor: {
    readonly targetMonth: string
    readonly planMonthId: string
  } | null
}

export interface ListPlanMonthsReadPort {
  read(input: ListPlanMonthsReadInput): Promise<readonly PlanMonthReadRecord[]>
}

export const LIST_PLAN_MONTHS_READ_PORT: unique symbol = Symbol(
  'LIST_PLAN_MONTHS_READ_PORT',
)
