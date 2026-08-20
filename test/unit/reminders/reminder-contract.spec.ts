import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { CommandValidationError } from '@/shared/application/application-command'

import { ClaimDueOccurrences } from '@/modules/reminders/application/claim-due-occurrences.command'
import { ReminderClaimValidationError } from '@/modules/reminders/application/reminder-errors'
import type {
  ClaimDueOccurrencesInput,
  ReminderSchedulePersistencePort,
} from '@/modules/reminders/application/reminder.types'
import { snapshotSaveReminderScheduleCommand } from '@/modules/reminders/application/reminder.validation'

const memberId = '11111111-1111-4111-8111-111111111111'

describe('N01 reminder application contracts', () => {
  it('accepts disabled slots and rejects an unordered exact payload', () => {
    expect(
      snapshotSaveReminderScheduleCommand({
        commandId: memberId,
        trustedActor: { kind: 'member', id: memberId },
        payload: {
          timeZone: 'Asia/Yekaterinburg',
          morning: null,
          day: null,
          evening: null,
        },
      }).payload,
    ).toEqual({
      timeZone: 'Asia/Yekaterinburg',
      morning: null,
      day: null,
      evening: null,
    })

    expect(() =>
      snapshotSaveReminderScheduleCommand({
        commandId: memberId,
        trustedActor: { kind: 'member', id: memberId },
        payload: {
          timeZone: 'Asia/Yekaterinburg',
          morning: '18:00',
          day: '09:00',
          evening: null,
        },
      }),
    ).toThrow(CommandValidationError)
  })

  it('claims with one clock read and rejects unbounded options', async () => {
    const now = new Date('2026-03-30T03:00:00.000Z')
    const clock = new FakeProductClock(now)
    const calls: ClaimDueOccurrencesInput[] = []
    const persistence: ReminderSchedulePersistencePort = {
      saveSchedule: () => Promise.reject(new Error('unused')),
      claimDueOccurrences: (input) => {
        calls.push(input)
        return Promise.resolve([])
      },
      transitionClaim: () => Promise.resolve(false),
    }
    const transaction = { run: <T>(operation: () => Promise<T>) => operation() }
    const command = new ClaimDueOccurrences(persistence, clock, transaction)
    await expect(
      command.execute({
        leaseOwner: 'worker-a',
        limit: 10,
        leaseDurationMs: 1_000,
      }),
    ).resolves.toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.now).toEqual(now)
    await expect(
      command.execute({
        leaseOwner: 'worker-a',
        limit: 101,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ReminderClaimValidationError)
  })
})
