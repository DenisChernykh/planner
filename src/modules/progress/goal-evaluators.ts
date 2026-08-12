import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  CalendarTargetsInputError,
  calculateEligibleCalendar,
  type CalendarTargetsInput,
  type EligibleCalendarResult,
} from './calendar-targets'
import {
  INTERNAL_ONE,
  INTERNAL_ZERO,
  InternalExactWorkLimitError,
  internalAddInteger,
  internalAddRational,
  internalAvailableMetric,
  internalCapOne,
  internalChargeExactInputDigits,
  internalChargeExactTerms,
  internalCompareRational,
  internalCreateExactWorkLedger,
  internalDivideRational,
  internalDivideRationalBySmall,
  internalFreezeData,
  internalPublicRatio,
  internalRational,
  internalSubtractRational,
  type CanonicalExactRatio,
  type InternalExactWorkLedger,
  type InternalRational,
  type ScoreCoverageContributionV1,
} from './score-coverage'

export const GOAL_EVALUATION_FORMULA_VERSION =
  'planner.goal-evaluation.v1' as const

export type EvaluationMeasurementV1 =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'quantity'
      readonly mode: 'targeted' | 'informational'
      readonly precision: 0 | 1 | 2 | 3
      readonly aggregation: 'add' | 'latest'
      readonly target: string | null
    }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | {
      readonly kind: 'rating'
      readonly minimum: number
      readonly maximum: number
    }
  | { readonly kind: 'text' }
  | {
      readonly kind: 'checklist'
      readonly items: readonly [
        { readonly itemId: string },
        ...{ readonly itemId: string }[],
      ]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly [
        {
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        },
        ...{
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        }[],
      ]
    }

export type EvaluationCheckpointSatisfactionV1 =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'quantity'; readonly target: string }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | { readonly kind: 'rating' }
  | { readonly kind: 'text' }
  | { readonly kind: 'checklist' }
  | { readonly kind: 'any_of' }

export interface EvaluationCheckpointV1 {
  readonly checkpointId: string
  readonly satisfaction: EvaluationCheckpointSatisfactionV1
}

export interface GoalEvaluationSnapshotV1 {
  readonly schemaVersion: 'planner.goal-evaluation-snapshot.v1'
  readonly measurement: EvaluationMeasurementV1
  readonly checkpoints: {
    readonly aggregation: 'independent' | 'all'
    readonly items: readonly [
      EvaluationCheckpointV1,
      ...EvaluationCheckpointV1[],
    ]
  } | null
}

export type GoalFactValueV1 =
  | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
  | { readonly kind: 'not_done' }
  | {
      readonly kind: 'quantity_add'
      readonly contributions: readonly [
        { readonly contributionId: string; readonly value: string },
        ...{ readonly contributionId: string; readonly value: string }[],
      ]
    }
  | { readonly kind: 'quantity_latest'; readonly value: string }
  | { readonly kind: 'actual_time'; readonly value: string }
  | { readonly kind: 'rating'; readonly value: number }
  | {
      readonly kind: 'text'
      readonly text: string
      readonly result: 'done' | 'not_done'
    }
  | {
      readonly kind: 'checklist'
      readonly items: readonly {
        readonly itemId: string
        readonly state: 'done' | 'not_done'
      }[]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly {
        readonly variantId: string
        readonly value: string
      }[]
    }

export type GoalEvaluationFactV1 =
  | {
      readonly kind: 'fixed'
      readonly expectationDate: string
      readonly value: GoalFactValueV1
    }
  | {
      readonly kind: 'fixed_checkpoints'
      readonly expectationDate: string
      readonly checkpoints: readonly {
        readonly checkpointId: string
        readonly value: GoalFactValueV1
      }[]
    }
  | {
      readonly kind: 'quota_occurrence'
      readonly localDate: string
      readonly value: GoalFactValueV1
    }
  | {
      readonly kind: 'weekly_planned_task'
      readonly periodStart: string
      readonly periodEnd: string
      readonly result: 'done' | 'not_done'
    }

export type SuccessfulEligibleCalendarResult = Extract<
  EligibleCalendarResult,
  { readonly eligible: true }
>

export interface EvaluateGoalProgressInput {
  readonly snapshot: GoalEvaluationSnapshotV1
  readonly calendarInput: CalendarTargetsInput
  readonly calendar: SuccessfulEligibleCalendarResult
  readonly facts: readonly GoalEvaluationFactV1[]
  readonly asOfLocalDate: string
}

export type EvaluationMetric =
  | {
      readonly available: true
      readonly exact: CanonicalExactRatio
      readonly basisPoints: string
    }
  | {
      readonly available: false
      readonly exact: null
      readonly basisPoints: null
      readonly reason: 'informational' | 'no_applicable_units'
    }

export interface FlexiblePeriodEvaluationV1 {
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodTarget: string
  readonly actualEquivalentOccurrences: CanonicalExactRatio
  readonly creditedOccurrences: CanonicalExactRatio
  readonly overperformanceOccurrences: CanonicalExactRatio
}

export interface GoalProgressResult {
  readonly formulaVersions: {
    readonly calendar: typeof CALENDAR_TARGETS_FORMULA_VERSION
    readonly evaluation: typeof GOAL_EVALUATION_FORMULA_VERSION
  }
  readonly progress: EvaluationMetric
  readonly score: EvaluationMetric
  readonly overperformance: EvaluationMetric
  readonly coverage: {
    readonly filled: string
    readonly applicable: string
  }
  readonly contribution: ScoreCoverageContributionV1
  readonly periods: readonly FlexiblePeriodEvaluationV1[]
}

export type GoalEvaluationInputIssueCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'unexpected_property'
  | 'incompatible'
  | 'input_too_complex'

export type GoalEvaluationInputIssuePointer =
  | ''
  | '/snapshot'
  | '/snapshot/measurement'
  | '/snapshot/checkpoints'
  | '/calendarInput'
  | '/calendar'
  | '/facts'
  | `/facts/${number}`
  | `/facts/${number}/expectationDate`
  | `/facts/${number}/localDate`
  | `/facts/${number}/periodStart`
  | `/facts/${number}/periodEnd`
  | `/facts/${number}/checkpointId`
  | `/facts/${number}/value`
  | `/facts/${number}/checkpoints`
  | '/asOfLocalDate'

export type GoalEvaluationInputIssueDetail =
  | 'expected a plain object'
  | 'expected exact properties'
  | 'expected a dense plain array'
  | 'expected the goal evaluation snapshot schema'
  | 'expected a supported measurement kind'
  | 'expected a supported fact kind'
  | 'expected a canonical decimal'
  | 'expected a canonical positive decimal'
  | 'expected a canonical local date'
  | 'expected a canonical local time'
  | 'expected a safe integer'
  | 'expected a nonempty string'
  | 'expected unique component identities'
  | 'expected a successful canonical P04 calendar'
  | 'expected fact kind to match calendar and snapshot'
  | 'expected fact identity inside entered calendar as-of'
  | 'expected fact value to match measurement'
  | 'expected checkpoint kind to match measurement'
  | 'expected exact work within budget'

export interface GoalEvaluationInputIssue {
  readonly pointer: GoalEvaluationInputIssuePointer
  readonly code: GoalEvaluationInputIssueCode
  readonly detail: GoalEvaluationInputIssueDetail
}

export class GoalEvaluationInputError extends Error {
  readonly issues: readonly [
    GoalEvaluationInputIssue,
    ...GoalEvaluationInputIssue[],
  ]

  constructor(
    issues: readonly [GoalEvaluationInputIssue, ...GoalEvaluationInputIssue[]],
  ) {
    super('Invalid goal evaluation input')
    this.name = 'GoalEvaluationInputError'
    this.issues = internalFreezeData(
      issues.map((issue) => ({ ...issue })),
    ) as unknown as readonly [
      GoalEvaluationInputIssue,
      ...GoalEvaluationInputIssue[],
    ]
    Object.freeze(this)
  }
}

