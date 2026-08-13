const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const CANONICAL_CALENDAR_MONTH_PATTERN =
  '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$'
const CANONICAL_MONTH = new RegExp(CANONICAL_CALENDAR_MONTH_PATTERN)

export function isCanonicalCalendarMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_MONTH.test(value)) return false
  const year = Number(value.slice(0, 4))
  return year >= 1 && year <= 9999
}

export function isCanonicalPlanningUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value)
}

export function isValidMonthFocus(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.replace(/^ +| +$/g, '').length > 0 &&
    Array.from(value).length <= 500
  )
}
