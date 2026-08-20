export type ReminderSlotKind = 'morning' | 'day' | 'evening'

export type ReminderContentItem = {
  readonly kind: 'fixed' | 'checkpoint' | 'flexible'
  readonly goalId: string
  readonly componentId: string | null
  readonly title: string
  readonly state: 'pending' | 'partial'
  readonly remaining: string | null
  readonly expectedProgress: number | null
  readonly actualProgress: {
    readonly numerator: string
    readonly denominator: string
  } | null
}

export type ReminderRenderedContent = {
  readonly schemaVersion: 'reminders.rendered-content.v1'
  readonly localDate: string
  readonly slotKind: ReminderSlotKind
  readonly focus: string | null
  readonly items: readonly ReminderContentItem[]
  readonly actions: readonly ['close_day'] | readonly []
}

type ReminderMeasurement =
  | {
      readonly kind: 'quantity'
      readonly mode: 'targeted' | 'informational'
      readonly aggregation: 'add' | 'latest'
      readonly target: string | null
    }
  | { readonly kind: 'actual_time'; readonly end: string }
  | {
      readonly kind: 'boolean' | 'rating' | 'text' | 'checklist' | 'any_of'
    }

type ReminderGoal = {
  readonly planGoalSnapshotId: string
  readonly title: string
  readonly viewerAccess: 'personal_owner' | 'shared' | 'partner_read_only'
  readonly config: {
    readonly measurement: ReminderMeasurement
    readonly checkpoints: {
      readonly items: readonly {
        readonly checkpointId: string
        readonly deadline: string
        readonly satisfaction:
          | { readonly kind: 'quantity'; readonly target: string }
          | {
              readonly kind:
                | 'boolean'
                | 'actual_time'
                | 'rating'
                | 'text'
                | 'checklist'
                | 'any_of'
            }
      }[]
    } | null
  }
}

type ReminderFact = {
  readonly value: {
    readonly kind: string
    readonly value?: unknown
  } | null
}

type ReminderFixedExpectation = {
  readonly componentKind: 'goal' | 'checkpoint' | 'checklist_item'
  readonly componentId: string | null
  readonly state: 'no_data' | 'partial' | 'done' | 'not_done'
  readonly facts: readonly ReminderFact[]
}

type ReminderFlexiblePeriod = {
  readonly flexiblePeriodId: string
  readonly periodKind: 'weekly' | 'monthly' | 'weekly_planned_task'
  readonly eligibleOnDate: boolean
  readonly expectedProgress: number | null
  readonly actualProgress: {
    readonly numerator: string
    readonly denominator: string
  } | null
  readonly state: 'no_data' | 'partial' | 'done' | 'not_done'
}

type ReminderDayGoal = {
  readonly planGoalSnapshotId: string
  readonly applicable: boolean
  readonly fixedExpectations: readonly ReminderFixedExpectation[]
  readonly flexiblePeriods: readonly ReminderFlexiblePeriod[]
}

export type ReminderRelevanceRead =
  | {
      readonly state: 'published'
      readonly phase: 'future' | 'active' | 'grace' | 'closed'
      readonly monthStatus: 'published' | 'grace' | 'closed'
      readonly activeLocalDate: string
      readonly focus: string
      readonly goals: readonly ReminderGoal[]
      readonly day: {
        readonly localDate: string
        readonly goals: readonly ReminderDayGoal[]
      }
    }
  | { readonly state: 'no_plan' | 'draft'; readonly activeLocalDate?: string }

type PolicyInput = {
  readonly read: ReminderRelevanceRead
  readonly localDate: string
  readonly localTime: string
  readonly slotKind: ReminderSlotKind
}

type Decimal = { readonly coefficient: bigint; readonly scale: number }

function decimal(value: string): Decimal {
  const [whole = '0', fraction = ''] = value.split('.')
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  }
}

