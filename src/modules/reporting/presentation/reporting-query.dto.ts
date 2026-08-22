import { isCanonicalCalendarMonth } from '@/modules/planning/domain/planning-values'

import { PilotReportQueryValidationError } from '../application/pilot-report.errors'

export const CANONICAL_REPORT_MONTH_PATTERN =
  '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$'

export function canonicalReportMonthPath(value: string): string {
  if (!isCanonicalCalendarMonth(value)) {
    throw new PilotReportQueryValidationError()
  }
  return value
}
