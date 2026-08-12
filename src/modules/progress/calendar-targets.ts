export const CALENDAR_TARGETS_FORMULA_VERSION =
  'planner.calendar-targets.v1' as const

const PLANNER_CALENDAR_TIME_ZONE = 'Asia/Yekaterinburg' as const
const CALENDAR_WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const

export type CalendarWeekday = (typeof CALENDAR_WEEKDAYS)[number]

export type CalendarRepetitionV1 =
  | { kind: 'daily' }
  | { kind: 'weekdays'; weekdays: readonly CalendarWeekday[] }
  | { kind: 'weekly'; n: string }
  | { kind: 'monthly'; n: string }
  | { kind: 'one_off'; dueDate: string }
  | {
      kind: 'weekly_planned_task'
      weekOrdinal: '1' | '2' | '3' | '4' | '5'
    }

export interface CalendarTargetsInput {
  targetMonth: string
  activeLocalDate: string
  timeZone: typeof PLANNER_CALENDAR_TIME_ZONE
  repetition: CalendarRepetitionV1
}

export type CalendarTargetsInputIssueCode =
  'invalid_type' | 'invalid_value' | 'unexpected_property'

export type CalendarTargetsInputIssuePointer =
  | ''
  | '/targetMonth'
  | '/activeLocalDate'
  | '/timeZone'
  | '/repetition'
  | '/repetition/kind'
  | '/repetition/weekdays'
  | '/repetition/n'
  | '/repetition/dueDate'
  | '/repetition/weekOrdinal'
  | '/n'
  | '/periodDays'
  | '/activeDays'
  | '/eligibleDays'
  | '/period'
  | '/period/cadence'
  | '/period/ordinal'
  | '/period/periodStart'
  | '/period/periodEnd'
  | '/period/periodDays'
  | '/period/activeDates'
  | '/period/eligibleDates'
  | '/period/periodTarget'
  | '/asOfLocalDate'

export type CalendarTargetsIssueDetail =
  | 'expected a plain object'
  | 'expected exact properties'
  | 'expected a supported repetition kind'
  | 'expected a canonical target month'
  | 'expected a canonical local date'
  | 'expected activation inside target month'
  | 'expected Asia/Yekaterinburg'
  | 'expected canonical weekday order'
  | 'expected a canonical positive decimal'
  | 'expected a supported week ordinal'
  | 'expected a safe integer count'
  | 'expected a valid count relationship'
  | 'expected a quota cadence'
  | 'expected a canonical quota period'
  | 'expected ascending unique period dates'
  | 'expected dates inside period'
  | 'expected active and eligible dates to match'
  | 'expected a valid period target'
  | 'due date is outside target month'
  | 'week ordinal is not present in target month'

export interface CalendarTargetsInputIssue {
  readonly pointer: CalendarTargetsInputIssuePointer
  readonly code: CalendarTargetsInputIssueCode
  readonly detail: CalendarTargetsIssueDetail
}

export class CalendarTargetsInputError extends Error {
  readonly issues: readonly [
    CalendarTargetsInputIssue,
    ...CalendarTargetsInputIssue[],
  ]

  constructor(
    issues: readonly [
      CalendarTargetsInputIssue,
      ...CalendarTargetsInputIssue[],
    ],
  ) {
    super('Invalid calendar targets input')
    this.name = 'CalendarTargetsInputError'
    this.issues = freezeData(
      issues.map((issue) => ({ ...issue })),
    ) as unknown as readonly [
      CalendarTargetsInputIssue,
      ...CalendarTargetsInputIssue[],
    ]
  }
}

export interface QuotaCalendarPeriod {
  readonly cadence: 'weekly' | 'monthly'
  readonly ordinal: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodDays: number
  readonly activeDates: readonly string[]
  readonly eligibleDates: readonly string[]
  readonly periodTarget: number
}

interface CalendarContext {
  readonly targetMonth: string
  readonly activeLocalDate: string
  readonly timeZone: typeof PLANNER_CALENDAR_TIME_ZONE
}

