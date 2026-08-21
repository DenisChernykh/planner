import { settleReminderAttempt } from '@/modules/reminders/application/reminder-retry.policy'

const now = new Date('2026-03-30T05:00:00.000Z')
const expiresAt = new Date('2026-03-30T09:00:00.000Z')

describe('N05 reminder retry policy', () => {
  it('uses provider retry_after and keeps a retryable attempt pending', () => {
    expect(
      settleReminderAttempt({
        outcome: {
          kind: 'retryable',
          reason: 'rate_limited',
          retryAfterSeconds: 7,
        },
        attemptsUsed: 1,
        now,
        expiresAt,
      }),
    ).toEqual({
      persistedOutcome: {
        kind: 'retryable',
        reason: 'rate_limited',
        retryAfterSeconds: 7,
      },
      nextAttemptAt: new Date('2026-03-30T05:00:07.000Z'),
      occurrenceState: 'pending',
    })
  })

  it('uses the 30 second default and terminalizes at three attempts or expiry without rewriting the provider result', () => {
    const defaultDelay = settleReminderAttempt({
      outcome: {
        kind: 'retryable',
        reason: 'provider_error',
        retryAfterSeconds: null,
      },
      attemptsUsed: 2,
      now,
      expiresAt,
    })
    expect(defaultDelay.nextAttemptAt).toEqual(
      new Date('2026-03-30T05:00:30.000Z'),
    )
    expect(defaultDelay.occurrenceState).toBe('pending')

    expect(
      settleReminderAttempt({
        outcome: {
          kind: 'retryable',
          reason: 'provider_error',
          retryAfterSeconds: null,
        },
        attemptsUsed: 3,
        now,
        expiresAt,
      }),
    ).toEqual({
      persistedOutcome: {
        kind: 'retryable',
        reason: 'provider_error',
        retryAfterSeconds: 30,
      },
      nextAttemptAt: null,
      occurrenceState: 'terminal',
    })

    expect(
      settleReminderAttempt({
        outcome: {
          kind: 'retryable',
          reason: 'rate_limited',
          retryAfterSeconds: 7,
        },
        attemptsUsed: 1,
        now: new Date('2026-03-30T08:59:55.000Z'),
        expiresAt,
      }),
    ).toEqual({
      persistedOutcome: {
        kind: 'retryable',
        reason: 'rate_limited',
        retryAfterSeconds: 7,
      },
      nextAttemptAt: null,
      occurrenceState: 'terminal',
    })
  })
})
