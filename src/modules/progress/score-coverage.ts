export const SCORE_COVERAGE_FORMULA_VERSION =
  'planner.score-coverage.v1' as const

export interface CanonicalExactRatio {
  readonly numerator: string
  readonly denominator: string
}

export interface ScoreCoverageContributionV1 {
  readonly score: CanonicalExactRatio | null
  readonly coverage: {
    readonly filled: string
    readonly applicable: string
  }
}

export type AggregateMetric =
  | {
      readonly available: true
      readonly exact: CanonicalExactRatio
      readonly basisPoints: string
    }
  | {
      readonly available: false
      readonly exact: null
      readonly basisPoints: null
      readonly reason: 'no_scored_goals' | 'no_fixed_units'
    }

export interface ScoreCoverageResult {
  readonly formulaVersion: typeof SCORE_COVERAGE_FORMULA_VERSION
  readonly monthScore: AggregateMetric
  readonly coverage: AggregateMetric
  readonly totals: {
    readonly scoredGoals: string
    readonly filled: string
    readonly applicable: string
  }
}

export type ScoreCoverageInputIssueCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'unexpected_property'
  | 'incompatible'
  | 'input_too_complex'

export type ScoreCoverageInputIssuePointer =
  | ''
  | '/contributions'
  | `/contributions/${number}`
  | `/contributions/${number}/score`
  | `/contributions/${number}/coverage`

export type ScoreCoverageInputIssueDetail =
  | 'expected a plain object'
  | 'expected exact properties'
  | 'expected a dense plain array'
  | 'expected a canonical exact ratio'
  | 'expected a canonical nonnegative integer'
  | 'expected score at most one'
  | 'expected filled not greater than applicable'
  | 'expected exact work within budget'

export interface ScoreCoverageInputIssue {
  readonly pointer: ScoreCoverageInputIssuePointer
  readonly code: ScoreCoverageInputIssueCode
  readonly detail: ScoreCoverageInputIssueDetail
}

export class ScoreCoverageInputError extends Error {
  readonly issues: readonly [
    ScoreCoverageInputIssue,
    ...ScoreCoverageInputIssue[],
  ]

  constructor(
    issues: readonly [ScoreCoverageInputIssue, ...ScoreCoverageInputIssue[]],
  ) {
    super('Invalid score coverage input')
    this.name = 'ScoreCoverageInputError'
    this.issues = internalFreezeData(
      issues.map((issue) => ({ ...issue })),
    ) as unknown as readonly [
      ScoreCoverageInputIssue,
      ...ScoreCoverageInputIssue[],
    ]
    Object.freeze(this)
  }
}

export interface InternalRational {
  readonly numerator: string
  readonly denominator: string
}

export class InternalExactWorkLimitError extends Error {
  constructor() {
    super('Exact work budget exceeded')
    this.name = 'InternalExactWorkLimitError'
  }
}

const MAX_EXACT_INPUT_DIGITS = 250_000
const MAX_EXACT_TERMS = 10_000
const MAX_EXACT_OUTPUT_DIGITS = 250_000
const MAX_EXACT_MULTIPLY_WORK = 25_000_000
const MAX_EXACT_DIVIDE_WORK = 50_000_000

export interface InternalExactWorkLedger {
  inputDigits: number
  terms: number
}

export function internalCreateExactWorkLedger(): InternalExactWorkLedger {
  return { inputDigits: 0, terms: 0 }
}

function chargeExactWork(
  ledger: InternalExactWorkLedger,
  field: 'inputDigits' | 'terms',
  amount: number,
  maximum: number,
): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    ledger[field] > maximum - amount
  ) {
    throw new InternalExactWorkLimitError()
  }
  ledger[field] += amount
}

export function internalChargeExactInputDigits(
  ledger: InternalExactWorkLedger,
  digits: number,
): void {
  chargeExactWork(ledger, 'inputDigits', digits, MAX_EXACT_INPUT_DIGITS)
}

export function internalChargeExactTerms(
  ledger: InternalExactWorkLedger,
  terms: number,
): void {
  chargeExactWork(ledger, 'terms', terms, MAX_EXACT_TERMS)
}

export function internalAssertExactInputBudget(
  totalDigits: number,
  terms: number,
): void {
  if (
    !Number.isSafeInteger(totalDigits) ||
    !Number.isSafeInteger(terms) ||
    totalDigits > MAX_EXACT_INPUT_DIGITS ||
    terms > MAX_EXACT_TERMS
  ) {
    throw new InternalExactWorkLimitError()
  }
}

