import { createHash, randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import { ReminderIntentClaimStaleError } from '../application/reminder-errors'
import type {
  PersistReminderIntentInput,
  ReminderIntentBuildResult,
  ReminderIntentPersistencePort,
} from '../application/reminder.types'

type OccurrenceRow = {
  readonly state: string
  readonly space_id: string
  readonly expires_at: Date
  readonly lease_until: Date | null
  readonly lease_owner: string | null
  readonly fencing_token: bigint
}

type ExistingIntentRow = {
  readonly id: string
  readonly intent_revision: bigint
  readonly content_hash: string
}

type AttemptRow = {
  readonly id: string
  readonly attempt_number: number
}

type PrismaClientLike = PrismaClient | Prisma.TransactionClient

function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
}

function stale(): never {
  throw new ReminderIntentClaimStaleError()
}

export class PrismaNotificationIntentPersistence implements ReminderIntentPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async persistIntent(
    input: PersistReminderIntentInput,
  ): Promise<ReminderIntentBuildResult> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<OccurrenceRow[]>(
        Prisma.sql`SELECT state, space_id, expires_at, lease_until,
                          lease_owner, fencing_token
                     FROM reminder_occurrences
                    WHERE id = ${input.claim.occurrenceId}::uuid
                    FOR UPDATE`,
      )
      const occurrence = rows[0]
      if (occurrence === undefined) stale()
      if (occurrence.state === 'suppressed') {
        return {
          kind: 'suppressed',
          occurrenceId: input.claim.occurrenceId,
          reason: 'nothing_relevant',
        }
      }
      if (
        occurrence.state !== 'claimed' ||
        occurrence.lease_owner !== input.leaseOwner ||
        occurrence.lease_until === null ||
        occurrence.lease_until <= input.now ||
        occurrence.expires_at <= input.now ||
        occurrence.fencing_token !== input.claim.fencingToken
      ) {
        stale()
      }

      if (input.content === null || input.source === null) {
        const changed = await client.$executeRaw(
          Prisma.sql`UPDATE reminder_occurrences
                        SET state = 'suppressed', lease_owner = NULL,
                            lease_until = NULL, updated_at = ${input.now}
                      WHERE id = ${input.claim.occurrenceId}::uuid
                        AND state = 'claimed'
                        AND lease_owner = ${input.leaseOwner}
                        AND fencing_token = ${input.claim.fencingToken}
                        AND lease_until > ${input.now}
                        AND expires_at > ${input.now}`,
        )
        if (changed !== 1) stale()
        return {
          kind: 'suppressed',
          occurrenceId: input.claim.occurrenceId,
          reason: input.suppressionReason,
        }
      }

      const hash = contentHash(input.content)
      const existing = await client.$queryRaw<ExistingIntentRow[]>(
        Prisma.sql`SELECT id, intent_revision, content_hash
                     FROM notification_intents
                    WHERE occurrence_id = ${input.claim.occurrenceId}::uuid
                      AND source_facts_revision = ${input.source.factsRevision}
                      AND content_hash = ${hash}
                    LIMIT 1`,
      )
      if (existing[0] !== undefined) {
        const attempt = await latestAttempt(client, existing[0].id)
        const attemptId =
          attempt?.id ??
          (await createAttempt(client, {
            intentId: existing[0].id,
            occurrenceId: input.claim.occurrenceId,
            spaceId: occurrence.space_id,
            recipientMemberId: input.claim.recipientMemberId,
            attemptNumber: 1,
            now: input.now,
          }))
        return {
          kind: 'prepared',
          occurrenceId: input.claim.occurrenceId,
          intentId: existing[0].id,
          attemptId,
          intentRevision: existing[0].intent_revision,
          contentHash: existing[0].content_hash,
          expiresAt: new Date(occurrence.expires_at.getTime()),
        }
      }

      const latest = await client.$queryRaw<
        { id: string; intent_revision: bigint }[]
      >(
        Prisma.sql`SELECT id, intent_revision
                     FROM notification_intents
                    WHERE occurrence_id = ${input.claim.occurrenceId}::uuid
                    ORDER BY intent_revision DESC
                    LIMIT 1
                    FOR UPDATE`,
      )
      const previous = latest[0]
      const intentId = randomUUID()
      const attemptId = randomUUID()
      const intentRevision = (previous?.intent_revision ?? 0n) + 1n
      await client.$executeRaw(
        Prisma.sql`INSERT INTO notification_intents
          (id, occurrence_id, space_id, recipient_member_id, publication_id,
           local_date, slot_kind, source_facts_revision, intent_revision,
           content_schema_version, content, content_hash, expires_at,
           supersedes_intent_id, created_at)
          VALUES (${intentId}::uuid, ${input.claim.occurrenceId}::uuid,
                  ${occurrence.space_id}::uuid,
                  ${input.claim.recipientMemberId}::uuid,
                  ${input.source.publicationId}::uuid,
                  ${input.claim.localDate}::date, ${input.claim.slotKind},
                  ${input.source.factsRevision}, ${intentRevision},
                  ${input.content.schemaVersion},
                  ${JSON.stringify(input.content)}::jsonb, ${hash},
                  ${input.claim.expiresAt},
                  ${previous?.id === undefined ? null : Prisma.sql`${previous.id}::uuid`},
                  ${input.now})`,
      )
      await client.$executeRaw(
        Prisma.sql`INSERT INTO notification_attempts
          (id, intent_id, occurrence_id, space_id, recipient_member_id,
           attempt_number, state, fencing_token, created_at, updated_at)
          VALUES (${attemptId}::uuid, ${intentId}::uuid,
                  ${input.claim.occurrenceId}::uuid,
                  ${occurrence.space_id}::uuid,
                  ${input.claim.recipientMemberId}::uuid,
                  1, 'prepared', 0, ${input.now}, ${input.now})`,
      )
      return {
        kind: 'prepared',
        occurrenceId: input.claim.occurrenceId,
        intentId,
        attemptId,
        intentRevision,
        contentHash: hash,
        expiresAt: new Date(occurrence.expires_at.getTime()),
      }
    })
  }
}

async function latestAttempt(
  client: PrismaClientLike,
  intentId: string,
): Promise<AttemptRow | undefined> {
  const rows = await client.$queryRaw<AttemptRow[]>(
    Prisma.sql`SELECT id, attempt_number
                 FROM notification_attempts
                WHERE intent_id = ${intentId}::uuid
                ORDER BY attempt_number DESC
                LIMIT 1
                FOR UPDATE`,
  )
  return rows[0]
}

async function createAttempt(
  client: PrismaClientLike,
  input: {
    readonly intentId: string
    readonly occurrenceId: string
    readonly spaceId: string
    readonly recipientMemberId: string
    readonly attemptNumber: number
    readonly now: Date
  },
): Promise<string> {
  const attemptId = randomUUID()
  await client.$executeRaw(
    Prisma.sql`INSERT INTO notification_attempts
      (id, intent_id, occurrence_id, space_id, recipient_member_id,
       attempt_number, state, fencing_token, created_at, updated_at)
      VALUES (${attemptId}::uuid, ${input.intentId}::uuid,
              ${input.occurrenceId}::uuid, ${input.spaceId}::uuid,
              ${input.recipientMemberId}::uuid, ${input.attemptNumber},
              'prepared', 0, ${input.now}, ${input.now})`,
  )
  return attemptId
}