export interface FixedCalendar extends CalendarContext {
  readonly kind: 'fixed'
  readonly expectationDates: readonly string[]
}

export interface QuotaCalendar extends CalendarContext {
  readonly kind: 'quota'
  readonly cadence: 'weekly' | 'monthly'
  readonly periods: readonly QuotaCalendarPeriod[]
}

export interface WeeklyPlannedTaskPeriod {
  readonly cadence: 'weekly'
  readonly ordinal: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodTarget: 1
}

export interface WeeklyPlannedTaskCalendar extends CalendarContext {
  readonly kind: 'weekly_planned_task'
  readonly periods: readonly WeeklyPlannedTaskPeriod[]
}

export type EligibleCalendar =
  FixedCalendar | QuotaCalendar | WeeklyPlannedTaskCalendar

export type CalendarEligibilityIssue =
  | {
      readonly pointer: '/repetition/dueDate'
      readonly code: 'incompatible'
      readonly detail: 'due date is outside target month'
    }
  | {
      readonly pointer: '/repetition/weekOrdinal'
      readonly code: 'incompatible'
      readonly detail: 'week ordinal is not present in target month'
    }

export type EligibleCalendarResult =
  | {
      readonly formulaVersion: typeof CALENDAR_TARGETS_FORMULA_VERSION
      readonly eligible: true
      readonly calendar: EligibleCalendar
      readonly issues: readonly []
    }
  | {
      readonly formulaVersion: typeof CALENDAR_TARGETS_FORMULA_VERSION
      readonly eligible: false
      readonly calendar: null
      readonly issues: readonly [CalendarEligibilityIssue]
    }

export interface PeriodTargetInput {
  n: string
  periodDays: number
  activeDays: number
  eligibleDays: number
}

export interface ExpectedPaceInput {
  period: QuotaCalendarPeriod
  asOfLocalDate: string
}

interface MonthParts {
  year: number
  month: number
}

interface LocalDateParts extends MonthParts {
  day: number
}

interface MonthWeekSegment {
  ordinal: number
  periodStart: string
  periodEnd: string
  dates: readonly string[]
}

type PlainObject = Record<PropertyKey, unknown>

function freezeData<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeData(item)
    }
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor) {
        freezeData(descriptor.value)
      }
    }
    return Object.freeze(value)
  }
  return value
}

function failInput(
  pointer: CalendarTargetsInputIssuePointer,
  code: CalendarTargetsInputIssueCode,
  detail: CalendarTargetsIssueDetail,
): never {
  throw new CalendarTargetsInputError([{ pointer, code, detail }])
}

function assertPlainObject(
  value: unknown,
  pointer: CalendarTargetsInputIssuePointer,
): asserts value is PlainObject {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
}

function assertExactPlainObject(
  value: unknown,
  expectedKeys: readonly string[],
  pointer: CalendarTargetsInputIssuePointer,
): asserts value is PlainObject {
  assertPlainObject(value, pointer)
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    failInput(pointer, 'unexpected_property', 'expected exact properties')
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a plain object')
    }
  }
}

function ownValue(object: PlainObject, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined
}

function readPlainArray(
  value: unknown,
  pointer: CalendarTargetsInputIssuePointer,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    failInput(pointer, 'invalid_type', 'expected a plain object')
  }
  const keys = Reflect.ownKeys(value)
  const allowedKeys = new Set<PropertyKey>(['length'])
  for (let index = 0; index < value.length; index += 1) {
    allowedKeys.add(String(index))
  }
  if (keys.some((key) => !allowedKeys.has(key))) {
    failInput(pointer, 'unexpected_property', 'expected exact properties')
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      failInput(pointer, 'invalid_type', 'expected a plain object')
    }
  }
  return value
}

function parseTargetMonth(value: unknown): MonthParts | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (match === null) {
    return null
  }
  const year = decimalDigitsToNumber(match[1]!)
  const month = decimalDigitsToNumber(match[2]!)
  return year >= 1 && year <= 9_999 && month >= 1 && month <= 12
    ? { year, month }
    : null
}