function assertExactOperationBudget(
  leftDigits: number,
  rightDigits: number,
  maximumWork: number,
): void {
  if (
    leftDigits + rightDigits > MAX_EXACT_OUTPUT_DIGITS ||
    (rightDigits !== 0 && leftDigits > Math.floor(maximumWork / rightDigits))
  ) {
    throw new InternalExactWorkLimitError()
  }
}

type PlainObject = Record<PropertyKey, unknown>

export function internalFreezeData<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) internalFreezeData(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor) {
        internalFreezeData(descriptor.value)
      }
    }
    return Object.freeze(value)
  }
  return value
}

function failInput(
  pointer: ScoreCoverageInputIssuePointer,
  code: ScoreCoverageInputIssueCode,
  detail: ScoreCoverageInputIssueDetail,
): never {
  throw new ScoreCoverageInputError([{ pointer, code, detail }])
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  pointer: ScoreCoverageInputIssuePointer,
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
  pointer: ScoreCoverageInputIssuePointer,
  ledger: InternalExactWorkLedger,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    failInput(pointer, 'invalid_type', 'expected a dense plain array')
  }
  const length: number = value.length
  if (!Number.isSafeInteger(length) || length < 0) {
    failInput(pointer, 'invalid_type', 'expected a dense plain array')
  }
  internalChargeExactTerms(ledger, length)
  const expected = new Set<PropertyKey>(['length'])
  for (let index = 0; index < length; index += 1) {
    expected.add(String(index))
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    failInput(pointer, 'invalid_type', 'expected a dense plain array')
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a dense plain array')
    }
  }
  return value
}

function descriptorValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined
}

function chargeStringLength(
  value: unknown,
  ledger: InternalExactWorkLedger,
): void {
  if (typeof value === 'string') {
    internalChargeExactInputDigits(ledger, value.length)
  }
}

function preflightContributionDigits(
  rows: readonly unknown[],
  ledger: InternalExactWorkLedger,
): void {
  for (let index = 0; index < rows.length; index += 1) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(rows, String(index))
    if (rowDescriptor === undefined || !('value' in rowDescriptor)) continue
    const score = descriptorValue(rowDescriptor.value, 'score')
    if (score !== null) {
      chargeStringLength(descriptorValue(score, 'numerator'), ledger)
      chargeStringLength(descriptorValue(score, 'denominator'), ledger)
    }
    const coverage = descriptorValue(rowDescriptor.value, 'coverage')
    chargeStringLength(descriptorValue(coverage, 'filled'), ledger)
    chargeStringLength(descriptorValue(coverage, 'applicable'), ledger)
  }
}

function canonicalInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)
}

function normalizeInteger(value: string): string {
  let index = 0
  while (index < value.length - 1 && value.charCodeAt(index) === 48) index += 1
  return value.slice(index)
}

export function internalCompareInteger(left: string, right: string): number {
  const normalizedLeft = normalizeInteger(left)
  const normalizedRight = normalizeInteger(right)
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1
  }
  return normalizedLeft < normalizedRight
    ? -1
    : normalizedLeft > normalizedRight
      ? 1
      : 0
}

export function internalAddInteger(left: string, right: string): string {
  if (Math.max(left.length, right.length) + 1 > MAX_EXACT_OUTPUT_DIGITS) {
    throw new InternalExactWorkLimitError()
  }
  let leftIndex = left.length - 1
  let rightIndex = right.length - 1
  let carry = 0
  const result: string[] = []
  while (leftIndex >= 0 || rightIndex >= 0 || carry !== 0) {
    const leftDigit = leftIndex >= 0 ? left.charCodeAt(leftIndex) - 48 : 0
    const rightDigit = rightIndex >= 0 ? right.charCodeAt(rightIndex) - 48 : 0
    const sum = leftDigit + rightDigit + carry
    result.push(String(sum % 10))
    carry = Math.floor(sum / 10)
    leftIndex -= 1
    rightIndex -= 1
  }
  return normalizeInteger(result.reverse().join(''))
}

function subtractInteger(left: string, right: string): string {
  let leftIndex = left.length - 1
  let rightIndex = right.length - 1
  let borrow = 0
  const result: string[] = []
  while (leftIndex >= 0) {
    let digit = left.charCodeAt(leftIndex) - 48 - borrow
    const rightDigit = rightIndex >= 0 ? right.charCodeAt(rightIndex) - 48 : 0
    if (digit < rightDigit) {
      digit += 10
      borrow = 1
    } else {
      borrow = 0
    }
    result.push(String(digit - rightDigit))
    leftIndex -= 1
    rightIndex -= 1
  }
  return normalizeInteger(result.reverse().join(''))
}

