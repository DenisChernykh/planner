import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import { buildReminderContent } from '../domain/reminder-relevance'
import {
  ReminderClaimValidationError,
  ReminderIntentClaimStaleError,
  ReminderIntentDependencyUnavailableError,
} from './reminder-errors'
import type {
  ReminderIntentBuildResult,
  ReminderIntentPersistencePort,
  ReminderOccurrenceClaim,
  ReminderTodayReadPort,
} from './reminder.types'

const TIME_ZONE = 'Asia/Yekaterinburg' as const

function localTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(value)
    .replace('24:', '00:')
}

function suppressionReason(
  read: Awaited<ReturnType<ReminderTodayReadPort['getToday']>>,
): 'no_active_plan' | 'inactive_lifecycle' | 'nothing_relevant' {
  if (read.state !== 'published') return 'no_active_plan'
  if (read.phase !== 'active' || read.monthStatus !== 'published') {
    return 'inactive_lifecycle'
  }
  return 'nothing_relevant'
}

export class BuildReminderIntentCommand {
  public constructor(
    private readonly today: ReminderTodayReadPort,
    private readonly persistence: ReminderIntentPersistencePort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(input: {
    readonly claim: ReminderOccurrenceClaim
    readonly leaseOwner: string
  }): Promise<ReminderIntentBuildResult> {
    if (
      typeof input.leaseOwner !== 'string' ||
      input.leaseOwner.length < 1 ||
      input.leaseOwner.length > 128 ||
      input.claim.occurrenceId.length < 1 ||
      !(input.claim.expiresAt instanceof Date) ||
      !Number.isFinite(input.claim.expiresAt.getTime())
    ) {
      throw new ReminderClaimValidationError()
    }
    const initialNow = this.clock.now()
    const localDate = this.clock.today(TIME_ZONE)
    if (
      input.claim.localDate !== localDate ||
      input.claim.expiresAt <= initialNow
    ) {
      throw new ReminderIntentClaimStaleError()
    }
    try {
      const read = await this.today.getToday(input.claim.recipientMemberId)
      const now = this.clock.now()
      if (
        input.claim.localDate !== this.clock.today(TIME_ZONE) ||
        input.claim.expiresAt <= now
      ) {
        throw new ReminderIntentClaimStaleError()
      }
      const content = buildReminderContent({
        read,
        localDate,
        localTime: localTime(now),
        slotKind: input.claim.slotKind,
      })
      return this.transaction.run(() =>
        this.persistence.persistIntent({
          claim: input.claim,
          leaseOwner: input.leaseOwner,
          now,
          source: read.state === 'published' ? read : null,
          content,
          suppressionReason:
            content === null ? suppressionReason(read) : 'nothing_relevant',
        }),
      )
    } catch (error: unknown) {
      if (error instanceof ReminderClaimValidationError) throw error
      if (error instanceof ReminderIntentClaimStaleError) throw error
      throw new ReminderIntentDependencyUnavailableError({ cause: error })
    }
  }
}
