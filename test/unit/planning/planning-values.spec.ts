import { CommandValidationError } from '@/shared/application/application-command'

import {
  isValidMonthFocus,
  MONTH_FOCUS_PATTERN,
} from '@/modules/planning/domain/planning-values'
import { validateFocus } from '@/modules/planning/application/planning-command.validation'

describe('planning month focus validation', () => {
  it('rejects U+0000 while preserving non-normalizing focus semantics', () => {
    expect(new RegExp(MONTH_FOCUS_PATTERN, 'u').test('  preserved  ')).toBe(
      true,
    )
    expect(isValidMonthFocus('  preserved  ')).toBe(true)
    expect(isValidMonthFocus('\t')).toBe(true)
    expect(isValidMonthFocus('before\u0000after')).toBe(false)
    expect(() => validateFocus('before\u0000after')).toThrow(
      CommandValidationError,
    )
  })
})
