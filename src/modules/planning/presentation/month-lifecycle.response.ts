import type { DurableCommandResultRef } from '@/shared/application/application-command'

export type PlanMonthMutationResponse = {
  readonly kind: 'planning.plan-month.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export function toPlanMonthMutationResponse(
  value: DurableCommandResultRef<'planning.plan-month.v1'>,
): PlanMonthMutationResponse {
  if (value.aggregateRevision <= 0n) {
    throw new TypeError('Expected positive plan month revision')
  }
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}

export type ReportRevisionMutationResponse = {
  readonly kind: 'planning.report-revision.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export function toReportRevisionMutationResponse(
  value: DurableCommandResultRef<'planning.report-revision.v1'>,
): ReportRevisionMutationResponse {
  if (value.aggregateRevision <= 0n) {
    throw new TypeError('Expected positive report revision')
  }
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}
