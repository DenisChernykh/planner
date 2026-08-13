import {
  CANONICAL_CALENDAR_MONTH_PATTERN,
  isCanonicalCalendarMonth,
} from '@/modules/planning/domain/planning-values'

import { TrackingQueryValidationError } from '../application/tracking-errors'

export const CANONICAL_TRACKING_MONTH_PATTERN = CANONICAL_CALENDAR_MONTH_PATTERN

export function canonicalTrackingMonthPath(value: string): string {
  if (!isCanonicalCalendarMonth(value)) {
    throw new TrackingQueryValidationError()
  }
  return value
}
