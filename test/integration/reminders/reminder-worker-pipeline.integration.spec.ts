import { RunDueRemindersCycle } from '@/modules/reminders/application/run-due-reminders.cycle'
import type {
  ReminderIntentBuildResult,
  ReminderOccurrenceClaim,
} from '@/modules/reminders/application/reminder.types'
import { ReminderIntentClaimStaleError } from '@/modules/reminders/application/reminder-errors'

const claim = (id: string): ReminderOccurrenceClaim => ({
  occurrenceId: id,
  recipientMemberId: '44444444-4444-4444-8444-444444444444',
  localDate: '2026-03-30',
  slotKind: 'morning',
  dueAt: new Date('2026-03-30T04:00:00.000Z'),
  expiresAt: new Date('2026-03-30T09:00:00.000Z'),
  fencingToken: 3n,
})

describe('N05 reminder worker pipeline public-command integration', () => {
  it('preserves claim → reread → suppression/delivery ordering', async () => {
    const first = claim('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const second = claim('dddddddd-dddd-4ddd-8ddd-ddddddddddde')
    const events: string[] = []
    const claims = { execute: () => Promise.resolve([first, second]) }
    const build = {
      execute: ({ claim: value }: { claim: ReminderOccurrenceClaim }) => {
        events.push(`reread:${value.occurrenceId}`)
        const result: ReminderIntentBuildResult =
          value.occurrenceId === first.occurrenceId
            ? {
                kind: 'prepared',
                occurrenceId: value.occurrenceId,
                intentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                attemptId: 'f1111111-1111-4111-8111-111111111111',
                intentRevision: 1n,
                contentHash: 'a'.repeat(64),
                expiresAt: value.expiresAt,
              }
            : {
                kind: 'suppressed',
                occurrenceId: value.occurrenceId,
                reason: 'nothing_relevant',
              }
        return Promise.resolve(result)
      },
    }
    const deliver = {
      execute: ({ claim: value }: { claim: ReminderOccurrenceClaim }) => {
        events.push(`dispatch:${value.occurrenceId}`)
        return Promise.resolve({
          attemptId: 'f1111111-1111-4111-8111-111111111111',
          outcome: { kind: 'accepted' as const },
        })
      },
    }
    const cycle = new RunDueRemindersCycle(
      claims as never,
      build as never,
      deliver as never,
      () => 'planner-reminders:integration',
    )

    await expect(cycle.execute(new AbortController().signal)).resolves.toEqual({
      claimed: 2,
      suppressed: 1,
      prepared: 1,
      delivered: 1,
    })
    expect(events).toEqual([
      `reread:${first.occurrenceId}`,
      `dispatch:${first.occurrenceId}`,
      `reread:${second.occurrenceId}`,
    ])
  })

  it('ignores a stale fenced claim so a competing worker can continue', async () => {
    const stale = {
      execute: () => Promise.reject(new ReminderIntentClaimStaleError()),
    }
    const cycle = new RunDueRemindersCycle(
      {
        execute: () =>
          Promise.resolve([claim('dddddddd-dddd-4ddd-8ddd-dddddddddddd')]),
      } as never,
      stale as never,
      { execute: () => Promise.resolve({}) } as never,
      () => 'planner-reminders:stale',
    )
    await expect(cycle.execute(new AbortController().signal)).resolves.toEqual({
      claimed: 1,
      suppressed: 0,
      prepared: 0,
      delivered: 0,
    })
  })
})
