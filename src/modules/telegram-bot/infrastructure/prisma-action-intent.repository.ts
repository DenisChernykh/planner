import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  StoredTelegramActionIntent,
  TelegramActionIntentOffer,
  TelegramActionIntentPersistencePort,
} from '../application/action-intent.types'

type IntentRow = {
  readonly action_intent_id: string
  readonly command_id: string
  readonly space_id: string
  readonly member_id: string
  readonly publication_id: string
  readonly plan_goal_snapshot_id: string
  readonly local_date: Date | string
  readonly source_facts_revision: bigint
  readonly current_facts_revision: bigint
  readonly active_publication_id: string | null
  readonly month_status: 'draft' | 'published' | 'grace' | 'closed'
  readonly intent_kind: 'boolean' | 'quantity'
  readonly state: StoredTelegramActionIntent['state']
  readonly boolean_result: 'done' | 'not_done' | null
  readonly quantity_value: string | null
  readonly command_fingerprint: string | null
  readonly expires_at: Date
  readonly title: string
  readonly config: unknown
  readonly result_kind: 'tracking.fact-record.v1' | null
  readonly result_aggregate_id: string | null
  readonly result_aggregate_revision: bigint | null
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function presentation(
  row: IntentRow,
): Pick<StoredTelegramActionIntent, 'unit' | 'precision' | 'aggregation'> {
  const config = object(row.config)
  const measurement = object(config?.['measurement'])
  if (row.intent_kind === 'boolean') {
    if (measurement?.['kind'] !== 'boolean') {
      throw new Error('Telegram Boolean intent target is invalid')
    }
    return { unit: null, precision: null, aggregation: null }
  }
  const precision = measurement?.['precision']
  const aggregation = measurement?.['aggregation']
  const unit = measurement?.['unit']
  if (
    measurement?.['kind'] !== 'quantity' ||
    typeof unit !== 'string' ||
    ![0, 1, 2, 3].includes(precision as number) ||
    (aggregation !== 'add' && aggregation !== 'latest')
  ) {
    throw new Error('Telegram quantity intent target is invalid')
  }
  return {
    unit,
    precision: precision as 0 | 1 | 2 | 3,
    aggregation,
  }
}

function localDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

function stored(row: IntentRow): StoredTelegramActionIntent {
  const result =
    row.result_kind === null ||
    row.result_aggregate_id === null ||
    row.result_aggregate_revision === null
      ? null
      : {
          kind: row.result_kind,
          aggregateId: row.result_aggregate_id,
          aggregateRevision: row.result_aggregate_revision,
        }
  return Object.freeze({
    actionIntentId: row.action_intent_id,
    commandId: row.command_id,
    spaceId: row.space_id,
    memberId: row.member_id,
    publicationId: row.publication_id,
    planGoalSnapshotId: row.plan_goal_snapshot_id,
    localDate: localDate(row.local_date),
    sourceFactsRevision: row.source_facts_revision,
    currentFactsRevision: row.current_facts_revision,
    activePublicationId: row.active_publication_id,
    monthStatus: row.month_status,
    intentKind: row.intent_kind,
    state: row.state,
    booleanResult: row.boolean_result,
    quantityValue: row.quantity_value,
    commandFingerprint: row.command_fingerprint,
    expiresAt: row.expires_at,
    title: row.title,
    ...presentation(row),
    result,
  })
}

const selectIntent = `
  SELECT intent.id action_intent_id, intent.command_id,
         intent.space_id, intent.member_id, intent.publication_id,
         intent.plan_goal_snapshot_id, intent.local_date,
         intent.source_facts_revision,
         month.facts_revision current_facts_revision,
         month.active_publication_id,
         month.status month_status,
         intent.intent_kind, intent.state, intent.boolean_result,
         intent.quantity_value, intent.command_fingerprint,
         intent.expires_at, snapshot.title, snapshot.config,
         intent.result_kind, intent.result_aggregate_id,
         intent.result_aggregate_revision
    FROM telegram_action_intents intent
    JOIN plan_goal_snapshots snapshot
      ON snapshot.publication_id = intent.publication_id
     AND snapshot.id = intent.plan_goal_snapshot_id
    JOIN plan_publications publication
      ON publication.id = intent.publication_id
    JOIN plan_months month ON month.id = publication.plan_month_id
`

@Injectable()
export class PrismaActionIntentRepository implements TelegramActionIntentPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public offer(
    input: TelegramActionIntentOffer,
    now: Date,
  ): Promise<StoredTelegramActionIntent> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $2
          WHERE semantic_key = $1
            AND state IN ('offered', 'awaiting_value', 'ready')
            AND expires_at <= $2`,
        input.semanticKey,
        now,
      )
      await client.$executeRawUnsafe(
        `INSERT INTO telegram_action_intents
           (id, semantic_key, command_id, space_id, member_id,
            publication_id, plan_goal_snapshot_id, local_date,
            source_facts_revision, intent_kind, state, boolean_result,
            command_fingerprint, expires_at, created_at, updated_at)
         VALUES
           ($1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
            $5::uuid, $6::uuid, $7::date, $8, $9, $10, $11,
            $12, $13, $14, $14)
         ON CONFLICT (semantic_key)
           WHERE state IN ('offered', 'awaiting_value', 'ready')
         DO NOTHING`,
        input.actionIntentId,
        input.semanticKey,
        input.spaceId,
        input.memberId,
        input.publicationId,
        input.planGoalSnapshotId,
        input.localDate,
        input.sourceFactsRevision,
        input.intentKind,
        input.state,
        input.booleanResult,
        input.commandFingerprint,
        input.expiresAt,
        now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.semantic_key = $1
            AND intent.state IN ('offered', 'awaiting_value', 'ready')`,
        input.semanticKey,
      )
      const row = rows[0]
      if (row === undefined)
        throw new Error('Telegram action intent offer failed')
      return stored(row)
    })
  }

  public lockForMember(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.id = $1::uuid
            AND intent.space_id = $2::uuid
            AND intent.member_id = $3::uuid
          FOR UPDATE OF intent, month`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
      )
      return rows[0] === undefined ? null : stored(rows[0])
    })
  }

  public selectQuantity(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $3
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND state IN ('offered', 'awaiting_value', 'ready')
            AND expires_at <= $3`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $4
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND id <> $3::uuid AND state = 'awaiting_value'`,
        input.spaceId,
        input.memberId,
        input.actionIntentId,
        input.now,
      )
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'awaiting_value', updated_at = $4
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid AND intent_kind = 'quantity'
            AND state = 'offered' AND expires_at > $4`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
        input.now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.id = $1::uuid
            AND intent.space_id = $2::uuid
            AND intent.member_id = $3::uuid`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
      )
      return rows[0] === undefined ? null : stored(rows[0])
    })
  }

  public findAwaitingQuantity(input: {
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $3
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND state = 'awaiting_value' AND expires_at <= $3`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.space_id = $1::uuid
            AND intent.member_id = $2::uuid
            AND intent.state = 'awaiting_value'
            AND intent.expires_at > $3
          FOR UPDATE OF intent`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      return rows[0] === undefined ? null : stored(rows[0])
    })
  }

  public setQuantityValue(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly value: string
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'ready', quantity_value = $4,
                command_fingerprint = $5, updated_at = $6
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid AND state = 'awaiting_value'
            AND expires_at > $6`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
        input.value,
        input.commandFingerprint,
        input.now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.id = $1::uuid
            AND intent.space_id = $2::uuid
            AND intent.member_id = $3::uuid`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
      )
      return rows[0] === undefined ? null : stored(rows[0])
    })
  }

  public markCompleted(input: {
    readonly actionIntentId: string
    readonly result: {
      readonly kind: 'tracking.fact-record.v1'
      readonly aggregateId: string
      readonly aggregateRevision: bigint
    }
    readonly completedAt: Date
  }): Promise<void> {
    return this.database.withClient(async (client) => {
      const changed = await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'completed', result_kind = $2,
                result_aggregate_id = $3::uuid,
                result_aggregate_revision = $4,
                completed_at = $5, updated_at = $5
          WHERE id = $1::uuid AND state = 'ready'`,
        input.actionIntentId,
        input.result.kind,
        input.result.aggregateId,
        input.result.aggregateRevision,
        input.completedAt,
      )
      if (changed !== 1)
        throw new Error('Telegram action intent completion failed')
    })
  }

  public markExpired(actionIntentId: string, now: Date): Promise<void> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $2
          WHERE id = $1::uuid
            AND state IN ('offered', 'awaiting_value', 'ready')`,
        actionIntentId,
        now,
      )
    })
  }
}
