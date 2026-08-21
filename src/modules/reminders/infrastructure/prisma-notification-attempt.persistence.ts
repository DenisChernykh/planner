import { Prisma, type PrismaClient } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  ReminderAttemptPersistencePort,
  ReminderRenderedContentV1,
  TelegramAttemptOutcome,
} from '../application/reminder.types'
import { settleReminderAttempt } from '../application/reminder-retry.policy'

type PrismaClientLike = PrismaClient | Prisma.TransactionClient

type AttemptRow = {
  readonly state: string
  readonly fencing_token: bigint
  readonly outcome: string | null
  readonly outcome_reason: string | null
  readonly provider_retry_after_sec: number | null
  readonly intent_id: string
  readonly recipient_member_id: string
  readonly content: unknown
  readonly intent_expires_at: Date
  readonly occurrence_state: string
  readonly occurrence_fencing_token: bigint
  readonly occurrence_lease_owner: string | null
  readonly occurrence_lease_until: Date | null
  readonly occurrence_expires_at: Date
  readonly superseded: boolean
  readonly next_attempt_at: Date | null
}

function terminalOutcome(
  outcome: string | null,
  reason: string | null,
  retryAfterSeconds: number | null,
): TelegramAttemptOutcome {
  if (outcome === 'accepted') return { kind: 'accepted' }
  if (outcome === 'retryable') {
    return {
      kind: 'retryable',
      reason: reason === 'rate_limited' ? 'rate_limited' : 'provider_error',
      retryAfterSeconds,
    }
  }
  if (outcome === 'ambiguous') {
    return {
      kind: 'ambiguous',
      reason:
        reason === 'timeout' ||
        reason === 'aborted' ||
        reason === 'transport_error' ||
        reason === 'malformed_response' ||
        reason === 'oversized_response'
          ? reason
          : 'transport_error',
    }
  }
  return {
    kind: 'terminal',
    reason:
      reason === 'blocked' ||
      reason === 'chat_not_found' ||
      reason === 'expired' ||
      reason === 'superseded'
        ? reason
        : 'provider_rejected',
  }
}

function isContent(value: unknown): value is ReminderRenderedContentV1 {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      'reminders.rendered-content.v1'
  )
}

function claimIsActive(
  attempt: AttemptRow,
  input: {
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
  },
): boolean {
  return (
    attempt.occurrence_state === 'claimed' &&
    attempt.occurrence_lease_owner === input.leaseOwner &&
    attempt.occurrence_lease_until !== null &&
    attempt.occurrence_lease_until > input.now &&
    attempt.occurrence_expires_at > input.now &&
    attempt.occurrence_fencing_token === input.fencingToken
  )
}