type PlainObject = Record<PropertyKey, unknown>
type ParsedCalendar = SuccessfulEligibleCalendarResult
type ParsedFixedFact = Extract<GoalEvaluationFactV1, { kind: 'fixed' }>
type ParsedCheckpointFact = Extract<
  GoalEvaluationFactV1,
  { kind: 'fixed_checkpoints' }
>
type ParsedQuotaFact = Extract<
  GoalEvaluationFactV1,
  { kind: 'quota_occurrence' }
>
type ParsedWeeklyFact = Extract<
  GoalEvaluationFactV1,
  { kind: 'weekly_planned_task' }
>

interface ValueEvaluation {
  readonly raw: InternalRational
  readonly filled: boolean
  readonly fullyFilled: boolean
  readonly satisfied: boolean
  readonly coverageFilled: number
  readonly coverageApplicable: number
}

function failInput(
  pointer: GoalEvaluationInputIssuePointer,
  code: GoalEvaluationInputIssueCode,
  detail: GoalEvaluationInputIssueDetail,
): never {
  throw new GoalEvaluationInputError([{ pointer, code, detail }])
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  pointer: GoalEvaluationInputIssuePointer,
): asserts value is PlainObject {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    failInput(pointer, 'unexpected_property', 'expected exact properties')
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a plain object')
    }
  }
}

function ownValue(value: PlainObject, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined
}

function denseArray(
  value: unknown,
  pointer: GoalEvaluationInputIssuePointer,
  allowEmpty = true,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    failInput(pointer, 'invalid_type', 'expected a dense plain array')
  }
  const expected = new Set<PropertyKey>(['length'])
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index))
  }
  const keys = Reflect.ownKeys(value)
  if (
    (!allowEmpty && value.length === 0) ||
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    failInput(pointer, 'invalid_type', 'expected a dense plain array')
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a dense plain array')
    }
  }
  return value
}

function preflightExactArrays(
  value: unknown,
  ledger: InternalExactWorkLedger,
  ancestors: Set<object> = new Set(),
  depth = 0,
): void {
  if (depth > 16 || value === null || typeof value !== 'object') return
  if (ancestors.has(value)) return
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return
      const length: number = value.length
      if (!Number.isSafeInteger(length) || length < 0) return
      internalChargeExactTerms(ledger, length)
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor !== undefined && 'value' in descriptor) {
          preflightExactArrays(descriptor.value, ledger, ancestors, depth + 1)
        }
      }
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor) {
        preflightExactArrays(descriptor.value, ledger, ancestors, depth + 1)
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

function samePlainData(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => samePlainData(item, right[index]))
    )
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        samePlainData(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  )
}

function nonemptyString(
  value: unknown,
  pointer: GoalEvaluationInputIssuePointer,
): string {
  if (typeof value !== 'string' || !/\S/u.test(value)) {
    failInput(pointer, 'invalid_value', 'expected a nonempty string')
  }
  return value
}

function decimal(
  value: unknown,
  precision: number,
  positive: boolean,
  pointer: GoalEvaluationInputIssuePointer,
): string {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value) ||
    (value.includes('.') ? value.length - value.indexOf('.') - 1 : 0) >
      precision ||
    (positive && !/[1-9]/u.test(value.replace('.', '')))
  ) {
    failInput(
      pointer,
      'invalid_value',
      positive
        ? 'expected a canonical positive decimal'
        : 'expected a canonical decimal',
    )
  }
  return value
}

function decimalInteger(value: string, precision: number): string {
  const dot = value.indexOf('.')
  const whole = dot === -1 ? value : value.slice(0, dot)
  const fraction = dot === -1 ? '' : value.slice(dot + 1)
  const digits = `${whole}${fraction}${'0'.repeat(precision - fraction.length)}`
  let index = 0
  while (index < digits.length - 1 && digits.charCodeAt(index) === 48)
    index += 1
  return digits.slice(index)
}

function canonicalTime(
  value: unknown,
  pointer: GoalEvaluationInputIssuePointer,
): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value)
  ) {
    failInput(pointer, 'invalid_value', 'expected a canonical local time')
  }
  return value
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function datesInMonth(targetMonth: string): readonly string[] {
  const year = Number(targetMonth.slice(0, 4))
  const month = Number(targetMonth.slice(5, 7))
  return Array.from({ length: daysInMonth(year, month) }, (_, index) =>
    formatDate(year, month, index + 1),
  )
}

function daysBeforeMonth(year: number, month: number): number {
  let result = 0
  for (let current = 1; current < month; current += 1) {
    result += daysInMonth(year, current)
  }
  return result
}

function firstWeekdayIndex(targetMonth: string): number {
  const year = Number(targetMonth.slice(0, 4))
  const month = Number(targetMonth.slice(5, 7))
  const previousYears = year - 1
  const daysBeforeYear =
    previousYears * 365 +
    Math.floor(previousYears / 4) -
    Math.floor(previousYears / 100) +
    Math.floor(previousYears / 400)
  return (daysBeforeYear + daysBeforeMonth(year, month)) % 7
}

interface CanonicalWeekSegment {
  readonly ordinal: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly dates: readonly string[]
}