export function internalMultiplySmall(value: string, factor: number): string {
  if (value === '0' || factor === 0) return '0'
  if (factor === 1) return value
  if (value.length + String(factor).length > MAX_EXACT_OUTPUT_DIGITS) {
    throw new InternalExactWorkLimitError()
  }
  let carry = 0
  const result: string[] = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const product = (value.charCodeAt(index) - 48) * factor + carry
    result.push(String(product % 10))
    carry = Math.floor(product / 10)
  }
  while (carry > 0) {
    result.push(String(carry % 10))
    carry = Math.floor(carry / 10)
  }
  return normalizeInteger(result.reverse().join(''))
}

function multiplyInteger(left: string, right: string): string {
  if (left === '0' || right === '0') return '0'
  if (left === '1') return right
  if (right === '1') return left
  assertExactOperationBudget(left.length, right.length, MAX_EXACT_MULTIPLY_WORK)
  const result = new Array<number>(left.length + right.length).fill(0)
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const leftDigit = left.charCodeAt(leftIndex) - 48
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const offset = leftIndex + rightIndex + 1
      const total =
        result[offset]! + leftDigit * (right.charCodeAt(rightIndex) - 48)
      result[offset] = total % 10
      result[offset - 1] = result[offset - 1]! + Math.floor(total / 10)
    }
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    if (result[index]! >= 10) {
      result[index - 1] = result[index - 1]! + Math.floor(result[index]! / 10)
      result[index] = result[index]! % 10
    }
  }
  return normalizeInteger(result.join(''))
}

