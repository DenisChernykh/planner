import { randomUUID } from 'node:crypto'

import {
  REMINDER_WORKER_BATCH_LIMIT,
  REMINDER_WORKER_LEASE_DURATION_MS,
} from './reminder.types'
import {
  ReminderDeliveryAbortedError,
  ReminderIntentClaimStaleError,
} from './reminder-errors'
import type { BuildReminderIntentCommand } from './build-reminder-intent.command'
import type { ClaimDueOccurrences } from './claim-due-occurrences.command'
import type { DeliverReminderCommand } from './deliver-reminder.command'

export type ReminderWorkerCycleResult = {
  readonly claimed: number
  readonly suppressed: number
  readonly prepared: number
  readonly delivered: number
}

export class RunDueRemindersCycle {
  public constructor(
    private readonly claimDueOccurrences: ClaimDueOccurrences,
    private readonly buildReminderIntent: BuildReminderIntentCommand,
    private readonly deliverReminder: DeliverReminderCommand,
    private readonly leaseOwnerFactory: () => string = () =>
      `planner-reminders:${randomUUID()}`,
  ) {}

  public async execute(
    signal: AbortSignal,
  ): Promise<ReminderWorkerCycleResult> {
    if (signal.aborted) {
      return { claimed: 0, suppressed: 0, prepared: 0, delivered: 0 }
    }
    const leaseOwner = this.leaseOwnerFactory()
    const claims = await this.claimDueOccurrences.execute({
      leaseOwner,
      limit: REMINDER_WORKER_BATCH_LIMIT,
      leaseDurationMs: REMINDER_WORKER_LEASE_DURATION_MS,
    })
    let suppressed = 0
    let prepared = 0
    let delivered = 0
    for (const claim of claims) {
      if (signal.aborted) break
      try {
        const intent = await this.buildReminderIntent.execute({
          claim,
          leaseOwner,
        })
        if (intent.kind === 'suppressed') {
          suppressed += 1
          continue
        }
        prepared += 1
        // A shutdown may arrive while the authoritative reread is in flight.
        // Leave the durable prepared attempt untouched so recovery can reclaim it.
        if (signal.aborted) break
        await this.deliverReminder.execute({
          claim,
          leaseOwner,
          intentId: intent.intentId,
          attemptId: intent.attemptId,
          signal,
        })
        delivered += 1
      } catch (error: unknown) {
        if (error instanceof ReminderIntentClaimStaleError) continue
        if (error instanceof ReminderDeliveryAbortedError) break
        throw error
      }
    }
    return { claimed: claims.length, suppressed, prepared, delivered }
  }
}