function weekSegments(targetMonth: string): readonly CanonicalWeekSegment[] {
  const monthDates = datesInMonth(targetMonth)
  const result: CanonicalWeekSegment[] = []
  let firstDay = 1
  let ordinal = 1
  while (firstDay <= monthDates.length) {
    const segmentLength =
      firstDay === 1
        ? Math.min(7 - firstWeekdayIndex(targetMonth), monthDates.length)
        : 7
    const lastDay = Math.min(firstDay + segmentLength - 1, monthDates.length)
    result.push({
      ordinal,
      periodStart: monthDates[firstDay - 1]!,
      periodEnd: monthDates[lastDay - 1]!,
      dates: monthDates.slice(firstDay - 1, lastDay),
    })
    firstDay = lastDay + 1
    ordinal += 1
  }
  return result
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function canonicalDate(
  value: unknown,
  pointer: GoalEvaluationInputIssuePointer,
): string {
  if (typeof value !== 'string') {
    failInput(pointer, 'invalid_type', 'expected a canonical local date')
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (match === null) {
    failInput(pointer, 'invalid_value', 'expected a canonical local date')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (
    year < 1 ||
    year > 9_999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    failInput(pointer, 'invalid_value', 'expected a canonical local date')
  }
  return value
}

function uniqueStrings(
  values: readonly string[],
  pointer: GoalEvaluationInputIssuePointer,
): void {
  if (new Set(values).size !== values.length) {
    failInput(pointer, 'incompatible', 'expected unique component identities')
  }
}

function readMeasurement(value: unknown): EvaluationMeasurementV1 {
  const pointer = '/snapshot/measurement' as const
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
    failInput(pointer, 'invalid_type', 'expected a supported measurement kind')
  }
  const kind: unknown = kindDescriptor.value as unknown
  if (kind === 'boolean' || kind === 'text') {
    assertExactObject(value, ['kind'], pointer)
    return { kind }
  }
  if (kind === 'quantity') {
    assertExactObject(
      value,
      ['kind', 'mode', 'precision', 'aggregation', 'target'],
      pointer,
    )
    const mode = ownValue(value, 'mode')
    const precision = ownValue(value, 'precision')
    const aggregation = ownValue(value, 'aggregation')
    const target = ownValue(value, 'target')
    if (mode !== 'targeted' && mode !== 'informational') {
      failInput(
        pointer,
        'invalid_value',
        'expected a supported measurement kind',
      )
    }
    if (![0, 1, 2, 3].includes(precision as number)) {
      failInput(pointer, 'invalid_value', 'expected a canonical decimal')
    }
    if (aggregation !== 'add' && aggregation !== 'latest') {
      failInput(
        pointer,
        'invalid_value',
        'expected a supported measurement kind',
      )
    }
    if (mode === 'informational') {
      if (target !== null) {
        failInput(
          pointer,
          'incompatible',
          'expected fact value to match measurement',
        )
      }
      return {
        kind,
        mode,
        precision: precision as 0 | 1 | 2 | 3,
        aggregation,
        target: null,
      }
    }
    return {
      kind,
      mode,
      precision: precision as 0 | 1 | 2 | 3,
      aggregation,
      target: decimal(target, precision as number, true, pointer),
    }
  }
  if (kind === 'actual_time') {
    assertExactObject(value, ['kind', 'start', 'end'], pointer)
    const start = canonicalTime(ownValue(value, 'start'), pointer)
    const end = canonicalTime(ownValue(value, 'end'), pointer)
    if (start === end) {
      failInput(
        pointer,
        'incompatible',
        'expected fact value to match measurement',
      )
    }
    return { kind, start, end }
  }
  if (kind === 'rating') {
    assertExactObject(value, ['kind', 'minimum', 'maximum'], pointer)
    const minimum = ownValue(value, 'minimum')
    const maximum = ownValue(value, 'maximum')
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      (minimum as number) >= (maximum as number)
    ) {
      failInput(pointer, 'invalid_value', 'expected a safe integer')
    }
    return { kind, minimum: minimum as number, maximum: maximum as number }
  }
  if (kind === 'checklist') {
    assertExactObject(value, ['kind', 'items'], pointer)
    const items = denseArray(ownValue(value, 'items'), pointer, false).map(
      (item) => {
        assertExactObject(item, ['itemId'], pointer)
        return { itemId: nonemptyString(ownValue(item, 'itemId'), pointer) }
      },
    )
    uniqueStrings(
      items.map((item) => item.itemId),
      pointer,
    )
    return {
      kind,
      items: items as [
        { readonly itemId: string },
        ...{ readonly itemId: string }[],
      ],
    }
  }
  if (kind === 'any_of') {
    assertExactObject(value, ['kind', 'variants'], pointer)
    const variants = denseArray(
      ownValue(value, 'variants'),
      pointer,
      false,
    ).map((variant) => {
      assertExactObject(variant, ['variantId', 'precision', 'target'], pointer)
      const precision = ownValue(variant, 'precision')
      if (![0, 1, 2, 3].includes(precision as number)) {
        failInput(pointer, 'invalid_value', 'expected a canonical decimal')
      }
      return {
        variantId: nonemptyString(ownValue(variant, 'variantId'), pointer),
        precision: precision as 0 | 1 | 2 | 3,
        target: decimal(
          ownValue(variant, 'target'),
          precision as number,
          true,
          pointer,
        ),
      }
    })
    uniqueStrings(
      variants.map((variant) => variant.variantId),
      pointer,
    )
    return {
      kind,
      variants: variants as [
        {
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        },
        ...{
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        }[],
      ],
    }
  }
  failInput(pointer, 'invalid_value', 'expected a supported measurement kind')
}

function readSatisfaction(
  value: unknown,
  measurement: EvaluationMeasurementV1,
): EvaluationCheckpointSatisfactionV1 {
  const pointer = '/snapshot/checkpoints' as const
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (descriptor === undefined || !('value' in descriptor)) {
    failInput(
      pointer,
      'invalid_type',
      'expected checkpoint kind to match measurement',
    )
  }
  const kind: unknown = descriptor.value as unknown
  if (kind !== measurement.kind) {
    failInput(
      pointer,
      'incompatible',
      'expected checkpoint kind to match measurement',
    )
  }
  if (
    kind === 'boolean' ||
    kind === 'rating' ||
    kind === 'text' ||
    kind === 'checklist' ||
    kind === 'any_of'
  ) {
    assertExactObject(value, ['kind'], pointer)
    return { kind }
  }
  if (kind === 'quantity' && measurement.kind === 'quantity') {
    assertExactObject(value, ['kind', 'target'], pointer)
    return {
      kind,
      target: decimal(
        ownValue(value, 'target'),
        measurement.precision,
        true,
        pointer,
      ),
    }
  }
  if (kind === 'actual_time') {
    assertExactObject(value, ['kind', 'start', 'end'], pointer)
    const start = canonicalTime(ownValue(value, 'start'), pointer)
    const end = canonicalTime(ownValue(value, 'end'), pointer)
    if (start === end) {
      failInput(
        pointer,
        'incompatible',
        'expected checkpoint kind to match measurement',
      )
    }
    return { kind, start, end }
  }
  failInput(
    pointer,
    'incompatible',
    'expected checkpoint kind to match measurement',
  )
}

function readSnapshot(value: unknown): GoalEvaluationSnapshotV1 {
  const pointer = '/snapshot' as const
  assertExactObject(
    value,
    ['schemaVersion', 'measurement', 'checkpoints'],
    pointer,
  )
  if (
    ownValue(value, 'schemaVersion') !== 'planner.goal-evaluation-snapshot.v1'
  ) {
    failInput(
      pointer,
      'invalid_value',
      'expected the goal evaluation snapshot schema',
    )
  }
  const measurement = readMeasurement(ownValue(value, 'measurement'))
  const checkpointsValue = ownValue(value, 'checkpoints')
  if (checkpointsValue === null) {
    return {
      schemaVersion: 'planner.goal-evaluation-snapshot.v1',
      measurement,
      checkpoints: null,
    }
  }
  const checkpointPointer = '/snapshot/checkpoints' as const
  assertExactObject(
    checkpointsValue,
    ['aggregation', 'items'],
    checkpointPointer,
  )
  const aggregation = ownValue(checkpointsValue, 'aggregation')
  if (aggregation !== 'independent' && aggregation !== 'all') {
    failInput(
      checkpointPointer,
      'invalid_value',
      'expected checkpoint kind to match measurement',
    )
  }
  const items = denseArray(
    ownValue(checkpointsValue, 'items'),
    checkpointPointer,
    false,
  ).map((item) => {
    assertExactObject(item, ['checkpointId', 'satisfaction'], checkpointPointer)
    return {
      checkpointId: nonemptyString(
        ownValue(item, 'checkpointId'),
        checkpointPointer,
      ),
      satisfaction: readSatisfaction(
        ownValue(item, 'satisfaction'),
        measurement,
      ),
    }
  })
  uniqueStrings(
    items.map((item) => item.checkpointId),
    checkpointPointer,
  )
  const measurementComponentIds = new Set(
    measurement.kind === 'checklist'
      ? measurement.items.map((item) => item.itemId)
      : measurement.kind === 'any_of'
        ? measurement.variants.map((variant) => variant.variantId)
        : [],
  )
  if (items.some((item) => measurementComponentIds.has(item.checkpointId))) {
    failInput(
      checkpointPointer,
      'incompatible',
      'expected unique component identities',
    )
  }
  return {
    schemaVersion: 'planner.goal-evaluation-snapshot.v1',
    measurement,
    checkpoints: {
      aggregation,
      items: items as [EvaluationCheckpointV1, ...EvaluationCheckpointV1[]],
    },
  }
}

function readCalendar(value: unknown): ParsedCalendar {
  const pointer = '/calendar' as const
  assertExactObject(
    value,
    ['formulaVersion', 'eligible', 'calendar', 'issues'],
    pointer,
  )
  if (
    ownValue(value, 'formulaVersion') !== CALENDAR_TARGETS_FORMULA_VERSION ||
    ownValue(value, 'eligible') !== true ||
    denseArray(ownValue(value, 'issues'), pointer).length !== 0
  ) {
    failInput(
      pointer,
      'incompatible',
      'expected a successful canonical P04 calendar',
    )
  }
  const calendar = ownValue(value, 'calendar')
  if (
    calendar === null ||
    typeof calendar !== 'object' ||
    Array.isArray(calendar)
  ) {
    failInput(
      pointer,
      'invalid_type',
      'expected a successful canonical P04 calendar',
    )
  }
  const calendarObject = calendar as PlainObject
  const kindDescriptor = Object.getOwnPropertyDescriptor(calendar, 'kind')
  if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
    failInput(
      pointer,
      'invalid_type',
      'expected a successful canonical P04 calendar',
    )
  }
  const kind: unknown = kindDescriptor.value as unknown
  const contextKeys = ['kind', 'targetMonth', 'activeLocalDate', 'timeZone']
  const assertContext = (): {
    readonly targetMonth: string
    readonly activeLocalDate: string
  } => {
    const targetMonth = ownValue(calendarObject, 'targetMonth')
    if (typeof targetMonth !== 'string') {
      failInput(
        pointer,
        'invalid_value',
        'expected a successful canonical P04 calendar',
      )
    }
    const match = /^(\d{4})-(\d{2})$/u.exec(targetMonth)
    const year = match === null ? 0 : Number(match[1])
    const month = match === null ? 0 : Number(match[2])
    if (
      match === null ||
      year < 1 ||
      year > 9_999 ||
      month < 1 ||
      month > 12 ||
      ownValue(calendarObject, 'timeZone') !== 'Asia/Yekaterinburg'
    ) {
      failInput(
        pointer,
        'invalid_value',
        'expected a successful canonical P04 calendar',
      )
    }
    const activeLocalDate = canonicalDate(
      ownValue(calendarObject, 'activeLocalDate'),
      pointer,
    )
    if (!activeLocalDate.startsWith(`${targetMonth}-`)) {
      failInput(
        pointer,
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }
    return { targetMonth, activeLocalDate }
  }
  if (kind === 'fixed') {
    assertExactObject(calendar, [...contextKeys, 'expectationDates'], pointer)
    const context = assertContext()
    const expectationDates = denseArray(
      ownValue(calendar, 'expectationDates'),
      pointer,
    ).map((date) => canonicalDate(date, pointer))
    uniqueStrings(expectationDates, pointer)
    if (
      expectationDates.some(
        (date, index) =>
          !date.startsWith(`${context.targetMonth}-`) ||
          date < context.activeLocalDate ||
          (index > 0 && date <= expectationDates[index - 1]!),
      )
    ) {
      failInput(
        pointer,
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }
  } else if (kind === 'quota') {
    assertExactObject(calendar, [...contextKeys, 'cadence', 'periods'], pointer)
    const context = assertContext()
    const cadence = ownValue(calendar, 'cadence')
    if (cadence !== 'weekly' && cadence !== 'monthly') {
      failInput(
        pointer,
        'invalid_value',
        'expected a successful canonical P04 calendar',
      )
    }
    let previousEnd: string | null = null
    let previousOrdinal = 0
    const periodRows = denseArray(ownValue(calendar, 'periods'), pointer)
    periodRows.forEach((period) => {
      assertExactObject(
        period,
        [
          'cadence',
          'ordinal',
          'periodStart',
          'periodEnd',
          'periodDays',
          'activeDates',
          'eligibleDates',
          'periodTarget',
        ],
        pointer,
      )
      if (
        ownValue(period, 'cadence') !== cadence ||
        !Number.isSafeInteger(ownValue(period, 'ordinal')) ||
        !Number.isSafeInteger(ownValue(period, 'periodDays')) ||
        !Number.isSafeInteger(ownValue(period, 'periodTarget')) ||
        (ownValue(period, 'periodTarget') as number) < 0
      ) {
        failInput(
          pointer,
          'invalid_value',
          'expected a successful canonical P04 calendar',
        )
      }
      const ordinal = ownValue(period, 'ordinal') as number
      const periodDays = ownValue(period, 'periodDays') as number
      const periodTarget = ownValue(period, 'periodTarget') as number
      const periodStart = canonicalDate(
        ownValue(period, 'periodStart'),
        pointer,
      )
      const periodEnd = canonicalDate(ownValue(period, 'periodEnd'), pointer)
      const active = denseArray(ownValue(period, 'activeDates'), pointer).map(
        (date) => canonicalDate(date, pointer),
      )
      const eligible = denseArray(
        ownValue(period, 'eligibleDates'),
        pointer,
      ).map((date) => canonicalDate(date, pointer))
      const canonicalPeriod =
        cadence === 'weekly'
          ? weekSegments(context.targetMonth)[ordinal - 1]
          : {
              ordinal: 1,
              periodStart: `${context.targetMonth}-01`,
              periodEnd: datesInMonth(context.targetMonth).at(-1)!,
              dates: datesInMonth(context.targetMonth),
            }
      const canonicalActiveDates =
        canonicalPeriod?.dates.filter(
          (date) => date >= context.activeLocalDate,
        ) ?? []
      if (
        canonicalPeriod === undefined ||
        canonicalPeriod.ordinal !== ordinal ||
        canonicalPeriod.periodStart !== periodStart ||
        canonicalPeriod.periodEnd !== periodEnd ||
        (previousEnd !== null && periodStart <= previousEnd) ||
        ordinal !== previousOrdinal + 1 ||
        (cadence === 'weekly' && periodDays !== 7) ||
        (cadence === 'monthly' &&
          periodDays !== canonicalPeriod.dates.length) ||
        !sameStrings(active, eligible) ||
        !sameStrings(active, canonicalActiveDates) ||
        (eligible.length === 0
          ? periodTarget !== 0
          : periodTarget < 1 || periodTarget > eligible.length)
      ) {
        failInput(
          pointer,
          'incompatible',
          'expected a successful canonical P04 calendar',
        )
      }
      uniqueStrings(eligible, pointer)
      previousEnd = periodEnd
      previousOrdinal = ordinal
    })
    const expectedPeriodCount =
      cadence === 'weekly' ? weekSegments(context.targetMonth).length : 1
    if (periodRows.length !== expectedPeriodCount) {
      failInput(
        pointer,
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }
  } else if (kind === 'weekly_planned_task') {
    assertExactObject(calendar, [...contextKeys, 'periods'], pointer)
    const context = assertContext()
    const periods = denseArray(ownValue(calendar, 'periods'), pointer)
    if (periods.length > 1) {
      failInput(
        pointer,
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }
    for (const period of periods) {
      assertExactObject(
        period,
        ['cadence', 'ordinal', 'periodStart', 'periodEnd', 'periodTarget'],
        pointer,
      )
      if (
        ownValue(period, 'cadence') !== 'weekly' ||
        ownValue(period, 'periodTarget') !== 1 ||
        !Number.isSafeInteger(ownValue(period, 'ordinal'))
      ) {
        failInput(
          pointer,
          'invalid_value',
          'expected a successful canonical P04 calendar',
        )
      }
      const ordinal = ownValue(period, 'ordinal') as number
      const periodStart = canonicalDate(
        ownValue(period, 'periodStart'),
        pointer,
      )
      const periodEnd = canonicalDate(ownValue(period, 'periodEnd'), pointer)
      const canonicalPeriod = weekSegments(context.targetMonth)[ordinal - 1]
      if (
        ordinal < 1 ||
        ordinal > 5 ||
        canonicalPeriod?.periodStart !== periodStart ||
        canonicalPeriod.periodEnd !== periodEnd ||
        periodEnd < context.activeLocalDate
      ) {
        failInput(
          pointer,
          'incompatible',
          'expected a successful canonical P04 calendar',
        )
      }
    }
  } else {
    failInput(
      pointer,
      'invalid_value',
      'expected a successful canonical P04 calendar',
    )
  }
  return internalFreezeData({
    formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
    eligible: true as const,
    calendar: structuredCloneData(
      calendar,
    ) as unknown as ParsedCalendar['calendar'],
    issues: [] as const,
  })
}

function structuredCloneData<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) =>
      structuredCloneData(item),
    ) as T
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor !== undefined && 'value' in descriptor) {
          result[key] = structuredCloneData(descriptor.value as unknown)
        }
      }
    }
    return result as T
  }
  return value
}