function parseLocalDate(value: unknown): LocalDateParts | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) {
    return null
  }
  const year = decimalDigitsToNumber(match[1]!)
  const month = decimalDigitsToNumber(match[2]!)
  const day = decimalDigitsToNumber(match[3]!)
  if (
    year < 1 ||
    year > 9_999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null
  }
  return { year, month, day }
}

function decimalDigitsToNumber(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index += 1) {
    result = result * 10 + (value.charCodeAt(index) - 48)
  }
  return result
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function formatLocalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function monthDates(parts: MonthParts): readonly string[] {
  const result: string[] = []
  for (let day = 1; day <= daysInMonth(parts.year, parts.month); day += 1) {
    result.push(formatLocalDate(parts.year, parts.month, day))
  }
  return result
}

function daysBeforeMonth(year: number, month: number): number {
  let result = 0
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    result += daysInMonth(year, currentMonth)
  }
  return result
}

function weekdayIndex(parts: LocalDateParts): number {
  const previousYears = parts.year - 1
  const daysBeforeYear =
    previousYears * 365 +
    Math.floor(previousYears / 4) -
    Math.floor(previousYears / 100) +
    Math.floor(previousYears / 400)
  return (
    (daysBeforeYear +
      daysBeforeMonth(parts.year, parts.month) +
      parts.day -
      1) %
    7
  )
}

function monthWeekSegments(parts: MonthParts): readonly MonthWeekSegment[] {
  const dates = monthDates(parts)
  const firstWeekday = weekdayIndex({ ...parts, day: 1 })
  const result: MonthWeekSegment[] = []
  let firstDay = 1
  let ordinal = 1
  while (firstDay <= dates.length) {
    const segmentLength =
      firstDay === 1 ? Math.min(7 - firstWeekday, dates.length) : 7
    const lastDay = Math.min(firstDay + segmentLength - 1, dates.length)
    result.push({
      ordinal,
      periodStart: dates[firstDay - 1]!,
      periodEnd: dates[lastDay - 1]!,
      dates: dates.slice(firstDay - 1, lastDay),
    })
    firstDay = lastDay + 1
    ordinal += 1
  }
  return result
}

function assertCanonicalPositiveDecimal(
  value: unknown,
  pointer: CalendarTargetsInputIssuePointer,
): asserts value is string {
  if (typeof value !== 'string') {
    failInput(pointer, 'invalid_type', 'expected a canonical positive decimal')
  }
  if (!/^[1-9]\d*$/.test(value)) {
    failInput(pointer, 'invalid_value', 'expected a canonical positive decimal')
  }
}

function assertSafeInteger(
  value: unknown,
  pointer: CalendarTargetsInputIssuePointer,
): asserts value is number {
  if (typeof value !== 'number') {
    failInput(pointer, 'invalid_type', 'expected a safe integer count')
  }
  if (!Number.isSafeInteger(value)) {
    failInput(pointer, 'invalid_value', 'expected a safe integer count')
  }
}

function decimalExceedsSafeBound(value: string, bound: number): boolean {
  const boundText = String(bound)
  return (
    value.length > boundText.length ||
    (value.length === boundText.length && value > boundText)
  )
}

