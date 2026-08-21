import {
  REMINDER_MAX_ATTEMPTS,
  REMINDER_RETRY_DELAY_MS,
} from './reminder.types'
import type { TelegramAttemptOutcome } from './reminder.types'

export type ReminderRetryDecision = {
  readonly persistedOutcome: TelegramAttemptOutcome
  readonly nextAttemptAt: Date | null
  readonly occurrenceState: 'pending' | 'terminal'
}

export function settleReminderAttempt(input: {
  readonly outcome: TelegramAttemptOutcome
  readonly attemptsUsed: number
  readonly now: Date
  readonly expiresAt: Date
}): ReminderRetryDecision {
  if (input.outcome.kind !== 'retryable') {
    return {
      persistedOutcome: input.outcome,
      nextAttemptAt: null,
      occurrenceState: 'terminal',
    }
  }
  const retryAfterSeconds =
    input.outcome.retryAfterSeconds !== null &&
    Number.isSafeInteger(input.outcome.retryAfterSeconds) &&
    input.outcome.retryAfterSeconds > 0
      ? input.outcome.retryAfterSeconds
      : REMINDER_RETRY_DELAY_MS / 1_000
  const nextAttemptAt = new Date(
    input.now.getTime() + retryAfterSeconds * 1_000,
  )
  if (
    input.attemptsUsed >= REMINDER_MAX_ATTEMPTS ||
    nextAttemptAt >= input.expiresAt
  ) {
    return {
      // The provider's result is immutable ledger evidence.  Expiry and the
      // retry cap terminalize the occurrence, rather than rewriting it.
      persistedOutcome: {
        ...input.outcome,
        retryAfterSeconds,
      },
      nextAttemptAt: null,
      occurrenceState: 'terminal',
    }
  }
  return {
    persistedOutcome: {
      ...input.outcome,
      retryAfterSeconds,
    },
    nextAttemptAt,
    occurrenceState: 'pending',
  }
}