function readFactValue(
  value: unknown,
  measurement: EvaluationMeasurementV1,
  pointer: GoalEvaluationInputIssuePointer,
): GoalFactValueV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (descriptor === undefined || !('value' in descriptor)) {
    failInput(pointer, 'invalid_type', 'expected a supported fact kind')
  }
  const kind: unknown = descriptor.value as unknown
  if (kind === 'not_done') {
    assertExactObject(value, ['kind'], pointer)
    return { kind }
  }
  if (kind === 'boolean' && measurement.kind === 'boolean') {
    assertExactObject(value, ['kind', 'result'], pointer)
    const result = ownValue(value, 'result')
    if (result !== 'done' && result !== 'not_done') {
      failInput(
        pointer,
        'invalid_value',
        'expected fact value to match measurement',
      )
    }
    return { kind, result }
  }
  if (
    kind === 'quantity_add' &&
    measurement.kind === 'quantity' &&
    measurement.aggregation === 'add'
  ) {
    assertExactObject(value, ['kind', 'contributions'], pointer)
    const contributions = denseArray(
      ownValue(value, 'contributions'),
      pointer,
      false,
    ).map((row) => {
      assertExactObject(row, ['contributionId', 'value'], pointer)
      return {
        contributionId: nonemptyString(
          ownValue(row, 'contributionId'),
          pointer,
        ),
        value: decimal(
          ownValue(row, 'value'),
          measurement.precision,
          false,
          pointer,
        ),
      }
    })
    uniqueStrings(
      contributions.map((row) => row.contributionId),
      pointer,
    )
    return {
      kind,
      contributions: contributions as [
        { contributionId: string; value: string },
        ...{ contributionId: string; value: string }[],
      ],
    }
  }
  if (
    kind === 'quantity_latest' &&
    measurement.kind === 'quantity' &&
    measurement.aggregation === 'latest'
  ) {
    assertExactObject(value, ['kind', 'value'], pointer)
    return {
      kind,
      value: decimal(
        ownValue(value, 'value'),
        measurement.precision,
        false,
        pointer,
      ),
    }
  }
  if (kind === 'actual_time' && measurement.kind === 'actual_time') {
    assertExactObject(value, ['kind', 'value'], pointer)
    return { kind, value: canonicalTime(ownValue(value, 'value'), pointer) }
  }
  if (kind === 'rating' && measurement.kind === 'rating') {
    assertExactObject(value, ['kind', 'value'], pointer)
    const rating = ownValue(value, 'value')
    if (
      !Number.isSafeInteger(rating) ||
      (rating as number) < measurement.minimum ||
      (rating as number) > measurement.maximum
    ) {
      failInput(pointer, 'invalid_value', 'expected a safe integer')
    }
    return { kind, value: rating as number }
  }
  if (kind === 'text' && measurement.kind === 'text') {
    assertExactObject(value, ['kind', 'text', 'result'], pointer)
    const result = ownValue(value, 'result')
    if (result !== 'done' && result !== 'not_done') {
      failInput(
        pointer,
        'invalid_value',
        'expected fact value to match measurement',
      )
    }
    return {
      kind,
      text: nonemptyString(ownValue(value, 'text'), pointer),
      result,
    }
  }
  if (kind === 'checklist' && measurement.kind === 'checklist') {
    assertExactObject(value, ['kind', 'items'], pointer)
    const allowed = new Set(measurement.items.map((item) => item.itemId))
    const items = denseArray(ownValue(value, 'items'), pointer, false).map(
      (row) => {
        assertExactObject(row, ['itemId', 'state'], pointer)
        const itemId = nonemptyString(ownValue(row, 'itemId'), pointer)
        const state = ownValue(row, 'state')
        if (!allowed.has(itemId)) {
          failInput(
            pointer,
            'incompatible',
            'expected fact value to match measurement',
          )
        }
        let parsedState: 'done' | 'not_done'
        if (state === 'done') {
          parsedState = 'done'
        } else if (state === 'not_done') {
          parsedState = 'not_done'
        } else {
          failInput(
            pointer,
            'incompatible',
            'expected fact value to match measurement',
          )
        }
        return { itemId, state: parsedState }
      },
    )
    uniqueStrings(
      items.map((item) => item.itemId),
      pointer,
    )
    return { kind, items }
  }
  if (kind === 'any_of' && measurement.kind === 'any_of') {
    assertExactObject(value, ['kind', 'variants'], pointer)
    const variantsById = new Map(
      measurement.variants.map((variant) => [variant.variantId, variant]),
    )
    const variants = denseArray(
      ownValue(value, 'variants'),
      pointer,
      false,
    ).map((row) => {
      assertExactObject(row, ['variantId', 'value'], pointer)
      const variantId = nonemptyString(ownValue(row, 'variantId'), pointer)
      const variant = variantsById.get(variantId)
      if (variant === undefined) {
        failInput(
          pointer,
          'incompatible',
          'expected fact value to match measurement',
        )
      }
      return {
        variantId,
        value: decimal(
          ownValue(row, 'value'),
          variant.precision,
          false,
          pointer,
        ),
      }
    })
    uniqueStrings(
      variants.map((variant) => variant.variantId),
      pointer,
    )
    return { kind, variants }
  }
  failInput(pointer, 'incompatible', 'expected fact value to match measurement')
}