export function calculatePeriodTarget(input: PeriodTargetInput): number {
  assertExactPlainObject(
    input,
    ['n', 'periodDays', 'activeDays', 'eligibleDays'],
    '',
  )
  const n = ownValue(input, 'n')
  const periodDays = ownValue(input, 'periodDays')
  const activeDays = ownValue(input, 'activeDays')
  const eligibleDays = ownValue(input, 'eligibleDays')
  assertCanonicalPositiveDecimal(n, '/n')
  assertSafeInteger(periodDays, '/periodDays')
  assertSafeInteger(activeDays, '/activeDays')
  assertSafeInteger(eligibleDays, '/eligibleDays')
  if (periodDays < 1 || periodDays > 366) {
    failInput(
      '/periodDays',
      'invalid_value',
      'expected a valid count relationship',
    )
  }
  if (activeDays < 0 || activeDays > periodDays) {
    failInput(
      '/activeDays',
      'invalid_value',
      'expected a valid count relationship',
    )
  }
  if (eligibleDays < 0 || eligibleDays > activeDays) {
    failInput(
      '/eligibleDays',
      'invalid_value',
      'expected a valid count relationship',
    )
  }
  if (activeDays === 0 || eligibleDays === 0) {
    return 0
  }

  const saturationBound = 2 * periodDays * eligibleDays
  if (decimalExceedsSafeBound(n, saturationBound)) {
    return eligibleDays
  }
  const boundedN = decimalDigitsToNumber(n)
  const rounded = Math.floor(
    (2 * boundedN * activeDays + periodDays) / (2 * periodDays),
  )
  return Math.min(Math.max(1, rounded), eligibleDays)
}

function readCalendarRepetition(value: unknown): CalendarRepetitionV1 {
  assertPlainObject(value, '/repetition')
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind')
  if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
    failInput(
      '/repetition/kind',
      'invalid_type',
      'expected a supported repetition kind',
    )
  }
  const kind: unknown = kindDescriptor.value as unknown
  if (kind === 'daily') {
    assertExactPlainObject(value, ['kind'], '/repetition')
    return { kind }
  }
  if (kind === 'weekdays') {
    assertExactPlainObject(value, ['kind', 'weekdays'], '/repetition')
    const weekdays = readPlainArray(
      ownValue(value, 'weekdays'),
      '/repetition/weekdays',
    )
    if (weekdays.length < 1 || weekdays.length > CALENDAR_WEEKDAYS.length) {
      failInput(
        '/repetition/weekdays',
        'invalid_value',
        'expected canonical weekday order',
      )
    }
    let previousIndex = -1
    const result: CalendarWeekday[] = []
    for (const weekday of weekdays) {
      const currentIndex =
        typeof weekday === 'string'
          ? CALENDAR_WEEKDAYS.indexOf(weekday as CalendarWeekday)
          : -1
      if (currentIndex <= previousIndex) {
        failInput(
          '/repetition/weekdays',
          'invalid_value',
          'expected canonical weekday order',
        )
      }
      previousIndex = currentIndex
      result.push(CALENDAR_WEEKDAYS[currentIndex]!)
    }
    return { kind, weekdays: result }
  }
  if (kind === 'weekly' || kind === 'monthly') {
    assertExactPlainObject(value, ['kind', 'n'], '/repetition')
    const n = ownValue(value, 'n')
    assertCanonicalPositiveDecimal(n, '/repetition/n')
    return { kind, n }
  }
  if (kind === 'one_off') {
    assertExactPlainObject(value, ['kind', 'dueDate'], '/repetition')
    const dueDate = ownValue(value, 'dueDate')
    assertCanonicalLocalDate(dueDate, '/repetition/dueDate')
    return { kind, dueDate }
  }
  if (kind === 'weekly_planned_task') {
    assertExactPlainObject(value, ['kind', 'weekOrdinal'], '/repetition')
    const weekOrdinal = ownValue(value, 'weekOrdinal')
    if (
      weekOrdinal !== '1' &&
      weekOrdinal !== '2' &&
      weekOrdinal !== '3' &&
      weekOrdinal !== '4' &&
      weekOrdinal !== '5'
    ) {
      failInput(
        '/repetition/weekOrdinal',
        typeof weekOrdinal === 'string' ? 'invalid_value' : 'invalid_type',
        'expected a supported week ordinal',
      )
    }
    return { kind, weekOrdinal }
  }
  failInput(
    '/repetition/kind',
    typeof kind === 'string' ? 'invalid_value' : 'invalid_type',
    'expected a supported repetition kind',
  )
}

