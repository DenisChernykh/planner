import type { ProductClock } from '@/shared/application/product-clock'
import type { WorkspaceTelegramRecipientResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { WorkspaceTelegramRecipientNotFoundError } from '@/modules/workspace/application/workspace-errors'

import {
  ReminderDeliveryAbortedError,
  ReminderClaimValidationError,
  ReminderIntentClaimStaleError,
} from './reminder-errors'
import type {
  DeliverReminderInput,
  DeliverReminderResult,
  ReminderAttemptPersistencePort,
  ReminderDeliveryTransportPort,
  ReminderRenderedContentV1,
  TelegramAttemptOutcome,
} from './reminder.types'

const MAX_TELEGRAM_TEXT_LENGTH = 4_096

function render(content: ReminderRenderedContentV1): string {
  const lines: string[] = []
  if (content.focus !== null) lines.push(`Фокус: ${content.focus}`)
  for (const item of content.items) {
    const suffix =
      item.remaining === null ? '' : ` (осталось: ${item.remaining})`
    lines.push(`• ${item.title}${suffix}`)
  }
  if (content.actions.length > 0) lines.push('Закрыть день')
  return lines.join('\n').trim().slice(0, MAX_TELEGRAM_TEXT_LENGTH)
}

export class DeliverReminderCommand {
  public constructor(
    private readonly attempts: ReminderAttemptPersistencePort,
    private readonly recipients: WorkspaceTelegramRecipientResolver,
    private readonly transport: ReminderDeliveryTransportPort,
    private readonly transaction: {
      run<T>(operation: () => Promise<T>): Promise<T>
    },
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: DeliverReminderInput,
  ): Promise<DeliverReminderResult> {
    if (
      typeof input.leaseOwner !== 'string' ||
      input.leaseOwner.length < 1 ||
      input.leaseOwner.length > 128 ||
      typeof input.intentId !== 'string' ||
      input.intentId.length < 1 ||
      typeof input.attemptId !== 'string' ||
      input.attemptId.length < 1 ||
      !(input.signal instanceof AbortSignal)
    ) {
      throw new ReminderClaimValidationError()
    }

    const target = await this.transaction.run(() =>
      this.attempts.inspectPrepared({
        attemptId: input.attemptId,
        intentId: input.intentId,
        occurrenceId: input.claim.occurrenceId,
        leaseOwner: input.leaseOwner,
        fencingToken: input.claim.fencingToken,
        now: this.clock.now(),
      }),
    )
    if (target.kind === 'stale') throw new ReminderIntentClaimStaleError()
    if (target.kind === 'terminal') {
      return { attemptId: input.attemptId, outcome: target.outcome }
    }
    if (target.kind === 'dispatching') {
      const recovery = await this.transaction.run(() =>
        this.attempts.beginDispatch({
          attemptId: input.attemptId,
          intentId: input.intentId,
          occurrenceId: input.claim.occurrenceId,
          leaseOwner: input.leaseOwner,
          fencingToken: input.claim.fencingToken,
          now: this.clock.now(),
        }),
      )
      if (recovery.kind === 'terminal') {
        return { attemptId: input.attemptId, outcome: recovery.outcome }
      }
      throw new ReminderIntentClaimStaleError()
    }

    if (input.signal.aborted) throw new ReminderDeliveryAbortedError()

    const text = render(target.content)
    if (text.length === 0) {
      const outcome: Extract<
        TelegramAttemptOutcome,
        { readonly kind: 'terminal' }
      > = { kind: 'terminal', reason: 'provider_rejected' }
      return this.completePrepared(input, outcome)
    }

    let chatId: bigint
    try {
      chatId = await this.recipients.resolveTelegramRecipient(
        target.recipientMemberId,
      )
    } catch (error: unknown) {
      if (input.signal.aborted) throw new ReminderDeliveryAbortedError()
      const outcome: TelegramAttemptOutcome =
        error instanceof WorkspaceTelegramRecipientNotFoundError
          ? { kind: 'terminal', reason: 'provider_rejected' }
          : {
              kind: 'retryable',
              reason: 'provider_error',
              retryAfterSeconds: null,
            }
      return this.completePrepared(input, outcome)
    }

    // Recipient resolution can be asynchronous.  Do not turn a prepared
    // attempt into dispatching after shutdown: recovery must be able to reuse it.
    if (input.signal.aborted) throw new ReminderDeliveryAbortedError()

    const dispatch = await this.transaction.run(() =>
      this.attempts.beginDispatch({
        attemptId: input.attemptId,
        intentId: input.intentId,
        occurrenceId: input.claim.occurrenceId,
        leaseOwner: input.leaseOwner,
        fencingToken: input.claim.fencingToken,
        now: this.clock.now(),
      }),
    )
    if (dispatch.kind === 'stale') throw new ReminderIntentClaimStaleError()
    if (dispatch.kind === 'terminal') {
      return { attemptId: input.attemptId, outcome: dispatch.outcome }
    }

    let outcome: TelegramAttemptOutcome
    try {
      outcome = await this.transport.send({
        chatId,
        text,
        signal: input.signal,
      })
    } catch {
      outcome = { kind: 'ambiguous', reason: 'transport_error' }
    }

    const completed = await this.transaction.run(() =>
      this.attempts.completeDispatch({
        attemptId: input.attemptId,
        occurrenceId: input.claim.occurrenceId,
        leaseOwner: input.leaseOwner,
        fencingToken: input.claim.fencingToken,
        now: this.clock.now(),
        outcome,
      }),
    )
    if (!completed) throw new ReminderIntentClaimStaleError()
    return { attemptId: input.attemptId, outcome }
  }

  private async completePrepared(
    input: DeliverReminderInput,
    outcome: TelegramAttemptOutcome,
  ): Promise<DeliverReminderResult> {
    const completed = await this.transaction.run(() =>
      this.attempts.completePrepared({
        attemptId: input.attemptId,
        occurrenceId: input.claim.occurrenceId,
        leaseOwner: input.leaseOwner,
        fencingToken: input.claim.fencingToken,
        now: this.clock.now(),
        outcome,
      }),
    )
    if (!completed) throw new ReminderIntentClaimStaleError()
    return { attemptId: input.attemptId, outcome }
  }
}