function readFacts(
  value: unknown,
  snapshot: GoalEvaluationSnapshotV1,
  calendar: ParsedCalendar,
  asOf: string,
): readonly GoalEvaluationFactV1[] {
  const rows = denseArray(value, '/facts')
  const result: GoalEvaluationFactV1[] = []
  const identities = new Set<string>()
  const contributionIds = new Set<string>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const pointer = `/facts/${index}` as const
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      failInput(pointer, 'invalid_type', 'expected a plain object')
    }
    const descriptor = Object.getOwnPropertyDescriptor(row, 'kind')
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a supported fact kind')
    }
    const kind: unknown = descriptor.value as unknown
    if (calendar.calendar.kind === 'fixed') {
      const expectedKind =
        snapshot.checkpoints === null ? 'fixed' : 'fixed_checkpoints'
      if (kind !== expectedKind) {
        failInput(
          pointer,
          'incompatible',
          'expected fact kind to match calendar and snapshot',
        )
      }
      if (kind === 'fixed') {
        assertExactObject(row, ['kind', 'expectationDate', 'value'], pointer)
        const datePointer = `/facts/${index}/expectationDate` as const
        const expectationDate = canonicalDate(
          ownValue(row, 'expectationDate'),
          datePointer,
        )
        if (
          !calendar.calendar.expectationDates.includes(expectationDate) ||
          expectationDate > asOf ||
          identities.has(expectationDate)
        ) {
          failInput(
            datePointer,
            'incompatible',
            'expected fact identity inside entered calendar as-of',
          )
        }
        identities.add(expectationDate)
        const factValue = readFactValue(
          ownValue(row, 'value'),
          snapshot.measurement,
          `/facts/${index}/value`,
        )
        if (factValue.kind === 'quantity_add') {
          for (const contribution of factValue.contributions) {
            if (contributionIds.has(contribution.contributionId)) {
              failInput(
                `/facts/${index}/value`,
                'incompatible',
                'expected unique component identities',
              )
            }
            contributionIds.add(contribution.contributionId)
          }
        }
        result.push({
          kind,
          expectationDate,
          value: factValue,
        })
      } else {
        assertExactObject(
          row,
          ['kind', 'expectationDate', 'checkpoints'],
          pointer,
        )
        const datePointer = `/facts/${index}/expectationDate` as const
        const expectationDate = canonicalDate(
          ownValue(row, 'expectationDate'),
          datePointer,
        )
        if (
          !calendar.calendar.expectationDates.includes(expectationDate) ||
          expectationDate > asOf ||
          identities.has(expectationDate)
        ) {
          failInput(
            datePointer,
            'incompatible',
            'expected fact identity inside entered calendar as-of',
          )
        }
        identities.add(expectationDate)
        const checkpointsPointer = `/facts/${index}/checkpoints` as const
        const checkpointIdPointer = `/facts/${index}/checkpointId` as const
        const valuePointer = `/facts/${index}/value` as const
        const configById = new Map(
          snapshot.checkpoints!.items.map((item) => [item.checkpointId, item]),
        )
        const checkpointIds = new Set<string>()
        const checkpoints = denseArray(
          ownValue(row, 'checkpoints'),
          checkpointsPointer,
          false,
        ).map((entry) => {
          assertExactObject(
            entry,
            ['checkpointId', 'value'],
            checkpointsPointer,
          )
          const checkpointId = nonemptyString(
            ownValue(entry, 'checkpointId'),
            checkpointIdPointer,
          )
          const config = configById.get(checkpointId)
          if (config === undefined || checkpointIds.has(checkpointId)) {
            failInput(
              checkpointIdPointer,
              'incompatible',
              'expected unique component identities',
            )
          }
          checkpointIds.add(checkpointId)
          const factValue = readFactValue(
            ownValue(entry, 'value'),
            snapshot.measurement,
            valuePointer,
          )
          if (factValue.kind === 'quantity_add') {
            for (const contribution of factValue.contributions) {
              if (contributionIds.has(contribution.contributionId)) {
                failInput(
                  valuePointer,
                  'incompatible',
                  'expected unique component identities',
                )
              }
              contributionIds.add(contribution.contributionId)
            }
          }
          return {
            checkpointId,
            value: factValue,
          }
        })
        result.push({ kind: 'fixed_checkpoints', expectationDate, checkpoints })
      }
    } else if (calendar.calendar.kind === 'quota') {
      if (snapshot.checkpoints !== null || kind !== 'quota_occurrence') {
        failInput(
          pointer,
          'incompatible',
          'expected fact kind to match calendar and snapshot',
        )
      }
      assertExactObject(row, ['kind', 'localDate', 'value'], pointer)
      const datePointer = `/facts/${index}/localDate` as const
      const localDate = canonicalDate(ownValue(row, 'localDate'), datePointer)
      const eligible = calendar.calendar.periods.some((period) =>
        period.eligibleDates.includes(localDate),
      )
      if (!eligible || localDate > asOf || identities.has(localDate)) {
        failInput(
          datePointer,
          'incompatible',
          'expected fact identity inside entered calendar as-of',
        )
      }
      identities.add(localDate)
      const factValue = readFactValue(
        ownValue(row, 'value'),
        snapshot.measurement,
        `/facts/${index}/value`,
      )
      if (factValue.kind === 'quantity_add') {
        for (const contribution of factValue.contributions) {
          if (contributionIds.has(contribution.contributionId)) {
            failInput(
              `/facts/${index}/value`,
              'incompatible',
              'expected unique component identities',
            )
          }
          contributionIds.add(contribution.contributionId)
        }
      }
      result.push({
        kind,
        localDate,
        value: factValue,
      })
    } else {
      if (
        snapshot.measurement.kind !== 'boolean' ||
        snapshot.checkpoints !== null ||
        kind !== 'weekly_planned_task'
      ) {
        failInput(
          pointer,
          'incompatible',
          'expected fact kind to match calendar and snapshot',
        )
      }
      assertExactObject(
        row,
        ['kind', 'periodStart', 'periodEnd', 'result'],
        pointer,
      )
      const startPointer = `/facts/${index}/periodStart` as const
      const endPointer = `/facts/${index}/periodEnd` as const
      const periodStart = canonicalDate(
        ownValue(row, 'periodStart'),
        startPointer,
      )
      const periodEnd = canonicalDate(ownValue(row, 'periodEnd'), endPointer)
      const period = calendar.calendar.periods.find(
        (candidate) =>
          candidate.periodStart === periodStart &&
          candidate.periodEnd === periodEnd,
      )
      const factResult = ownValue(row, 'result')
      if (
        period === undefined ||
        periodStart > asOf ||
        identities.has(periodStart) ||
        (factResult !== 'done' && factResult !== 'not_done')
      ) {
        failInput(
          startPointer,
          'incompatible',
          'expected fact identity inside entered calendar as-of',
        )
      }
      identities.add(periodStart)
      result.push({ kind, periodStart, periodEnd, result: factResult })
    }
  }
  return result
}