function readCalendarInput(input: CalendarTargetsInput): {
  targetMonth: string
  month: MonthParts
  activeLocalDate: string
  timeZone: typeof PLANNER_CALENDAR_TIME_ZONE
  repetition: CalendarRepetitionV1
} {
  assertExactPlainObject(
    input,
    ['targetMonth', 'activeLocalDate', 'timeZone', 'repetition'],
    '',
  )
  const targetMonth = ownValue(input, 'targetMonth')
  const activeLocalDate = ownValue(input, 'activeLocalDate')
  const timeZone = ownValue(input, 'timeZone')
  const repetition = ownValue(input, 'repetition')
  const month = parseTargetMonth(targetMonth)
  if (month === null) {
    failInput(
      '/targetMonth',
      typeof targetMonth === 'string' ? 'invalid_value' : 'invalid_type',
      'expected a canonical target month',
    )
  }
  const active = parseLocalDate(activeLocalDate)
  if (active === null) {
    failInput(
      '/activeLocalDate',
      typeof activeLocalDate === 'string' ? 'invalid_value' : 'invalid_type',
      'expected a canonical local date',
    )
  }
  if (active.year !== month.year || active.month !== month.month) {
    failInput(
      '/activeLocalDate',
      'invalid_value',
      'expected activation inside target month',
    )
  }
  if (timeZone !== PLANNER_CALENDAR_TIME_ZONE) {
    failInput(
      '/timeZone',
      typeof timeZone === 'string' ? 'invalid_value' : 'invalid_type',
      'expected Asia/Yekaterinburg',
    )
  }
  return {
    targetMonth: targetMonth as string,
    month,
    activeLocalDate: activeLocalDate as string,
    timeZone,
    repetition: readCalendarRepetition(repetition),
  }
}

function eligibleResult(calendar: EligibleCalendar): EligibleCalendarResult {
  return freezeData({
    formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
    eligible: true as const,
    calendar,
    issues: [] as const,
  })
}

function incompatibleResult(
  issue: CalendarEligibilityIssue,
): EligibleCalendarResult {
  return freezeData({
    formulaVersion: CALENDAR_TARGETS_FORMULA_VERSION,
    eligible: false as const,
    calendar: null,
    issues: [issue] as const,
  })
}