function safeInteger(value: string): number | null {
  if (value.length > 15) return null
  let result = 0
  for (let index = 0; index < value.length; index += 1) {
    result = result * 10 + (value.charCodeAt(index) - 48)
  }
  return Number.isSafeInteger(result) ? result : null
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

interface DivideWorkMeter {
  digitWork: number
}

function chargeDivideWork(
  meter: DivideWorkMeter,
  numeratorDigits: number,
  denominatorDigits: number,
): void {
  const remaining = MAX_EXACT_DIVIDE_WORK - meter.digitWork
  const factor = denominatorDigits * 10
  if (factor <= 0 || numeratorDigits > Math.floor(remaining / factor)) {
    throw new InternalExactWorkLimitError()
  }
  meter.digitWork += numeratorDigits * factor
}

function greatestCommonDivisorInteger(
  left: string,
  right: string,
  meter: DivideWorkMeter,
): string {
  let larger = left
  let smaller = right
  if (internalCompareInteger(larger, smaller) < 0) {
    larger = right
    smaller = left
  }
  while (smaller !== '0') {
    const remainder = divideInteger(larger, smaller, meter).remainder
    larger = smaller
    smaller = remainder
  }
  return larger
}

export function internalRational(
  numerator: string,
  denominator: string,
): InternalRational {
  let normalizedNumerator = normalizeInteger(numerator)
  let normalizedDenominator = normalizeInteger(denominator)
  if (normalizedNumerator === '0') return { numerator: '0', denominator: '1' }
  if (normalizedNumerator === normalizedDenominator) {
    return { numerator: '1', denominator: '1' }
  }
  let commonTrailingZeroes = 0
  const maximumTrailingZeroes = Math.min(
    normalizedNumerator.length - 1,
    normalizedDenominator.length - 1,
  )
  while (
    commonTrailingZeroes < maximumTrailingZeroes &&
    normalizedNumerator.charCodeAt(
      normalizedNumerator.length - commonTrailingZeroes - 1,
    ) === 48 &&
    normalizedDenominator.charCodeAt(
      normalizedDenominator.length - commonTrailingZeroes - 1,
    ) === 48
  ) {
    commonTrailingZeroes += 1
  }
  if (commonTrailingZeroes > 0) {
    normalizedNumerator = normalizedNumerator.slice(0, -commonTrailingZeroes)
    normalizedDenominator = normalizedDenominator.slice(
      0,
      -commonTrailingZeroes,
    )
  }
  const smallNumerator = safeInteger(normalizedNumerator)
  const smallDenominator = safeInteger(normalizedDenominator)
  if (smallNumerator !== null && smallDenominator !== null) {
    const divisor = greatestCommonDivisor(smallNumerator, smallDenominator)
    if (divisor > 1) {
      normalizedNumerator = String(smallNumerator / divisor)
      normalizedDenominator = String(smallDenominator / divisor)
    }
    return {
      numerator: normalizedNumerator,
      denominator: normalizedDenominator,
    }
  }
  const meter: DivideWorkMeter = { digitWork: 0 }
  const divisor = greatestCommonDivisorInteger(
    normalizedNumerator,
    normalizedDenominator,
    meter,
  )
  if (divisor !== '1') {
    normalizedNumerator = divideInteger(
      normalizedNumerator,
      divisor,
      meter,
    ).quotient
    normalizedDenominator = divideInteger(
      normalizedDenominator,
      divisor,
      meter,
    ).quotient
  }
  return {
    numerator: normalizedNumerator,
    denominator: normalizedDenominator,
  }
}

export const INTERNAL_ZERO: InternalRational = Object.freeze({
  numerator: '0',
  denominator: '1',
})
export const INTERNAL_ONE: InternalRational = Object.freeze({
  numerator: '1',
  denominator: '1',
})

export function internalCompareRational(
  left: InternalRational,
  right: InternalRational,
): number {
  if (left.denominator === right.denominator) {
    return internalCompareInteger(left.numerator, right.numerator)
  }
  if (left.numerator === right.numerator) {
    return -internalCompareInteger(left.denominator, right.denominator)
  }
  if (right.numerator === '1' && right.denominator === '1') {
    return internalCompareInteger(left.numerator, left.denominator)
  }
  if (left.numerator === '1' && left.denominator === '1') {
    return -internalCompareInteger(right.numerator, right.denominator)
  }
  return internalCompareInteger(
    multiplyInteger(left.numerator, right.denominator),
    multiplyInteger(right.numerator, left.denominator),
  )
}

export function internalAddRational(
  left: InternalRational,
  right: InternalRational,
): InternalRational {
  if (left.numerator === '0') return right
  if (right.numerator === '0') return left
  if (left.denominator === right.denominator) {
    return internalRational(
      internalAddInteger(left.numerator, right.numerator),
      left.denominator,
    )
  }
  return internalRational(
    internalAddInteger(
      multiplyInteger(left.numerator, right.denominator),
      multiplyInteger(right.numerator, left.denominator),
    ),
    multiplyInteger(left.denominator, right.denominator),
  )
}

export function internalSubtractRational(
  left: InternalRational,
  right: InternalRational,
): InternalRational {
  if (right.numerator === '0') return left
  if (left.denominator === right.denominator) {
    return internalRational(
      subtractInteger(left.numerator, right.numerator),
      left.denominator,
    )
  }
  return internalRational(
    subtractInteger(
      multiplyInteger(left.numerator, right.denominator),
      multiplyInteger(right.numerator, left.denominator),
    ),
    multiplyInteger(left.denominator, right.denominator),
  )
}

export function internalDivideRationalBySmall(
  value: InternalRational,
  divisor: number,
): InternalRational {
  return internalRational(
    value.numerator,
    internalMultiplySmall(value.denominator, divisor),
  )
}

export function internalDivideRational(
  value: InternalRational,
  divisor: InternalRational,
): InternalRational {
  return internalRational(
    multiplyInteger(value.numerator, divisor.denominator),
    multiplyInteger(value.denominator, divisor.numerator),
  )
}

export function internalCapOne(value: InternalRational): InternalRational {
  return internalCompareRational(value, INTERNAL_ONE) > 0 ? INTERNAL_ONE : value
}

function divideInteger(
  numerator: string,
  denominator: string,
  meter: DivideWorkMeter = { digitWork: 0 },
): { quotient: string; remainder: string } {
  if (denominator === '1') return { quotient: numerator, remainder: '0' }
  if (numerator === denominator) return { quotient: '1', remainder: '0' }
  chargeDivideWork(meter, numerator.length, denominator.length)
  let remainder = '0'
  let quotient = ''
  for (let index = 0; index < numerator.length; index += 1) {
    remainder = normalizeInteger(
      remainder === '0' ? numerator[index]! : `${remainder}${numerator[index]}`,
    )
    let digit = 0
    for (let candidate = 1; candidate <= 9; candidate += 1) {
      if (
        internalCompareInteger(
          internalMultiplySmall(denominator, candidate),
          remainder,
        ) > 0
      ) {
        break
      }
      digit = candidate
    }
    if (digit > 0) {
      remainder = subtractInteger(
        remainder,
        internalMultiplySmall(denominator, digit),
      )
    }
    quotient += String(digit)
  }
  return { quotient: normalizeInteger(quotient), remainder }
}

export function internalBasisPoints(value: InternalRational): string {
  if (value.numerator === '0') return '0'
  if (value.numerator === value.denominator) return '10000'
  if (value.numerator.length + 4 > MAX_EXACT_OUTPUT_DIGITS) {
    throw new InternalExactWorkLimitError()
  }
  const scaled = `${value.numerator}0000`
  const { quotient, remainder } = divideInteger(scaled, value.denominator)
  return internalCompareInteger(
    internalMultiplySmall(remainder, 2),
    value.denominator,
  ) >= 0
    ? internalAddInteger(quotient, '1')
    : quotient
}

export function internalPublicRatio(
  value: InternalRational,
): CanonicalExactRatio {
  return {
    numerator: value.numerator,
    denominator: value.denominator,
  }
}

export function internalAvailableMetric(value: InternalRational): {
  readonly available: true
  readonly exact: CanonicalExactRatio
  readonly basisPoints: string
} {
  return internalFreezeData({
    available: true as const,
    exact: internalPublicRatio(value),
    basisPoints: internalBasisPoints(value),
  })
}

function readRatio(
  value: unknown,
  pointer: ScoreCoverageInputIssuePointer,
): InternalRational {
  assertExactObject(value, ['numerator', 'denominator'], pointer)
  const numerator = ownValue(value, 'numerator')
  const denominator = ownValue(value, 'denominator')
  if (
    !canonicalInteger(numerator) ||
    !canonicalInteger(denominator) ||
    denominator === '0'
  ) {
    failInput(pointer, 'invalid_value', 'expected a canonical exact ratio')
  }
  return internalRational(numerator, denominator)
}

function readContribution(
  value: unknown,
  index: number,
): ScoreCoverageContributionV1 {
  const pointer = `/contributions/${index}` as const
  assertExactObject(value, ['score', 'coverage'], pointer)
  const scoreValue = ownValue(value, 'score')
  const scorePointer = `/contributions/${index}/score` as const
  const score = scoreValue === null ? null : readRatio(scoreValue, scorePointer)
  if (score !== null && internalCompareRational(score, INTERNAL_ONE) > 0) {
    failInput(scorePointer, 'incompatible', 'expected score at most one')
  }
  const coveragePointer = `/contributions/${index}/coverage` as const
  const coverageValue = ownValue(value, 'coverage')
  assertExactObject(coverageValue, ['filled', 'applicable'], coveragePointer)
  const filled = ownValue(coverageValue, 'filled')
  const applicable = ownValue(coverageValue, 'applicable')
  if (!canonicalInteger(filled) || !canonicalInteger(applicable)) {
    failInput(
      coveragePointer,
      'invalid_value',
      'expected a canonical nonnegative integer',
    )
  }
  if (internalCompareInteger(filled, applicable) > 0) {
    failInput(
      coveragePointer,
      'incompatible',
      'expected filled not greater than applicable',
    )
  }
  return {
    score: score === null ? null : internalPublicRatio(score),
    coverage: { filled, applicable },
  }
}

export function calculateScoreCoverage(input: {
  readonly contributions: readonly ScoreCoverageContributionV1[]
}): ScoreCoverageResult {
  assertExactObject(input, ['contributions'], '')
  try {
    const ledger = internalCreateExactWorkLedger()
    const rows = denseArray(
      ownValue(input, 'contributions'),
      '/contributions',
      ledger,
    )
    preflightContributionDigits(rows, ledger)
    const contributions = rows.map((row, index) => readContribution(row, index))

    let scoreTotal: InternalRational = INTERNAL_ZERO
    let scoredGoals = 0
    let filled = '0'
    let applicable = '0'
    for (const row of contributions) {
      if (row.score !== null) {
        scoreTotal = internalAddRational(scoreTotal, row.score)
        scoredGoals += 1
      }
      filled = internalAddInteger(filled, row.coverage.filled)
      applicable = internalAddInteger(applicable, row.coverage.applicable)
    }

    const monthScore: AggregateMetric =
      scoredGoals === 0
        ? {
            available: false,
            exact: null,
            basisPoints: null,
            reason: 'no_scored_goals',
          }
        : internalAvailableMetric(
            internalDivideRationalBySmall(scoreTotal, scoredGoals),
          )
    const coverage: AggregateMetric =
      applicable === '0'
        ? {
            available: false,
            exact: null,
            basisPoints: null,
            reason: 'no_fixed_units',
          }
        : internalAvailableMetric(internalRational(filled, applicable))

    return internalFreezeData({
      formulaVersion: SCORE_COVERAGE_FORMULA_VERSION,
      monthScore,
      coverage,
      totals: {
        scoredGoals: String(scoredGoals),
        filled,
        applicable,
      },
    })
  } catch (error) {
    if (error instanceof InternalExactWorkLimitError) {
      failInput(
        '/contributions',
        'input_too_complex',
        'expected exact work within budget',
      )
    }
    throw error
  }
}
