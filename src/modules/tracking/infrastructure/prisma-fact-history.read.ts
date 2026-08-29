import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  FactHistoryActorRecord,
  FactHistoryEventRecord,
  FactHistoryHeaderRecord,
  FactHistoryReadPort,
  FactHistoryRevisionRecord,
} from '../application/fact-history.read.port'

interface HeaderRow {
  readonly fact_record_id: string
  readonly created_member_id: string | null
  readonly created_system_id: string | null
  readonly created_at: Date
  readonly current_id: string
  readonly current_number: string
  readonly current_kind: string
  readonly current_member_id: string | null
  readonly current_system_id: string | null
  readonly current_at: Date
}

interface EventRow {
  readonly action_id: string
  readonly action_kind: string
  readonly member_id: string | null
  readonly system_actor_id: string | null
  readonly occurred_at: Date
  readonly reason: string | null
  readonly before_id: string | null
  readonly before_number: string | null
  readonly before_kind: string | null
  readonly before_member_id: string | null
  readonly before_system_id: string | null
  readonly before_at: Date | null
  readonly after_id: string
  readonly after_number: string
  readonly after_kind: string
  readonly after_member_id: string | null
  readonly after_system_id: string | null
  readonly after_at: Date
  readonly undone_action_id: string | null
  readonly restored_id: string | null
  readonly restored_number: string | null
  readonly restored_kind: string | null
  readonly restored_member_id: string | null
  readonly restored_system_id: string | null
  readonly restored_at: Date | null
}

function actor(
  memberId: string | null,
  systemId: string | null,
): FactHistoryActorRecord {
  if (memberId !== null && systemId === null)
    return { kind: 'member', id: memberId }
  if (memberId === null && systemId !== null)
    return { kind: 'system', id: systemId }
  throw new Error('Invalid fact history actor')
}

function revision(input: {
  readonly id: string | null
  readonly number: string | null
  readonly kind: string | null
  readonly memberId: string | null
  readonly systemId: string | null
  readonly occurredAt: Date | null
}): FactHistoryRevisionRecord | null {
  if (input.id === null) {
    if (
      input.number !== null ||
      input.kind !== null ||
      input.memberId !== null ||
      input.systemId !== null ||
      input.occurredAt !== null
    ) {
      throw new Error('Invalid null fact revision')
    }
    return null
  }
  if (
    input.number === null ||
    (input.kind !== 'recorded' && input.kind !== 'tombstoned') ||
    input.occurredAt === null
  ) {
    throw new Error('Invalid fact revision')
  }
  return {
    id: input.id,
    revision: input.number,
    kind: input.kind,
    actor: actor(input.memberId, input.systemId),
    occurredAt: input.occurredAt.toISOString(),
  }
}