export function calculateEligibleCalendar(
  input: CalendarTargetsInput,
): EligibleCalendarResult {
  const context = readCalendarInput(input)
  const allDates = monthDates(context.month)
  const activeDates = allDates.filter((date) => date >= context.activeLocalDate)
  const calendarContext: CalendarContext = {
    targetMonth: context.targetMonth,
    activeLocalDate: context.activeLocalDate,
    timeZone: context.timeZone,
  }

  if (context.repetition.kind === 'daily') {
    return eligibleResult({
      ...calendarContext,
      kind: 'fixed',
      expectationDates: activeDates.slice(),
    })
  }
  if (context.repetition.kind === 'weekdays') {
    const selected = new Set(context.repetition.weekdays)
    return eligibleResult({
      ...calendarContext,
      kind: 'fixed',
      expectationDates: activeDates.filter((date) => {
        const parsed = parseLocalDate(date)!
        return selected.has(CALENDAR_WEEKDAYS[weekdayIndex(parsed)]!)
      }),
    })
  }
  if (context.repetition.kind === 'one_off') {
    if (!context.repetition.dueDate.startsWith(`${context.targetMonth}-`)) {
      return incompatibleResult({
        pointer: '/repetition/dueDate',
        code: 'incompatible',
        detail: 'due date is outside target month',
      })
    }
    return eligibleResult({
      ...calendarContext,
      kind: 'fixed',
      expectationDates:
        context.repetition.dueDate >= context.activeLocalDate
          ? [context.repetition.dueDate]
          : [],
    })
  }

  const segments = monthWeekSegments(context.month)
  if (context.repetition.kind === 'weekly_planned_task') {
    const ordinal = decimalDigitsToNumber(context.repetition.weekOrdinal)
    const segment = segments[ordinal - 1]
    if (segment === undefined) {
      return incompatibleResult({
        pointer: '/repetition/weekOrdinal',
        code: 'incompatible',
        detail: 'week ordinal is not present in target month',
      })
    }
    const periods: WeeklyPlannedTaskPeriod[] =
      segment.periodEnd < context.activeLocalDate
        ? []
        : [
            {
              cadence: 'weekly',
              ordinal,
              periodStart: segment.periodStart,
              periodEnd: segment.periodEnd,
              periodTarget: 1,
            },
          ]
    return eligibleResult({
      ...calendarContext,
      kind: 'weekly_planned_task',
      periods,
    })
  }

  if (context.repetition.kind === 'weekly') {
    const n = context.repetition.n
    const periods = segments.map((segment): QuotaCalendarPeriod => {
      const dates = segment.dates.filter(
        (date) => date >= context.activeLocalDate,
      )
      return {
        cadence: 'weekly',
        ordinal: segment.ordinal,
        periodStart: segment.periodStart,
        periodEnd: segment.periodEnd,
        periodDays: 7,
        activeDates: dates.slice(),
        eligibleDates: dates.slice(),
        periodTarget: calculatePeriodTarget({
          n,
          periodDays: 7,
          activeDays: dates.length,
          eligibleDays: dates.length,
        }),
      }
    })
    return eligibleResult({
      ...calendarContext,
      kind: 'quota',
      cadence: 'weekly',
      periods,
    })
  }

  const periodDays = allDates.length
  const period: QuotaCalendarPeriod = {
    cadence: 'monthly',
    ordinal: 1,
    periodStart: allDates[0]!,
    periodEnd: allDates[periodDays - 1]!,
    periodDays,
    activeDates: activeDates.slice(),
    eligibleDates: activeDates.slice(),
    periodTarget: calculatePeriodTarget({
      n: context.repetition.n,
      periodDays,
      activeDays: activeDates.length,
      eligibleDays: activeDates.length,
    }),
  }
  return eligibleResult({
    ...calendarContext,
    kind: 'quota',
    cadence: 'monthly',
    periods: [period],
  })
}

function assertCanonicalLocalDate(
  value: unknown,
  pointer: CalendarTargetsInputIssuePointer,
): asserts value is string {
  if (parseLocalDate(value) === null) {
    failInput(
      pointer,
      typeof value === 'string' ? 'invalid_value' : 'invalid_type',
      'expected a canonical local date',
    )
  }
}

function readPeriodDates(
  value: unknown,
  pointer: '/period/activeDates' | '/period/eligibleDates',
  periodStart: string,
  periodEnd: string,
): readonly string[] {
  const dates = readPlainArray(value, pointer)
  let previous: string | null = null
  const result: string[] = []
  for (const date of dates) {
    if (parseLocalDate(date) === null || typeof date !== 'string') {
      failInput(
        pointer,
        'invalid_value',
        'expected ascending unique period dates',
      )
    }
    if (previous !== null && date <= previous) {
      failInput(
        pointer,
        'invalid_value',
        'expected ascending unique period dates',
      )
    }
    if (date < periodStart || date > periodEnd) {
      failInput(pointer, 'invalid_value', 'expected dates inside period')
    }
    previous = date
    result.push(date)
  }
  return result
}

function sameDates(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((date, index) => date === right[index])
  )
}