export class PrismaNotificationAttemptPersistence implements ReminderAttemptPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async inspectPrepared(input: {
    readonly attemptId: string
    readonly intentId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
  }): Promise<
    | {
        readonly kind: 'prepared'
        readonly intentId: string
        readonly recipientMemberId: string
        readonly content: ReminderRenderedContentV1
      }
    | { readonly kind: 'dispatching' }
    | { readonly kind: 'terminal'; readonly outcome: TelegramAttemptOutcome }
    | { readonly kind: 'stale' }
  > {
    return this.database.withClient(async (client) => {
      const attempt = await this.lockAttempt(client, input)
      if (attempt === undefined) return { kind: 'stale' as const }
      if (attempt.state === 'terminal') return this.replay(attempt)
      if (attempt.state === 'dispatching') {
        return { kind: 'dispatching' as const }
      }
      if (attempt.state !== 'prepared') return { kind: 'stale' as const }

      const expired =
        attempt.intent_expires_at <= input.now ||
        attempt.occurrence_expires_at <= input.now
      if (expired || attempt.superseded || !isContent(attempt.content)) {
        const reason = attempt.superseded ? 'superseded' : 'expired'
        await this.markPreparedTerminal(client, input.attemptId, input.now, {
          kind: 'terminal',
          reason,
        })
        return {
          kind: 'terminal' as const,
          outcome: { kind: 'terminal' as const, reason },
        }
      }
      if (!claimIsActive(attempt, input)) return { kind: 'stale' as const }
      return {
        kind: 'prepared' as const,
        intentId: attempt.intent_id,
        recipientMemberId: attempt.recipient_member_id,
        content: attempt.content,
      }
    })
  }

  public async beginDispatch(input: {
    readonly attemptId: string
    readonly intentId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
  }): Promise<
    | { readonly kind: 'dispatch' }
    | { readonly kind: 'terminal'; readonly outcome: TelegramAttemptOutcome }
    | { readonly kind: 'stale' }
  > {
    return this.database.withClient(async (client) => {
      const attempt = await this.lockAttempt(client, input)
      if (attempt === undefined) return { kind: 'stale' as const }
      if (attempt.state === 'terminal') return this.replay(attempt)

      if (attempt.state === 'dispatching') {
        const occurrenceClaimLost =
          attempt.occurrence_state !== 'claimed' ||
          attempt.occurrence_lease_owner === null ||
          attempt.occurrence_lease_until === null ||
          attempt.occurrence_lease_until <= input.now
        const expiredOrSuperseded =
          attempt.intent_expires_at <= input.now ||
          attempt.occurrence_expires_at <= input.now ||
          attempt.superseded
        if (occurrenceClaimLost || expiredOrSuperseded) {
          await client.$executeRaw(
            Prisma.sql`UPDATE notification_attempts
                          SET state = 'terminal', outcome = 'ambiguous',
                              outcome_reason = 'transport_error',
                              completed_at = ${input.now},
                              updated_at = ${input.now}
                        WHERE id = ${input.attemptId}::uuid
                          AND state = 'dispatching'
                          AND fencing_token = ${attempt.fencing_token}`,
          )
          return {
            kind: 'terminal' as const,
            outcome: {
              kind: 'ambiguous' as const,
              reason: 'transport_error' as const,
            },
          }
        }
        const reclaimed =
          input.fencingToken > attempt.fencing_token &&
          attempt.occurrence_fencing_token === input.fencingToken &&
          claimIsActive(attempt, input)
        if (!reclaimed) return { kind: 'stale' as const }
        await client.$executeRaw(
          Prisma.sql`UPDATE notification_attempts
                        SET state = 'terminal', outcome = 'ambiguous',
                            outcome_reason = 'transport_error',
                            completed_at = ${input.now},
                            updated_at = ${input.now}
                      WHERE id = ${input.attemptId}::uuid
                        AND state = 'dispatching'
                        AND fencing_token = ${attempt.fencing_token}`,
        )
        return {
          kind: 'terminal' as const,
          outcome: {
            kind: 'ambiguous' as const,
            reason: 'transport_error' as const,
          },
        }
      }
      if (attempt.state !== 'prepared') return { kind: 'stale' as const }

      const expired =
        attempt.intent_expires_at <= input.now ||
        attempt.occurrence_expires_at <= input.now
      if (expired || attempt.superseded || !isContent(attempt.content)) {
        const reason = attempt.superseded ? 'superseded' : 'expired'
        await this.markPreparedTerminal(client, input.attemptId, input.now, {
          kind: 'terminal',
          reason,
        })
        return {
          kind: 'terminal' as const,
          outcome: { kind: 'terminal' as const, reason },
        }
      }
      if (!claimIsActive(attempt, input)) return { kind: 'stale' as const }

      const changed = await client.$executeRaw(
        Prisma.sql`UPDATE notification_attempts
                      SET state = 'dispatching', fencing_token = ${input.fencingToken},
                          started_at = ${input.now}, updated_at = ${input.now}
                    WHERE id = ${input.attemptId}::uuid
                      AND state = 'prepared'`,
      )
      return changed === 1
        ? { kind: 'dispatch' as const }
        : { kind: 'stale' as const }
    })
  }

  public async completePrepared(input: {
    readonly attemptId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
    readonly outcome: TelegramAttemptOutcome
  }): Promise<boolean> {
    return this.complete(input, 'prepared')
  }

  public async completeDispatch(input: {
    readonly attemptId: string
    readonly occurrenceId: string
    readonly leaseOwner: string
    readonly fencingToken: bigint
    readonly now: Date
    readonly outcome: TelegramAttemptOutcome
  }): Promise<boolean> {
    return this.complete(input, 'dispatching')
  }

  private async complete(
    input: {
      readonly attemptId: string
      readonly occurrenceId: string
      readonly leaseOwner: string
      readonly fencingToken: bigint
      readonly now: Date
      readonly outcome: TelegramAttemptOutcome
    },
    expectedState: 'prepared' | 'dispatching',
  ): Promise<boolean> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<
        {
          readonly expires_at: Date
        }[]
      >(
        Prisma.sql`SELECT occurrence.expires_at
                     FROM reminder_occurrences occurrence
                     JOIN notification_attempts current_attempt
                       ON current_attempt.occurrence_id = occurrence.id
                      AND current_attempt.id = ${input.attemptId}::uuid
                    WHERE occurrence.id = ${input.occurrenceId}::uuid
                      AND occurrence.state = 'claimed'
                      AND occurrence.lease_owner = ${input.leaseOwner}
                      AND occurrence.lease_until > ${input.now}
                      AND occurrence.expires_at > ${input.now}
                      AND current_attempt.state = ${expectedState}
                      AND (${expectedState} = 'prepared' OR current_attempt.fencing_token = ${input.fencingToken})
                      AND occurrence.fencing_token = ${input.fencingToken}
                    FOR UPDATE OF occurrence, current_attempt`,
      )
      const row = rows[0]
      if (row === undefined) return false
      const countRows = await client.$queryRaw<
        {
          readonly attempt_count: bigint
        }[]
      >(
        Prisma.sql`SELECT COUNT(*)::bigint AS attempt_count
                     FROM notification_attempts
                    WHERE occurrence_id = ${input.occurrenceId}::uuid`,
      )
      const attemptCount = Number(countRows[0]?.attempt_count ?? 0n)

      const decision = settleReminderAttempt({
        outcome: input.outcome,
        attemptsUsed: attemptCount,
        now: input.now,
        expiresAt: row.expires_at,
      })
      const persistedOutcome = decision.persistedOutcome
      const changed = await client.$executeRaw(
        Prisma.sql`UPDATE notification_attempts
                      SET state = 'terminal', outcome = ${persistedOutcome.kind},
                          outcome_reason = ${persistedOutcome.kind === 'accepted' ? null : persistedOutcome.reason},
                          provider_retry_after_sec = ${persistedOutcome.kind === 'retryable' ? persistedOutcome.retryAfterSeconds : null},
                          started_at = COALESCE(started_at, ${input.now}),
                          completed_at = ${input.now},
                          next_attempt_at = ${decision.nextAttemptAt},
                          updated_at = ${input.now}
                    WHERE id = ${input.attemptId}::uuid
                      AND state = ${expectedState}`,
      )
      if (changed !== 1) return false
      const occurrenceChanged = await client.$executeRaw(
        Prisma.sql`UPDATE reminder_occurrences
                      SET state = ${decision.occurrenceState},
                          lease_owner = NULL, lease_until = NULL,
                          updated_at = ${input.now}
                    WHERE id = ${input.occurrenceId}::uuid
                      AND state = 'claimed'
                      AND fencing_token = ${input.fencingToken}`,
      )
      if (occurrenceChanged !== 1) {
        throw new Error('Reminder occurrence completion lost its fence')
      }
      return true
    })
  }

  private async lockAttempt(
    client: PrismaClientLike,
    input: {
      readonly attemptId: string
      readonly intentId: string
      readonly occurrenceId: string
    },
  ): Promise<AttemptRow | undefined> {
    const rows = await client.$queryRaw<AttemptRow[]>(
      Prisma.sql`SELECT attempt.state,
                        attempt.fencing_token,
                        attempt.outcome,
                        attempt.outcome_reason,
                        attempt.provider_retry_after_sec,
                        attempt.intent_id,
                        intent.recipient_member_id,
                        intent.content,
                        intent.expires_at AS intent_expires_at,
                        occurrence.state AS occurrence_state,
                        occurrence.fencing_token AS occurrence_fencing_token,
                        occurrence.lease_owner AS occurrence_lease_owner,
                        occurrence.lease_until AS occurrence_lease_until,
                        occurrence.expires_at AS occurrence_expires_at,
                        attempt.next_attempt_at,
                        EXISTS (
                          SELECT 1
                            FROM notification_intents newer
                           WHERE newer.supersedes_intent_id = intent.id
                        ) AS superseded
                   FROM notification_attempts attempt
                   JOIN notification_intents intent
                     ON intent.id = attempt.intent_id
                   JOIN reminder_occurrences occurrence
                     ON occurrence.id = attempt.occurrence_id
                  WHERE attempt.id = ${input.attemptId}::uuid
                    AND attempt.intent_id = ${input.intentId}::uuid
                    AND attempt.occurrence_id = ${input.occurrenceId}::uuid
                  FOR UPDATE OF attempt, occurrence, intent`,
    )
    return rows[0]
  }

  private replay(attempt: AttemptRow): {
    readonly kind: 'terminal'
    readonly outcome: TelegramAttemptOutcome
  } {
    return {
      kind: 'terminal',
      outcome: terminalOutcome(
        attempt.outcome,
        attempt.outcome_reason,
        attempt.provider_retry_after_sec,
      ),
    }
  }

  private async markPreparedTerminal(
    client: PrismaClientLike,
    attemptId: string,
    now: Date,
    outcome: Extract<TelegramAttemptOutcome, { readonly kind: 'terminal' }>,
  ): Promise<void> {
    await client.$executeRaw(
      Prisma.sql`UPDATE notification_attempts
                    SET state = 'terminal', outcome = 'terminal',
                        outcome_reason = ${outcome.reason},
                        started_at = ${now}, completed_at = ${now},
                        updated_at = ${now}
                  WHERE id = ${attemptId}::uuid
                    AND state = 'prepared'`,
    )
  }
}
