import { RunDueRemindersCycle } from '@/modules/reminders/application/run-due-reminders.cycle'
import type {
  ReminderOccurrenceClaim,
  ReminderIntentBuildResult,
} from '@/modules/reminders/application/reminder.types'

const claim = (id: string): ReminderOccurrenceClaim => ({
  occurrenceId: id,
  recipientMemberId: '44444444-4444-4444-8444-444444444444',
  localDate: '2026-03-30',
  slotKind: 'morning',
  dueAt: new Date('2026-03-30T04:00:00.000Z'),
  expiresAt: new Date('2026-03-30T09:00:00.000Z'),
  fencingToken: 3n,
})

const prepared: ReminderIntentBuildResult = {
  kind: 'prepared',
  occurrenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  intentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  attemptId: 'f1111111-1111-4111-8111-111111111111',
  intentRevision: 1n,
  contentHash: 'a'.repeat(64),
  expiresAt: new Date('2026-03-30T09:00:00.000Z'),
}

describe('N05 RunDueRemindersCycle', () => {
  it('claims a bounded batch and runs reread before delivery', async () => {
    const claims = [
      claim(prepared.occurrenceId),
      claim('dddddddd-dddd-4ddd-8ddd-ddddddddddde'),
    ]
    const claimDueOccurrences = {
      execute: jest.fn().mockResolvedValue(claims),
    }
    const buildReminderIntent = {
      execute: jest
        .fn<
          Promise<ReminderIntentBuildResult>,
          [{ claim: ReminderOccurrenceClaim; leaseOwner: string }]
        >()
        .mockResolvedValueOnce(prepared)
        .mockResolvedValueOnce({
          kind: 'suppressed',
          occurrenceId: claims[1]!.occurrenceId,
          reason: 'nothing_relevant',
        }),
    }
    type DeliveryInput = {
      readonly claim: ReminderOccurrenceClaim
      readonly leaseOwner: string
      readonly intentId: string
      readonly attemptId: string
      readonly signal: AbortSignal
    }
    let deliveryInput: DeliveryInput | undefined
    const deliverReminder = {
      execute: jest.fn((input: DeliveryInput): Promise<void> => {
        deliveryInput = input
        return Promise.resolve()
      }),
    }
    const cycle = new RunDueRemindersCycle(
      claimDueOccurrences as never,
      buildReminderIntent as never,
      deliverReminder as never,
      () => 'planner-reminders:test-owner',
    )

    await expect(cycle.execute(new AbortController().signal)).resolves.toEqual({
      claimed: 2,
      suppressed: 1,
      prepared: 1,
      delivered: 1,
    })
    expect(claimDueOccurrences.execute).toHaveBeenCalledWith({
      leaseOwner: 'planner-reminders:test-owner',
      limit: 10,
      leaseDurationMs: 120_000,
    })
    expect(buildReminderIntent.execute).toHaveBeenNthCalledWith(1, {
      claim: claims[0],
      leaseOwner: 'planner-reminders:test-owner',
    })
    expect(deliveryInput).toMatchObject({
      claim: claims[0],
      leaseOwner: 'planner-reminders:test-owner',
      intentId: prepared.intentId,
      attemptId: prepared.attemptId,
    })
    expect(deliveryInput?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not claim after shutdown and ignores a stale fenced claim', async () => {
    const controller = new AbortController()
    const claimDueOccurrences = { execute: jest.fn() }
    const cycle = new RunDueRemindersCycle(
      claimDueOccurrences as never,
      { execute: jest.fn() } as never,
      { execute: jest.fn() } as never,
    )
    controller.abort()
    await expect(cycle.execute(controller.signal)).resolves.toEqual({
      claimed: 0,
      suppressed: 0,
      prepared: 0,
      delivered: 0,
    })
    expect(claimDueOccurrences.execute).not.toHaveBeenCalled()
  })

  it('keeps a prepared attempt for recovery when shutdown arrives after reread', async () => {
    const controller = new AbortController()
    const buildReminderIntent = {
      execute: jest.fn(() => {
        controller.abort()
        return Promise.resolve(prepared)
      }),
    }
    const deliverReminder = { execute: jest.fn() }
    const cycle = new RunDueRemindersCycle(
      {
        execute: () => Promise.resolve([claim(prepared.occurrenceId)]),
      } as never,
      buildReminderIntent as never,
      deliverReminder as never,
      () => 'planner-reminders:shutdown-after-reread',
    )

    await expect(cycle.execute(controller.signal)).resolves.toEqual({
      claimed: 1,
      suppressed: 0,
      prepared: 1,
      delivered: 0,
    })
    expect(deliverReminder.execute).not.toHaveBeenCalled()
  })
})