function decimalDigits(value: string): number {
  return value.includes('.') ? value.length - 1 : value.length
}

function exactValueDigits(value: GoalFactValueV1): number {
  if (value.kind === 'quantity_add') {
    return value.contributions.reduce(
      (total, contribution) => total + decimalDigits(contribution.value),
      0,
    )
  }
  if (value.kind === 'quantity_latest') {
    return decimalDigits(value.value)
  }
  if (value.kind === 'any_of') {
    return value.variants.reduce(
      (total, variant) => total + decimalDigits(variant.value),
      0,
    )
  }
  return 0
}

function assertGoalExactInputBudget(
  snapshot: GoalEvaluationSnapshotV1,
  facts: readonly GoalEvaluationFactV1[],
  ledger: InternalExactWorkLedger,
): void {
  let digits = 0
  if (
    snapshot.measurement.kind === 'quantity' &&
    snapshot.measurement.target !== null
  ) {
    digits += decimalDigits(snapshot.measurement.target)
  } else if (snapshot.measurement.kind === 'any_of') {
    for (const variant of snapshot.measurement.variants) {
      digits += decimalDigits(variant.target)
    }
  }
  for (const checkpoint of snapshot.checkpoints?.items ?? []) {
    if (checkpoint.satisfaction.kind === 'quantity') {
      digits += decimalDigits(checkpoint.satisfaction.target)
    }
  }
  for (const fact of facts) {
    if (fact.kind === 'fixed_checkpoints') {
      for (const checkpoint of fact.checkpoints) {
        digits += exactValueDigits(checkpoint.value)
      }
    } else if (fact.kind === 'fixed' || fact.kind === 'quota_occurrence') {
      digits += exactValueDigits(fact.value)
    }
  }
  internalChargeExactInputDigits(ledger, digits)
}

function chargeCalendarInputDigits(
  value: unknown,
  ledger: InternalExactWorkLedger,
): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return
  }
  const repetitionDescriptor = Object.getOwnPropertyDescriptor(
    value,
    'repetition',
  )
  if (
    repetitionDescriptor === undefined ||
    !('value' in repetitionDescriptor) ||
    repetitionDescriptor.value === null ||
    typeof repetitionDescriptor.value !== 'object' ||
    Array.isArray(repetitionDescriptor.value) ||
    Object.getPrototypeOf(repetitionDescriptor.value) !== Object.prototype
  ) {
    return
  }
  const nDescriptor = Object.getOwnPropertyDescriptor(
    repetitionDescriptor.value,
    'n',
  )
  if (
    nDescriptor !== undefined &&
    'value' in nDescriptor &&
    typeof nDescriptor.value === 'string'
  ) {
    internalChargeExactInputDigits(ledger, nDescriptor.value.length)
  }
}

function quantityActual(
  measurement: Extract<EvaluationMeasurementV1, { kind: 'quantity' }>,
  value: GoalFactValueV1,
): string {
  if (value.kind === 'quantity_latest') {
    return decimalInteger(value.value, measurement.precision)
  }
  if (value.kind === 'quantity_add') {
    let total = '0'
    for (const contribution of value.contributions) {
      total = internalAddInteger(
        total,
        decimalInteger(contribution.value, measurement.precision),
      )
    }
    return total
  }
  return '0'
}

function insideTime(value: string, start: string, end: string): boolean {
  return start < end
    ? value >= start && value <= end
    : value >= start || value <= end
}