function decimalString(value: Decimal): string {
  const sign = value.coefficient < 0n ? '-' : ''
  const digits = (
    value.coefficient < 0n ? -value.coefficient : value.coefficient
  )
    .toString()
    .padStart(value.scale + 1, '0')
  if (value.scale === 0) return `${sign}${digits}`
  const point = digits.length - value.scale
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`.replace(
    /(?:\.0+|(?<=\.[0-9]+)0+)$/u,
    '',
  )
}

function decimalSub(left: string, right: string): string {
  const a = decimal(left)
  const b = decimal(right)
  const scale = Math.max(a.scale, b.scale)
  const coefficient =
    a.coefficient * 10n ** BigInt(scale - a.scale) -
    b.coefficient * 10n ** BigInt(scale - b.scale)
  return decimalString({ coefficient, scale })
}

function decimalIsNonPositive(value: string): boolean {
  return decimal(value).coefficient <= 0n
}

function decimalAdd(values: readonly string[]): string {
  if (values.length === 0) return '0'
  const parsed = values.map(decimal)
  const scale = Math.max(...parsed.map((value) => value.scale))
  const coefficient = parsed.reduce(
    (total, value) =>
      total + value.coefficient * 10n ** BigInt(scale - value.scale),
    0n,
  )
  return decimalString({ coefficient, scale })
}

function quantityFromFacts(
  expectation: ReminderFixedExpectation,
  measurement: Extract<ReminderMeasurement, { readonly kind: 'quantity' }>,
): string | null {
  const values = expectation.facts.flatMap((fact) =>
    fact.value?.kind === 'quantity' && typeof fact.value.value === 'string'
      ? [fact.value.value]
      : [],
  )
  if (values.length === 0) return null
  return measurement.aggregation === 'add'
    ? decimalAdd(values)
    : values[values.length - 1]!
}

function isVisibleGoal(
  goal: ReminderDayGoal,
  viewerAccess: ReminderGoal['viewerAccess'],
): boolean {
  return (
    goal.applicable &&
    (viewerAccess === 'personal_owner' || viewerAccess === 'shared')
  )
}

function checkpointDue(
  goal: ReminderGoal,
  expectation: ReminderFixedExpectation,
  localTime: string,
  slotKind: ReminderSlotKind,
): boolean {
  if (slotKind !== 'day') return true
  if (expectation.componentKind === 'checkpoint') {
    const deadline = goal.config.checkpoints?.items.find(
      (item) => item.checkpointId === expectation.componentId,
    )?.deadline
    return deadline !== undefined && deadline <= localTime
  }
  return (
    goal.config.measurement.kind === 'actual_time' &&
    goal.config.measurement.end <= localTime
  )
}

function fixedItem(
  goal: ReminderGoal,
  expectation: ReminderFixedExpectation,
): ReminderContentItem | null {
  if (expectation.state !== 'no_data' && expectation.state !== 'partial') {
    return null
  }
  const measurement = goal.config.measurement
  if (measurement.kind === 'quantity' && measurement.mode === 'informational') {
    return null
  }
  let remaining: string | null = null
  const checkpointSatisfaction =
    expectation.componentKind === 'checkpoint'
      ? goal.config.checkpoints?.items.find(
          (item) => item.checkpointId === expectation.componentId,
        )?.satisfaction
      : undefined
  const target =
    checkpointSatisfaction?.kind === 'quantity'
      ? checkpointSatisfaction.target
      : measurement.kind === 'quantity' && measurement.mode === 'targeted'
        ? measurement.target
        : null
  const quantityMeasurement =
    measurement.kind === 'quantity' ? measurement : null
  if (target !== null && quantityMeasurement !== null) {
    const actual = quantityFromFacts(expectation, quantityMeasurement)
    remaining = actual === null ? target : decimalSub(target, actual)
    if (decimalIsNonPositive(remaining)) return null
  }
  return {
    kind: expectation.componentKind === 'checkpoint' ? 'checkpoint' : 'fixed',
    goalId: goal.planGoalSnapshotId,
    componentId: expectation.componentId,
    title: goal.title,
    state: expectation.state === 'partial' ? 'partial' : 'pending',
    remaining,
    expectedProgress: null,
    actualProgress: null,
  }
}

function flexibleItem(
  goal: ReminderGoal,
  period: ReminderFlexiblePeriod,
): ReminderContentItem | null {
  if (
    !period.eligibleOnDate ||
    period.periodKind === 'weekly_planned_task' ||
    (period.state !== 'no_data' && period.state !== 'partial')
  ) {
    return null
  }
  if (period.expectedProgress !== null && period.actualProgress !== null) {
    const expected = decimal(String(period.expectedProgress))
    const actual = period.actualProgress
    const expectedCoefficient =
      expected.coefficient * BigInt(actual.denominator)
    const actualCoefficient =
      BigInt(actual.numerator) * 10n ** BigInt(expected.scale)
    if (actualCoefficient >= expectedCoefficient) return null
  }
  return {
    kind: 'flexible',
    goalId: goal.planGoalSnapshotId,
    componentId: period.flexiblePeriodId,
    title: goal.title,
    state: period.state === 'partial' ? 'partial' : 'pending',
    remaining: null,
    expectedProgress: period.expectedProgress,
    actualProgress: period.actualProgress,
  }
}

export function buildReminderContent(
  input: PolicyInput,
): ReminderRenderedContent | null {
  const { read, localDate, localTime, slotKind } = input
  if (
    read.state !== 'published' ||
    read.phase !== 'active' ||
    read.monthStatus !== 'published' ||
    read.activeLocalDate > localDate ||
    read.day.localDate !== localDate
  ) {
    return null
  }
  const items: ReminderContentItem[] = []
  for (const goal of read.goals) {
    const dayGoal = read.day.goals.find(
      (candidate) => candidate.planGoalSnapshotId === goal.planGoalSnapshotId,
    )
    if (dayGoal === undefined || !isVisibleGoal(dayGoal, goal.viewerAccess)) {
      continue
    }
    for (const expectation of dayGoal.fixedExpectations) {
      if (!checkpointDue(goal, expectation, localTime, slotKind)) continue
      const item = fixedItem(goal, expectation)
      if (item !== null) items.push(item)
    }
    for (const period of dayGoal.flexiblePeriods) {
      const item = flexibleItem(goal, period)
      if (item !== null) items.push(item)
    }
  }
  items.sort((left, right) =>
    `${left.goalId}:${left.componentId ?? ''}`.localeCompare(
      `${right.goalId}:${right.componentId ?? ''}`,
    ),
  )
  if (items.length === 0) return null
  return Object.freeze({
    schemaVersion: 'reminders.rendered-content.v1' as const,
    localDate,
    slotKind,
    focus: slotKind === 'morning' ? read.focus : null,
    items: Object.freeze(items),
    actions: slotKind === 'evening' ? (['close_day'] as const) : ([] as const),
  })
}
