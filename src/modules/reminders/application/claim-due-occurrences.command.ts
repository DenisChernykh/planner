import type { ProductClock } from '@/shared/application/product-clock'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import { ReminderClaimValidationError } from './reminder-errors'
import type {
  ClaimDueOccurrencesInput,
  ReminderOccurrenceClaim,
  ReminderSchedulePersistencePort,
} from './reminder.types'

export class ClaimDueOccurrences {
  public constructor(
    private readonly persistence: ReminderSchedulePersistencePort,
    private readonly clock: ProductClock,
    private readonly transaction: DatabaseTransactionPort,
  ) {}

  public execute(
    input: Omit<ClaimDueOccurrencesInput, 'now'>,
  ): Promise<readonly ReminderOccurrenceClaim[]> {
    if (
      typeof input.leaseOwner !== 'string' ||
      input.leaseOwner.length < 1 ||
      input.leaseOwner.length > 128 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 300_000
    ) {
      return Promise.reject(new ReminderClaimValidationError())
    }
    const now = this.clock.now()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return Promise.reject(new ReminderClaimValidationError())
    }
    return this.transaction.run(() =>
      this.persistence.claimDueOccurrences({ ...input, now }),
    )
  }
}