function readQuotaPeriod(value: unknown): QuotaCalendarPeriod {
  assertExactPlainObject(
    value,
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
    '/period',
  )
  const cadence = ownValue(value, 'cadence')
  const ordinal = ownValue(value, 'ordinal')
  const periodStart = ownValue(value, 'periodStart')
  const periodEnd = ownValue(value, 'periodEnd')
  const periodDays = ownValue(value, 'periodDays')
  const periodTarget = ownValue(value, 'periodTarget')
  if (cadence !== 'weekly' && cadence !== 'monthly') {
    failInput('/period/cadence', 'invalid_value', 'expected a quota cadence')
  }
  assertSafeInteger(ordinal, '/period/ordinal')
  assertCanonicalLocalDate(periodStart, '/period/periodStart')
  assertCanonicalLocalDate(periodEnd, '/period/periodEnd')
  assertSafeInteger(periodDays, '/period/periodDays')
  if (
    periodStart > periodEnd ||
    periodStart.slice(0, 7) !== periodEnd.slice(0, 7)
  ) {
    failInput('/period', 'invalid_value', 'expected a canonical quota period')
  }
  const start = parseLocalDate(periodStart)!
  const end = parseLocalDate(periodEnd)!
  const segments = monthWeekSegments({ year: start.year, month: start.month })
  if (cadence === 'weekly') {
    const expected = segments[ordinal - 1]
    if (
      ordinal < 1 ||
      ordinal > 6 ||
      periodDays !== 7 ||
      expected?.periodStart !== periodStart ||
      expected.periodEnd !== periodEnd
    ) {
      failInput('/period', 'invalid_value', 'expected a canonical quota period')
    }
  } else if (
    ordinal !== 1 ||
    start.day !== 1 ||
    end.day !== daysInMonth(end.year, end.month) ||
    periodDays !== daysInMonth(end.year, end.month)
  ) {
    failInput('/period', 'invalid_value', 'expected a canonical quota period')
  }
  const eligibleDates = readPeriodDates(
    ownValue(value, 'eligibleDates'),
    '/period/eligibleDates',
    periodStart,
    periodEnd,
  )
  const activeDates = readPeriodDates(
    ownValue(value, 'activeDates'),
    '/period/activeDates',
    periodStart,
    periodEnd,
  )
  if (!sameDates(activeDates, eligibleDates)) {
    failInput(
      '/period/eligibleDates',
      'invalid_value',
      'expected active and eligible dates to match',
    )
  }
  const canonicalDates =
    cadence === 'weekly'
      ? monthWeekSegments({ year: start.year, month: start.month })[
          ordinal - 1
        ]!.dates
      : monthDates({ year: start.year, month: start.month })
  const canonicalActiveDates =
    activeDates.length === 0
      ? []
      : canonicalDates.slice(canonicalDates.indexOf(activeDates[0]!))
  if (!sameDates(activeDates, canonicalActiveDates)) {
    failInput(
      '/period/activeDates',
      'invalid_value',
      'expected a canonical quota period',
    )
  }
  assertSafeInteger(periodTarget, '/period/periodTarget')
  if (
    periodTarget < 0 ||
    periodTarget > eligibleDates.length ||
    (eligibleDates.length === 0 ? periodTarget !== 0 : periodTarget === 0)
  ) {
    failInput(
      '/period/periodTarget',
      'invalid_value',
      'expected a valid period target',
    )
  }
  return {
    cadence,
    ordinal,
    periodStart,
    periodEnd,
    periodDays,
    activeDates,
    eligibleDates,
    periodTarget,
  }
}

export function calculateExpectedPace(input: ExpectedPaceInput): number {
  assertExactPlainObject(input, ['period', 'asOfLocalDate'], '')
  const period = readQuotaPeriod(ownValue(input, 'period'))
  const asOfLocalDate = ownValue(input, 'asOfLocalDate')
  assertCanonicalLocalDate(asOfLocalDate, '/asOfLocalDate')
  if (period.eligibleDates.length === 0) {
    return 0
  }
  let elapsedEligibleDays = 0
  for (const date of period.eligibleDates) {
    if (date <= asOfLocalDate) {
      elapsedEligibleDays += 1
    }
  }
  if (elapsedEligibleDays === 0) {
    return 0
  }
  const rounded = Math.floor(
    (2 * period.periodTarget * elapsedEligibleDays +
      period.eligibleDates.length) /
      (2 * period.eligibleDates.length),
  )
  return Math.min(rounded, period.periodTarget)
}
