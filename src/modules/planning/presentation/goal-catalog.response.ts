import type { DurableCommandResultRef } from '@/shared/application/application-command'

import type {
  GoalDefinitionDetail,
  GoalDefinitionSummary,
  GoalDefinitionVersionView,
} from '../application/goal-catalog.types'

export type GoalDefinitionVersionResponse = Omit<
  GoalDefinitionVersionView,
  'versionNumber'
> & { readonly versionNumber: string }
export type GoalDefinitionSummaryResponse = Omit<
  GoalDefinitionSummary,
  'revision' | 'currentVersion'
> & {
  readonly revision: string
  readonly currentVersion: GoalDefinitionVersionResponse
}
export type GoalDefinitionDetailResponse = GoalDefinitionSummaryResponse & {
  readonly versions: readonly GoalDefinitionVersionResponse[]
}
export type GoalDefinitionResultResponse = {
  readonly kind: 'planning.goal-definition.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

function positiveDecimal(value: bigint): string {
  if (value <= 0n) throw new TypeError('Expected a positive bigint')
  return value.toString(10)
}

function version(
  value: GoalDefinitionVersionView,
): GoalDefinitionVersionResponse {
  return { ...value, versionNumber: positiveDecimal(value.versionNumber) }
}

export function toGoalDefinitionResultResponse(
  value: DurableCommandResultRef<'planning.goal-definition.v1'>,
): GoalDefinitionResultResponse {
  return {
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: positiveDecimal(value.aggregateRevision),
  }
}

export function toGoalDefinitionSummaryResponse(
  value: GoalDefinitionSummary,
): GoalDefinitionSummaryResponse {
  return {
    goalDefinitionId: value.goalDefinitionId,
    state: value.state,
    revision: positiveDecimal(value.revision),
    currentVersion: version(value.currentVersion),
  }
}

export function toGoalDefinitionDetailResponse(
  value: GoalDefinitionDetail,
): GoalDefinitionDetailResponse {
  return {
    ...toGoalDefinitionSummaryResponse(value),
    versions: value.versions.map(version),
  }
}
