import {
  isPositiveDecimal,
  type DraftGoalConfigV1,
  type GoalConfigV1,
} from './goal-config'

export type PublishBlockerCode =
  'required' | 'empty_collection' | 'incompatible'
export type PublishBlocker = {
  readonly planGoalId: string
  readonly pointer: string
  readonly code: PublishBlockerCode
  readonly detail: string
}
export type GoalConfigValidationResult =
  | {
      readonly publishable: true
      readonly config: GoalConfigV1
      readonly blockers: readonly []
    }
  | {
      readonly publishable: false
      readonly config: null
      readonly blockers: readonly [PublishBlocker, ...PublishBlocker[]]
    }

type GoalForValidation = {
  readonly planGoalId: string
  readonly displayOrder: number
  readonly config: DraftGoalConfigV1
}

const DETAILS: Readonly<Record<PublishBlockerCode, string>> = Object.freeze({
  required: 'Required value is missing.',
  empty_collection: 'At least one item is required.',
  incompatible: 'Values are incompatible.',
})
const NO_BLOCKERS: readonly [] = Object.freeze([])

function issue(
  planGoalId: string,
  pointer: string,
  code: PublishBlockerCode,
): PublishBlocker {
  return Object.freeze({ planGoalId, pointer, code, detail: DETAILS[code] })
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function measurementIssues(
  planGoalId: string,
  config: DraftGoalConfigV1,
): PublishBlocker[] {
  const result: PublishBlocker[] = []
  const measurement = config.measurement
  switch (measurement.kind) {
    case 'quantity':
      for (const [key, value] of [
        ['aggregation', measurement.aggregation],
        ['mode', measurement.mode],
        ['precision', measurement.precision],
        ['unit', measurement.unit],
      ] as const) {
        if (value === null) {
          result.push(issue(planGoalId, `/measurement/${key}`, 'required'))
        }
      }
      if (measurement.mode === 'targeted') {
        if (measurement.target === null) {
          result.push(issue(planGoalId, '/measurement/target', 'required'))
        } else if (!isPositiveDecimal(measurement.target)) {
          result.push(issue(planGoalId, '/measurement/target', 'incompatible'))
        }
      }
      if (measurement.mode === 'informational' && measurement.target !== null) {
        result.push(issue(planGoalId, '/measurement/target', 'incompatible'))
      }
      break
    case 'actual_time':
      if (measurement.start === null) {
        result.push(issue(planGoalId, '/measurement/start', 'required'))
      }
      if (measurement.end === null) {
        result.push(issue(planGoalId, '/measurement/end', 'required'))
      }
      if (measurement.start !== null && measurement.start === measurement.end) {
        result.push(issue(planGoalId, '/measurement/end', 'incompatible'))
      }
      break
    case 'rating':
      if (measurement.minimum === null) {
        result.push(issue(planGoalId, '/measurement/minimum', 'required'))
      }
      if (measurement.maximum === null) {
        result.push(issue(planGoalId, '/measurement/maximum', 'required'))
      }
      if (
        measurement.minimum !== null &&
        measurement.maximum !== null &&
        measurement.minimum >= measurement.maximum
      ) {
        result.push(issue(planGoalId, '/measurement/maximum', 'incompatible'))
      }
      break
    case 'checklist':
      if (measurement.items.length === 0) {
        result.push(issue(planGoalId, '/measurement/items', 'empty_collection'))
      }
      measurement.items.forEach((item, index) => {
        if (item.label === null) {
          result.push(
            issue(planGoalId, `/measurement/items/${index}/label`, 'required'),
          )
        }
      })
      break
    case 'any_of':
      if (measurement.variants.length === 0) {
        result.push(
          issue(planGoalId, '/measurement/variants', 'empty_collection'),
        )
      }
      measurement.variants.forEach((variant, index) => {
        for (const [key, value] of [
          ['label', variant.label],
          ['precision', variant.precision],
          ['target', variant.target],
          ['unit', variant.unit],
        ] as const) {
          if (value === null) {
            result.push(
              issue(
                planGoalId,
                `/measurement/variants/${index}/${key}`,
                'required',
              ),
            )
          }
        }
        if (variant.target !== null && !isPositiveDecimal(variant.target)) {
          result.push(
            issue(
              planGoalId,
              `/measurement/variants/${index}/target`,
              'incompatible',
            ),
          )
        }
      })
      break
    case 'boolean':
    case 'text':
      break
  }
  return result
}

function repetitionIssues(
  planGoalId: string,
  config: DraftGoalConfigV1,
): PublishBlocker[] {
  const result: PublishBlocker[] = []
  const repetition = config.repetition
  switch (repetition.kind) {
    case 'weekdays':
      if (repetition.weekdays.length === 0) {
        result.push(
          issue(planGoalId, '/repetition/weekdays', 'empty_collection'),
        )
      }
      break
    case 'weekly':
    case 'monthly':
      if (repetition.n === null) {
        result.push(issue(planGoalId, '/repetition/n', 'required'))
      }
      break
    case 'one_off':
      if (repetition.dueDate === null) {
        result.push(issue(planGoalId, '/repetition/dueDate', 'required'))
      }
      break
    case 'weekly_planned_task':
      if (repetition.taskText === null) {
        result.push(issue(planGoalId, '/repetition/taskText', 'required'))
      }
      if (repetition.weekOrdinal === null) {
        result.push(issue(planGoalId, '/repetition/weekOrdinal', 'required'))
      }
      if (config.measurement.kind !== 'boolean') {
        result.push(issue(planGoalId, '/measurement', 'incompatible'))
      }
      break
    case 'daily':
      break
  }
  return result
}

function checkpointIssues(
  planGoalId: string,
  config: DraftGoalConfigV1,
): PublishBlocker[] {
  const checkpoints = config.checkpoints
  if (checkpoints === null) return []
  const result: PublishBlocker[] = []
  if (config.repetition.kind !== 'daily') {
    result.push(issue(planGoalId, '/checkpoints', 'incompatible'))
  }
  if (checkpoints.aggregation === null) {
    result.push(issue(planGoalId, '/checkpoints/aggregation', 'required'))
  }
  if (checkpoints.items.length === 0) {
    result.push(issue(planGoalId, '/checkpoints/items', 'empty_collection'))
  }
  checkpoints.items.forEach((checkpoint, index) => {
    const prefix = `/checkpoints/items/${index}`
    if (checkpoint.name === null) {
      result.push(issue(planGoalId, `${prefix}/name`, 'required'))
    }
    if (checkpoint.deadline === null) {
      result.push(issue(planGoalId, `${prefix}/deadline`, 'required'))
    }
    if (checkpoint.satisfaction.kind !== config.measurement.kind) {
      result.push(issue(planGoalId, `${prefix}/satisfaction`, 'incompatible'))
      return
    }
    if (checkpoint.satisfaction.kind === 'quantity') {
      if (checkpoint.satisfaction.target === null) {
        result.push(
          issue(planGoalId, `${prefix}/satisfaction/target`, 'required'),
        )
      } else if (!isPositiveDecimal(checkpoint.satisfaction.target)) {
        result.push(
          issue(planGoalId, `${prefix}/satisfaction/target`, 'incompatible'),
        )
      }
    }
    if (checkpoint.satisfaction.kind === 'actual_time') {
      if (checkpoint.satisfaction.start === null) {
        result.push(
          issue(planGoalId, `${prefix}/satisfaction/start`, 'required'),
        )
      }
      if (checkpoint.satisfaction.end === null) {
        result.push(issue(planGoalId, `${prefix}/satisfaction/end`, 'required'))
      }
      if (
        checkpoint.satisfaction.start !== null &&
        checkpoint.satisfaction.start === checkpoint.satisfaction.end
      ) {
        result.push(
          issue(planGoalId, `${prefix}/satisfaction/end`, 'incompatible'),
        )
      }
    }
  })
  return result
}

function issues(
  planGoalId: string,
  config: DraftGoalConfigV1,
): PublishBlocker[] {
  const result = [
    ...measurementIssues(planGoalId, config),
    ...repetitionIssues(planGoalId, config),
    ...checkpointIssues(planGoalId, config),
  ]
  if (config.scope.kind === 'personal' && config.scope.ownerMemberId === null) {
    result.push(issue(planGoalId, '/scope/ownerMemberId', 'required'))
  }
  return result
}

export function draftGoalPublishBlockers(
  goals: readonly GoalForValidation[],
): readonly PublishBlocker[] {
  const displayOrder = new Map(
    goals.map((goal) => [goal.planGoalId, goal.displayOrder]),
  )
  return Object.freeze(
    goals
      .flatMap((goal) => issues(goal.planGoalId, goal.config))
      .sort((left, right) => {
        const order =
          (displayOrder.get(left.planGoalId) ?? 0) -
          (displayOrder.get(right.planGoalId) ?? 0)
        return (
          order ||
          compareText(left.planGoalId, right.planGoalId) ||
          compareText(left.pointer, right.pointer) ||
          compareText(left.code, right.code)
        )
      }),
  )
}

export function validateGoalConfig(
  planGoalId: string,
  config: DraftGoalConfigV1,
): GoalConfigValidationResult {
  const blockers = draftGoalPublishBlockers([
    { planGoalId, displayOrder: 0, config },
  ])
  if (blockers.length === 0) {
    return Object.freeze({
      publishable: true,
      config: config as unknown as GoalConfigV1,
      blockers: NO_BLOCKERS,
    })
  }
  return Object.freeze({
    publishable: false,
    config: null,
    blockers: blockers as readonly [PublishBlocker, ...PublishBlocker[]],
  })
}
