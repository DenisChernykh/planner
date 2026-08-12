import type { DurableCommandResultRef } from '@/shared/application/application-command'

import type {
  DraftEditorView,
  DraftGoalView,
} from '../application/draft-goal.types'

export type DraftGoalResponse = Omit<DraftGoalView, 'configRevision'> & {
  readonly configRevision: string
}
export type DraftEditorResponse = Omit<
  DraftEditorView,
  'planMonthRevision' | 'draftRevision' | 'goals'
> & {
  readonly planMonthRevision: string
  readonly draftRevision: string
  readonly goals: readonly DraftGoalResponse[]
}
export type DraftMutationResponse = {
  readonly kind: 'planning.plan-draft.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

function positive(value: bigint): string {
  if (value <= 0n) throw new TypeError('Expected positive bigint')
  return value.toString(10)
}

export function toDraftMutationResponse(
  value: DurableCommandResultRef<'planning.plan-draft.v1'>,
): DraftMutationResponse {
  return {
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: positive(value.aggregateRevision),
  }
}

export function toDraftEditorResponse(
  value: DraftEditorView,
): DraftEditorResponse {
  return {
    planMonthId: value.planMonthId,
    spaceId: value.spaceId,
    targetMonth: value.targetMonth,
    status: value.status,
    focus: value.focus,
    planMonthRevision: positive(value.planMonthRevision),
    draftRevision: positive(value.draftRevision),
    goals: value.goals.map((goal) => ({
      ...goal,
      configRevision: positive(goal.configRevision),
    })),
    blockers: value.blockers,
  }
}