function evaluateValue(
  measurement: EvaluationMeasurementV1,
  value: GoalFactValueV1 | undefined,
  satisfaction: EvaluationCheckpointSatisfactionV1 | null = null,
): ValueEvaluation {
  if (value === undefined) {
    const applicable =
      measurement.kind === 'checklist' ? measurement.items.length : 1
    return {
      raw: INTERNAL_ZERO,
      filled: false,
      fullyFilled: false,
      satisfied: false,
      coverageFilled: 0,
      coverageApplicable: applicable,
    }
  }
  if (value.kind === 'not_done') {
    const applicable =
      measurement.kind === 'checklist' ? measurement.items.length : 1
    return {
      raw: INTERNAL_ZERO,
      filled: true,
      fullyFilled: true,
      satisfied: false,
      coverageFilled: applicable,
      coverageApplicable: applicable,
    }
  }
  if (measurement.kind === 'boolean' && value.kind === 'boolean') {
    const done = value.result === 'done'
    return {
      raw: done ? INTERNAL_ONE : INTERNAL_ZERO,
      filled: true,
      fullyFilled: true,
      satisfied: done,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  if (
    measurement.kind === 'quantity' &&
    (value.kind === 'quantity_add' || value.kind === 'quantity_latest')
  ) {
    const target =
      satisfaction?.kind === 'quantity'
        ? satisfaction.target
        : measurement.target
    const raw =
      target === null
        ? INTERNAL_ZERO
        : internalRational(
            quantityActual(measurement, value),
            decimalInteger(target, measurement.precision),
          )
    return {
      raw,
      filled: true,
      fullyFilled: true,
      satisfied:
        target !== null && internalCompareRational(raw, INTERNAL_ONE) >= 0,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  if (measurement.kind === 'actual_time' && value.kind === 'actual_time') {
    const start =
      satisfaction?.kind === 'actual_time'
        ? satisfaction.start
        : measurement.start
    const end =
      satisfaction?.kind === 'actual_time' ? satisfaction.end : measurement.end
    const satisfied = insideTime(value.value, start, end)
    return {
      raw: satisfied ? INTERNAL_ONE : INTERNAL_ZERO,
      filled: true,
      fullyFilled: true,
      satisfied,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  if (measurement.kind === 'rating' && value.kind === 'rating') {
    return {
      raw: INTERNAL_ONE,
      filled: true,
      fullyFilled: true,
      satisfied: true,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  if (measurement.kind === 'text' && value.kind === 'text') {
    const satisfied = value.result === 'done'
    return {
      raw: satisfied ? INTERNAL_ONE : INTERNAL_ZERO,
      filled: true,
      fullyFilled: true,
      satisfied,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  if (measurement.kind === 'checklist' && value.kind === 'checklist') {
    const done = value.items.filter((item) => item.state === 'done').length
    const applicable = measurement.items.length
    const filled = value.items.length
    return {
      raw: internalRational(String(done), String(applicable)),
      filled: filled > 0,
      fullyFilled: filled === applicable,
      satisfied: done === applicable,
      coverageFilled: filled,
      coverageApplicable: applicable,
    }
  }
  if (measurement.kind === 'any_of' && value.kind === 'any_of') {
    const variants = new Map(
      measurement.variants.map((variant) => [variant.variantId, variant]),
    )
    let raw: InternalRational = INTERNAL_ZERO
    for (const fact of value.variants) {
      const variant = variants.get(fact.variantId)!
      const candidate = internalRational(
        decimalInteger(fact.value, variant.precision),
        decimalInteger(variant.target, variant.precision),
      )
      if (internalCompareRational(candidate, raw) > 0) raw = candidate
    }
    return {
      raw,
      filled: true,
      fullyFilled: true,
      satisfied: internalCompareRational(raw, INTERNAL_ONE) >= 0,
      coverageFilled: 1,
      coverageApplicable: 1,
    }
  }
  return {
    raw: INTERNAL_ZERO,
    filled: false,
    fullyFilled: false,
    satisfied: false,
    coverageFilled: 0,
    coverageApplicable: 1,
  }
}

function unavailable(
  reason: 'informational' | 'no_applicable_units',
): EvaluationMetric {
  return internalFreezeData({
    available: false as const,
    exact: null,
    basisPoints: null,
    reason,
  })
}

function result(
  progress: EvaluationMetric,
  score: EvaluationMetric,
  overperformance: EvaluationMetric,
  filled: number,
  applicable: number,
  periods: readonly FlexiblePeriodEvaluationV1[] = [],
): GoalProgressResult {
  const coverage = { filled: String(filled), applicable: String(applicable) }
  const scoreRatio = score.available ? score.exact : null
  return internalFreezeData({
    formulaVersions: {
      calendar: CALENDAR_TARGETS_FORMULA_VERSION,
      evaluation: GOAL_EVALUATION_FORMULA_VERSION,
    },
    progress,
    score,
    overperformance,
    coverage,
    contribution: { score: scoreRatio, coverage: { ...coverage } },
    periods: periods.map((period) => structuredCloneData(period)),
  })
}

function scoredResult(
  progress: InternalRational,
  score: InternalRational,
  filled: number,
  applicable: number,
  periods: readonly FlexiblePeriodEvaluationV1[] = [],
): GoalProgressResult {
  return result(
    internalAvailableMetric(progress),
    internalAvailableMetric(score),
    internalAvailableMetric(internalSubtractRational(progress, score)),
    filled,
    applicable,
    periods,
  )
}

function evaluateFixed(
  snapshot: GoalEvaluationSnapshotV1,
  calendar: Extract<ParsedCalendar['calendar'], { kind: 'fixed' }>,
  facts: readonly GoalEvaluationFactV1[],
  asOf: string,
): GoalProgressResult {
  const expectationDates = calendar.expectationDates.filter(
    (date) => date <= asOf,
  )
  if (
    snapshot.measurement.kind === 'quantity' &&
    snapshot.measurement.mode === 'informational'
  ) {
    const metric = unavailable('informational')
    if (snapshot.checkpoints === null) {
      let filled = 0
      const factsByDate = new Map(
        (facts as readonly ParsedFixedFact[]).map((fact) => [
          fact.expectationDate,
          fact.value,
        ]),
      )
      for (const date of expectationDates) {
        filled += evaluateValue(
          snapshot.measurement,
          factsByDate.get(date),
        ).coverageFilled
      }
      return result(metric, metric, metric, filled, expectationDates.length)
    }
    const factsByDate = new Map(
      (facts as readonly ParsedCheckpointFact[]).map((fact) => [
        fact.expectationDate,
        new Map(
          fact.checkpoints.map((checkpoint) => [
            checkpoint.checkpointId,
            checkpoint.value,
          ]),
        ),
      ]),
    )
    if (snapshot.checkpoints.aggregation === 'all') {
      let filled = 0
      for (const date of expectationDates) {
        const values = factsByDate.get(date)
        if (
          snapshot.checkpoints.items.every(
            (checkpoint) =>
              evaluateValue(
                snapshot.measurement,
                values?.get(checkpoint.checkpointId),
                checkpoint.satisfaction,
              ).fullyFilled,
          )
        ) {
          filled += 1
        }
      }
      return result(metric, metric, metric, filled, expectationDates.length)
    }
    let filled = 0
    let applicable = 0
    for (const date of expectationDates) {
      const values = factsByDate.get(date)
      for (const checkpoint of snapshot.checkpoints.items) {
        const evaluation = evaluateValue(
          snapshot.measurement,
          values?.get(checkpoint.checkpointId),
          checkpoint.satisfaction,
        )
        filled += evaluation.coverageFilled
        applicable += evaluation.coverageApplicable
      }
    }
    return result(metric, metric, metric, filled, applicable)
  }
  if (expectationDates.length === 0) {
    const metric = unavailable('no_applicable_units')
    return result(metric, metric, metric, 0, 0)
  }
  if (snapshot.checkpoints === null) {
    const factsByDate = new Map(
      (facts as readonly ParsedFixedFact[]).map((fact) => [
        fact.expectationDate,
        fact.value,
      ]),
    )
    let total: InternalRational = INTERNAL_ZERO
    let filled = 0
    let applicable = 0
    for (const date of expectationDates) {
      const evaluation = evaluateValue(
        snapshot.measurement,
        factsByDate.get(date),
      )
      total = internalAddRational(total, evaluation.raw)
      filled += evaluation.coverageFilled
      applicable += evaluation.coverageApplicable
    }
    const progress = internalDivideRationalBySmall(
      total,
      expectationDates.length,
    )
    return scoredResult(progress, internalCapOne(progress), filled, applicable)
  }
  const factsByDate = new Map(
    (facts as readonly ParsedCheckpointFact[]).map((fact) => [
      fact.expectationDate,
      new Map(fact.checkpoints.map((row) => [row.checkpointId, row.value])),
    ]),
  )
  if (snapshot.checkpoints.aggregation === 'all') {
    let achieved = 0
    let filled = 0
    for (const date of expectationDates) {
      const values = factsByDate.get(date)
      const evaluations = snapshot.checkpoints.items.map((checkpoint) =>
        evaluateValue(
          snapshot.measurement,
          values?.get(checkpoint.checkpointId),
          checkpoint.satisfaction,
        ),
      )
      if (evaluations.every((evaluation) => evaluation.satisfied)) achieved += 1
      if (evaluations.every((evaluation) => evaluation.fullyFilled)) filled += 1
    }
    const progress = internalRational(
      String(achieved),
      String(expectationDates.length),
    )
    return scoredResult(progress, progress, filled, expectationDates.length)
  }
  let parentRaw: InternalRational = INTERNAL_ZERO
  let parentScore: InternalRational = INTERNAL_ZERO
  let filled = 0
  let applicable = 0
  for (const checkpoint of snapshot.checkpoints.items) {
    let childRaw: InternalRational = INTERNAL_ZERO
    for (const date of expectationDates) {
      const evaluation = evaluateValue(
        snapshot.measurement,
        factsByDate.get(date)?.get(checkpoint.checkpointId),
        checkpoint.satisfaction,
      )
      childRaw = internalAddRational(childRaw, evaluation.raw)
      filled += evaluation.coverageFilled
      applicable += evaluation.coverageApplicable
    }
    const childProgress = internalDivideRationalBySmall(
      childRaw,
      expectationDates.length,
    )
    parentRaw = internalAddRational(parentRaw, childProgress)
    parentScore = internalAddRational(
      parentScore,
      internalCapOne(childProgress),
    )
  }
  const childCount = snapshot.checkpoints.items.length
  const progress = internalDivideRationalBySmall(parentRaw, childCount)
  const score = internalDivideRationalBySmall(parentScore, childCount)
  return scoredResult(progress, score, filled, applicable)
}

function evaluateQuota(
  snapshot: GoalEvaluationSnapshotV1,
  calendar: Extract<ParsedCalendar['calendar'], { kind: 'quota' }>,
  facts: readonly GoalEvaluationFactV1[],
  asOf: string,
): GoalProgressResult {
  if (
    snapshot.measurement.kind === 'quantity' &&
    snapshot.measurement.mode === 'informational'
  ) {
    const metric = unavailable('informational')
    return result(metric, metric, metric, 0, 0)
  }
  const factsByDate = new Map(
    (facts as readonly ParsedQuotaFact[]).map((fact) => [
      fact.localDate,
      fact.value,
    ]),
  )
  let actualTotal: InternalRational = INTERNAL_ZERO
  let creditedTotal: InternalRational = INTERNAL_ZERO
  let overTotal: InternalRational = INTERNAL_ZERO
  let targetTotal = 0
  const periods: FlexiblePeriodEvaluationV1[] = []
  for (const period of calendar.periods) {
    if (period.periodStart > asOf || period.periodTarget === 0) continue
    let actual: InternalRational = INTERNAL_ZERO
    for (const date of period.eligibleDates) {
      if (date <= asOf) {
        const value = factsByDate.get(date)
        if (value !== undefined) {
          actual = internalAddRational(
            actual,
            internalCapOne(evaluateValue(snapshot.measurement, value).raw),
          )
        }
      }
    }
    const target = internalRational(String(period.periodTarget), '1')
    const credited =
      internalCompareRational(actual, target) > 0 ? target : actual
    const over = internalSubtractRational(actual, credited)
    actualTotal = internalAddRational(actualTotal, actual)
    creditedTotal = internalAddRational(creditedTotal, credited)
    overTotal = internalAddRational(overTotal, over)
    targetTotal += period.periodTarget
    periods.push({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      periodTarget: String(period.periodTarget),
      actualEquivalentOccurrences: internalPublicRatio(actual),
      creditedOccurrences: internalPublicRatio(credited),
      overperformanceOccurrences: internalPublicRatio(over),
    })
  }
  if (targetTotal === 0) {
    const metric = unavailable('no_applicable_units')
    return result(metric, metric, metric, 0, 0)
  }
  const target = internalRational(String(targetTotal), '1')
  return scoredResult(
    internalDivideRational(actualTotal, target),
    internalDivideRational(creditedTotal, target),
    0,
    0,
    periods,
  )
}

function evaluateWeeklyTask(
  calendar: Extract<
    ParsedCalendar['calendar'],
    { kind: 'weekly_planned_task' }
  >,
  facts: readonly GoalEvaluationFactV1[],
  asOf: string,
): GoalProgressResult {
  const period = calendar.periods.find(
    (candidate) => candidate.periodStart <= asOf,
  )
  if (period === undefined) {
    const metric = unavailable('no_applicable_units')
    return result(metric, metric, metric, 0, 0)
  }
  const fact = (facts as readonly ParsedWeeklyFact[]).find(
    (candidate) => candidate.periodStart === period.periodStart,
  )
  const progress = fact?.result === 'done' ? INTERNAL_ONE : INTERNAL_ZERO
  return scoredResult(progress, progress, 0, 0)
}

export function evaluateGoalProgress(
  input: EvaluateGoalProgressInput,
): GoalProgressResult {
  assertExactObject(
    input,
    ['snapshot', 'calendarInput', 'calendar', 'facts', 'asOfLocalDate'],
    '',
  )
  try {
    const snapshotValue = ownValue(input, 'snapshot')
    const calendarInputValue = ownValue(input, 'calendarInput')
    const calendarValue = ownValue(input, 'calendar')
    const factsValue = ownValue(input, 'facts')
    const ledger = internalCreateExactWorkLedger()
    preflightExactArrays(snapshotValue, ledger)
    preflightExactArrays(calendarInputValue, ledger)
    preflightExactArrays(calendarValue, ledger)
    preflightExactArrays(factsValue, ledger)
    chargeCalendarInputDigits(calendarInputValue, ledger)

    let authenticCalendar: EligibleCalendarResult
    try {
      authenticCalendar = calculateEligibleCalendar(
        calendarInputValue as CalendarTargetsInput,
      )
    } catch (error) {
      if (error instanceof CalendarTargetsInputError) {
        failInput(
          '/calendarInput',
          error.issues[0].code,
          'expected a successful canonical P04 calendar',
        )
      }
      throw error
    }
    if (!authenticCalendar.eligible) {
      failInput(
        '/calendarInput',
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }

    const snapshot = readSnapshot(snapshotValue)
    const calendar = readCalendar(calendarValue)
    if (!samePlainData(calendar, authenticCalendar)) {
      failInput(
        '/calendar',
        'incompatible',
        'expected a successful canonical P04 calendar',
      )
    }
    const asOf = canonicalDate(
      ownValue(input, 'asOfLocalDate'),
      '/asOfLocalDate',
    )
    if (
      (calendar.calendar.kind === 'quota' && snapshot.checkpoints !== null) ||
      (calendar.calendar.kind === 'weekly_planned_task' &&
        (snapshot.measurement.kind !== 'boolean' ||
          snapshot.checkpoints !== null))
    ) {
      failInput(
        '/calendar',
        'incompatible',
        'expected fact kind to match calendar and snapshot',
      )
    }
    const facts = readFacts(factsValue, snapshot, calendar, asOf)
    assertGoalExactInputBudget(snapshot, facts, ledger)
    if (calendar.calendar.kind === 'fixed') {
      return evaluateFixed(snapshot, calendar.calendar, facts, asOf)
    }
    if (calendar.calendar.kind === 'quota') {
      return evaluateQuota(snapshot, calendar.calendar, facts, asOf)
    }
    return evaluateWeeklyTask(calendar.calendar, facts, asOf)
  } catch (error) {
    if (error instanceof InternalExactWorkLimitError) {
      failInput(
        '/facts',
        'input_too_complex',
        'expected exact work within budget',
      )
    }
    throw error
  }
}