@Injectable()
export class PrismaFactHistoryRead implements FactHistoryReadPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public readHeader(input: {
    readonly spaceId: string
    readonly factRecordId: string
  }): Promise<FactHistoryHeaderRecord | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<HeaderRow[]>`
        SELECT record.id::text fact_record_id,
               record.created_by_member_id::text created_member_id,
               record.created_by_system_actor_id created_system_id,
               record.created_at,
               revision.id::text current_id,
               revision.revision_number::text current_number,
               revision.revision_kind current_kind,
               revision.recorded_by_member_id::text current_member_id,
               revision.recorded_by_system_actor_id current_system_id,
               revision.created_at current_at
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.fact_record_id = record.id
           AND revision.id = record.current_revision_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        factRecordId: row.fact_record_id,
        originalActor: actor(row.created_member_id, row.created_system_id),
        createdAt: row.created_at.toISOString(),
        currentRevision: revision({
          id: row.current_id,
          number: row.current_number,
          kind: row.current_kind,
          memberId: row.current_member_id,
          systemId: row.current_system_id,
          occurredAt: row.current_at,
        })!,
      }
    })
  }

  public readEvents(input: {
    readonly spaceId: string
    readonly factRecordId: string
    readonly limit: number
    readonly cursor: bigint | null
  }): Promise<readonly FactHistoryEventRecord[]> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<EventRow[]>`
        SELECT action.id::text action_id, action.action_kind,
               action.member_id::text, action.system_actor_id,
               action.occurred_at, action.reason,
               before_revision.id::text before_id,
               before_revision.revision_number::text before_number,
               before_revision.revision_kind before_kind,
               before_revision.recorded_by_member_id::text before_member_id,
               before_revision.recorded_by_system_actor_id before_system_id,
               before_revision.created_at before_at,
               after_revision.id::text after_id,
               after_revision.revision_number::text after_number,
               after_revision.revision_kind after_kind,
               after_revision.recorded_by_member_id::text after_member_id,
               after_revision.recorded_by_system_actor_id after_system_id,
               after_revision.created_at after_at,
               undo.undone_action_id::text,
               restored.id::text restored_id,
               restored.revision_number::text restored_number,
               restored.revision_kind restored_kind,
               restored.recorded_by_member_id::text restored_member_id,
               restored.recorded_by_system_actor_id restored_system_id,
               restored.created_at restored_at
          FROM tracking_fact_records record
          JOIN tracking_fact_changes change ON change.fact_record_id = record.id
          JOIN tracking_action_groups action ON action.id = change.action_id
          LEFT JOIN tracking_fact_revisions before_revision
            ON before_revision.fact_record_id = change.fact_record_id
           AND before_revision.id = change.before_revision_id
          JOIN tracking_fact_revisions after_revision
            ON after_revision.fact_record_id = change.fact_record_id
           AND after_revision.id = change.after_revision_id
          LEFT JOIN tracking_fact_undo_changes undo ON undo.action_id = action.id
          LEFT JOIN tracking_fact_revisions restored
            ON restored.id = undo.restored_from_revision_id
         WHERE record.id = ${input.factRecordId}::uuid
           AND record.space_id = ${input.spaceId}::uuid
           AND (${input.cursor}::bigint IS NULL
                OR after_revision.revision_number < ${input.cursor}::bigint)
         ORDER BY after_revision.revision_number DESC, action.id DESC
         LIMIT ${input.limit}
      `
      return Object.freeze(
        rows.map((row): FactHistoryEventRecord => {
          const kind =
            row.action_kind === 'fact_corrected'
              ? 'corrected'
              : row.action_kind === 'fact_tombstoned'
                ? 'tombstoned'
                : row.action_kind === 'fact_undone'
                  ? 'undone'
                  : row.action_kind === 'fact_recorded' ||
                      row.action_kind === 'day_closed' ||
                      row.action_kind === 'week_closed'
                    ? 'recorded'
                    : null
          if (kind === null) throw new Error('Invalid fact history event')
          const beforeRevision = revision({
            id: row.before_id,
            number: row.before_number,
            kind: row.before_kind,
            memberId: row.before_member_id,
            systemId: row.before_system_id,
            occurredAt: row.before_at,
          })
          const afterRevision = revision({
            id: row.after_id,
            number: row.after_number,
            kind: row.after_kind,
            memberId: row.after_member_id,
            systemId: row.after_system_id,
            occurredAt: row.after_at,
          })!
          const restoredFromRevision = revision({
            id: row.restored_id,
            number: row.restored_number,
            kind: row.restored_kind,
            memberId: row.restored_member_id,
            systemId: row.restored_system_id,
            occurredAt: row.restored_at,
          })
          if ((kind === 'undone') !== (row.undone_action_id !== null)) {
            throw new Error('Invalid fact compensation history')
          }
          if (
            (kind === 'corrected' || kind === 'tombstoned') !==
            (row.reason !== null)
          ) {
            throw new Error('Invalid fact history reason')
          }
          return {
            id: row.action_id,
            kind,
            actor: actor(row.member_id, row.system_actor_id),
            occurredAt: row.occurred_at.toISOString(),
            reason: row.reason,
            beforeRevision,
            afterRevision,
            compensation:
              row.undone_action_id === null
                ? null
                : {
                    undoneEventId: row.undone_action_id,
                    restoredFromRevision,
                  },
          }
        }),
      )
    })
  }
}
