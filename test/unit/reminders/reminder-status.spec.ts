import { projectReminderDeliveryStatus } from '@/modules/reminders/infrastructure/prisma-reminder-settings.read.persistence'

describe('N04 reminder delivery status projection', () => {
  it('maps provider outcomes to the three web states', () => {
    expect(projectReminderDeliveryStatus(undefined)).toBe('available')
    expect(
      projectReminderDeliveryStatus({
        outcome: 'accepted',
        outcome_reason: null,
      }),
    ).toBe('available')
    expect(
      projectReminderDeliveryStatus({
        outcome: 'terminal',
        outcome_reason: 'blocked',
      }),
    ).toBe('blocked')
    expect(
      projectReminderDeliveryStatus({
        outcome: 'terminal',
        outcome_reason: 'chat_not_found',
      }),
    ).toBe('blocked')
    for (const value of [
      { outcome: 'retryable', outcome_reason: 'provider_error' },
      { outcome: 'ambiguous', outcome_reason: 'timeout' },
      { outcome: 'terminal', outcome_reason: 'provider_rejected' },
    ]) {
      expect(projectReminderDeliveryStatus(value)).toBe('connection_lost')
    }
  })

  it('does not elevate local expiry or supersession to a connection warning', () => {
    expect(
      projectReminderDeliveryStatus({
        outcome: 'terminal',
        outcome_reason: 'expired',
      }),
    ).toBe('available')
    expect(
      projectReminderDeliveryStatus({
        outcome: 'terminal',
        outcome_reason: 'superseded',
      }),
    ).toBe('available')
  })
})
