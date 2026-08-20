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
  readonly plan_goal_snapshot_id: string | null
  readonly local_date: Date | string
  readonly source_facts_revision: bigint
  readonly current_facts_revision: bigint
  readonly active_publication_id: string | null
  readonly month_status: 'draft' | 'published' | 'grace' | 'closed'
  readonly intent_kind: StoredTelegramActionIntent['intentKind']
  readonly state: StoredTelegramActionIntent['state']
  readonly checkpoint_id: string | null
  readonly boolean_result: 'done' | 'not_done' | null
  readonly text_result: 'done' | 'not_done' | null
  readonly checklist_item_id: string | null
  readonly checklist_item_state: 'done' | 'not_done' | null
  readonly or_variant_id: string | null
  readonly quantity_value: string | null
  readonly actual_time_value: string | null
  readonly rating_value: bigint | null
  readonly text_value: string | null
  readonly or_variant_value: string | null
  readonly fact_record_id: string | null
  readonly expected_record_revision: bigint | null
  readonly flexible_period_id: string | null
  readonly reason: string | null
  readonly close_preview_schema_version: string | null
  readonly close_preview_hash_version: string | null
  readonly close_preview_hash: string | null
  readonly close_unresolved_count: number | null
  readonly command_fingerprint: string | null
  readonly expires_at: Date
  readonly title: string | null
  readonly config: unknown
  readonly result_kind:
    'tracking.fact-record.v1' | 'tracking.day-close.v1' | null
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
): Pick<
  StoredTelegramActionIntent,
  'title' | 'unit' | 'precision' | 'aggregation'
> {
  const config = object(row.config)
  const measurement = object(config?.['measurement'])
  const checkpoints = object(config?.['checkpoints'])
  const items = Array.isArray(checkpoints?.['items'])
    ? checkpoints['items']
    : []
  const checkpoint =
    row.checkpoint_id === null
      ? null
      : (items
          .map((value) => object(value))
          .find((value) => value?.['checkpointId'] === row.checkpoint_id) ??
        null)
  const effective =
    checkpoint === null ? measurement : object(checkpoint['satisfaction'])
  const snapshotTitle = row.title ?? 'Закрыть день'
  const title =
    checkpoint === null || typeof checkpoint['name'] !== 'string'
      ? snapshotTitle
      : `${snapshotTitle} · ${checkpoint['name']}`
  if (row.intent_kind === 'close_day') {
    return {
      title: 'Закрыть день',
      unit: null,
      precision: null,
      aggregation: null,
    }
  }
  if (
    row.intent_kind === 'delete_record' ||
    row.intent_kind === 'undo_record' ||
    row.intent_kind === 'weekly_task_result'
  ) {
    return { title, unit: null, precision: null, aggregation: null }
  }
  if (row.intent_kind.startsWith('correct_')) {
    if (row.intent_kind === 'correct_quantity') {
      const precision = measurement?.['precision']
      const unit = measurement?.['unit']
      const aggregation = measurement?.['aggregation']
      if (
        measurement?.['kind'] !== 'quantity' ||
        typeof unit !== 'string' ||
        ![0, 1, 2, 3].includes(precision as number) ||
        (aggregation !== 'add' && aggregation !== 'latest')
      ) {
        throw new Error('Telegram correction quantity target is invalid')
      }
      return {
        title,
        unit,
        precision: precision as 0 | 1 | 2 | 3,
        aggregation,
      }
    }
    if (row.intent_kind === 'correct_or_variant') {
      return { title, unit: null, precision: 3, aggregation: null }
    }
    return { title, unit: null, precision: null, aggregation: null }
  }
  if (
    row.intent_kind === 'boolean' ||
    row.intent_kind === 'checkpoint_boolean'
  ) {
    if (effective?.['kind'] !== 'boolean') {
      throw new Error('Telegram Boolean intent target is invalid')
    }
    return { title, unit: null, precision: null, aggregation: null }
  }
  if (
    row.intent_kind === 'actual_time' ||
    row.intent_kind === 'checkpoint_actual_time'
  ) {
    if (effective?.['kind'] !== 'actual_time') {
      throw new Error('Telegram actual-time intent target is invalid')
    }
    return { title, unit: null, precision: null, aggregation: null }
  }
  if (row.intent_kind === 'rating' || row.intent_kind === 'checkpoint_rating') {
    if (effective?.['kind'] !== 'rating') {
      throw new Error('Telegram rating intent target is invalid')
    }
    return { title, unit: null, precision: null, aggregation: null }
  }
  const isText =
    row.intent_kind === 'text' || row.intent_kind === 'checkpoint_text'
  const isChecklist =
    row.intent_kind === 'checklist_item' ||
    row.intent_kind === 'checkpoint_checklist_item' ||
    row.intent_kind === 'composite_checklist_item'
  const isOrVariant =
    row.intent_kind === 'or_variant' ||
    row.intent_kind === 'checkpoint_or_variant' ||
    row.intent_kind === 'composite_or_variant'
  if (isText) {
    if (effective?.['kind'] !== 'text') {
      throw new Error('Telegram text intent target is invalid')
    }
    return { title, unit: null, precision: null, aggregation: null }
  }
  if (isChecklist) {
    if (effective?.['kind'] !== 'checklist') {
      throw new Error('Telegram checklist intent target is invalid')
    }
    const item = Array.isArray(measurement?.['items'])
      ? (measurement['items']
          .map((value) => object(value))
          .find((value) => value?.['itemId'] === row.checklist_item_id) ?? null)
      : null
    if (item === null || typeof item['label'] !== 'string') {
      throw new Error('Telegram checklist intent component is invalid')
    }
    return {
      title: `${title} · ${item['label']}`,
      unit: null,
      precision: null,
      aggregation: null,
    }
  }
  if (isOrVariant) {
    if (effective?.['kind'] !== 'any_of') {
      throw new Error('Telegram OR intent target is invalid')
    }
    const variant = Array.isArray(measurement?.['variants'])
      ? (measurement['variants']
          .map((value) => object(value))
          .find((value) => value?.['variantId'] === row.or_variant_id) ?? null)
      : null
    const precision = variant?.['precision']
    const unit = variant?.['unit']
    if (
      variant === null ||
      typeof variant['label'] !== 'string' ||
      typeof unit !== 'string' ||
      ![0, 1, 2, 3].includes(precision as number)
    ) {
      throw new Error('Telegram OR intent component is invalid')
    }
    return {
      title: `${title} · ${variant['label']}`,
      unit,
      precision: precision as 0 | 1 | 2 | 3,
      aggregation: null,
    }
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
    title,
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
    checkpointId: row.checkpoint_id,
    booleanResult: row.boolean_result,
    textResult: row.text_result,
    checklistItemId: row.checklist_item_id,
    checklistItemState: row.checklist_item_state,
    orVariantId: row.or_variant_id,
    quantityValue: row.quantity_value,
    actualTimeValue: row.actual_time_value?.slice(0, 5) ?? null,
    ratingValue: row.rating_value,
    textValue: row.text_value,
    orVariantValue: row.or_variant_value,
    factRecordId: row.fact_record_id,
    expectedRecordRevision: row.expected_record_revision,
    flexiblePeriodId: row.flexible_period_id,
    reason: row.reason,
    closePreviewSchemaVersion: row.close_preview_schema_version,
    closePreviewHashVersion: row.close_preview_hash_version,
    closePreviewHash: row.close_preview_hash,
    closeUnresolvedCount: row.close_unresolved_count,
    commandFingerprint: row.command_fingerprint,
    expiresAt: row.expires_at,
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
         intent.intent_kind, intent.state, intent.checkpoint_id,
         intent.boolean_result, intent.text_result,
         intent.checklist_item_id, intent.checklist_item_state,
         intent.or_variant_id, intent.quantity_value,
         intent.actual_time_value::text, intent.rating_value,
         intent.text_value, intent.or_variant_value,
         intent.fact_record_id, intent.expected_record_revision,
         intent.flexible_period_id, intent.reason,
         intent.close_preview_schema_version,
         intent.close_preview_hash_version, intent.close_preview_hash,
         intent.close_unresolved_count,
         intent.command_fingerprint,
         intent.expires_at, snapshot.title, snapshot.config,
         intent.result_kind, intent.result_aggregate_id,
         intent.result_aggregate_revision
    FROM telegram_action_intents intent
    LEFT JOIN plan_goal_snapshots snapshot
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
            AND state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready')
            AND expires_at <= $2`,
        input.semanticKey,
        now,
      )
      await client.$executeRawUnsafe(
        `INSERT INTO telegram_action_intents
           (id, semantic_key, command_id, space_id, member_id,
            publication_id, plan_goal_snapshot_id, local_date,
            source_facts_revision, intent_kind, state, checkpoint_id,
            boolean_result, text_result, checklist_item_id,
            checklist_item_state, or_variant_id,
            fact_record_id, expected_record_revision, flexible_period_id,
            reason, close_preview_schema_version,
            close_preview_hash_version, close_preview_hash,
            close_unresolved_count,
            command_fingerprint, expires_at, created_at, updated_at)
         VALUES
           ($1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
            $5::uuid, $6::uuid, $7::date, $8, $9, $10, $11::uuid, $12,
            $13, $14::uuid, $15, $16::uuid,
            $17::uuid, $18, $19::uuid, $20, $21, $22, $23, $24,
            $25, $26, $27, $27)
         ON CONFLICT (semantic_key)
           WHERE state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready')
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
        input.checkpointId,
        input.booleanResult,
        input.textResult,
        input.checklistItemId,
        input.checklistItemState,
        input.orVariantId,
        input.factRecordId,
        input.expectedRecordRevision,
        input.flexiblePeriodId,
        input.reason,
        input.closePreviewSchemaVersion,
        input.closePreviewHashVersion,
        input.closePreviewHash,
        input.closeUnresolvedCount,
        input.commandFingerprint,
        input.expiresAt,
        now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.semantic_key = $1
            AND intent.state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready')`,
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

  public selectValue(input: {
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
            AND state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready')
            AND expires_at <= $3`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $4
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND id <> $3::uuid AND state IN ('awaiting_value', 'awaiting_reason')`,
        input.spaceId,
        input.memberId,
        input.actionIntentId,
        input.now,
      )
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'awaiting_value', quantity_value = NULL,
                actual_time_value = NULL, rating_value = NULL,
                text_value = NULL, or_variant_value = NULL,
                reason = NULL, command_fingerprint = NULL, updated_at = $4
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid
            AND intent_kind IN (
              'quantity', 'actual_time', 'rating',
              'checkpoint_actual_time', 'checkpoint_rating',
              'text', 'checkpoint_text', 'or_variant',
              'checkpoint_or_variant', 'composite_or_variant'
              , 'correct_quantity', 'correct_actual_time', 'correct_rating',
              'correct_text', 'correct_or_variant'
            )
            AND state IN ('offered', 'ready') AND expires_at > $4`,
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

  public findAwaitingValue(input: {
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $3
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND state IN ('awaiting_value', 'awaiting_reason')
            AND expires_at <= $3`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      const rows = await client.$queryRawUnsafe<IntentRow[]>(
        `${selectIntent}
          WHERE intent.space_id = $1::uuid
            AND intent.member_id = $2::uuid
            AND intent.state IN ('awaiting_value', 'awaiting_reason')
            AND intent.expires_at > $3
          FOR UPDATE OF intent`,
        input.spaceId,
        input.memberId,
        input.now,
      )
      return rows[0] === undefined ? null : stored(rows[0])
    })
  }

  public setValue(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly quantityValue: string | null
    readonly actualTimeValue: string | null
    readonly ratingValue: bigint | null
    readonly textValue: string | null
    readonly orVariantValue: string | null
    readonly commandFingerprint: string | null
    readonly nextState: 'ready' | 'awaiting_reason'
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = $10, quantity_value = $4,
                actual_time_value = $5::time,
                rating_value = $6, text_value = $7,
                or_variant_value = $8, command_fingerprint = $9, updated_at = $11
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid AND state = 'awaiting_value'
            AND expires_at > $11`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
        input.quantityValue,
        input.actualTimeValue,
        input.ratingValue,
        input.textValue,
        input.orVariantValue,
        input.commandFingerprint,
        input.nextState,
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

  public beginReason(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'expired', updated_at = $4
          WHERE space_id = $1::uuid AND member_id = $2::uuid
            AND id <> $3::uuid
            AND state IN ('awaiting_value', 'awaiting_reason')`,
        input.spaceId,
        input.memberId,
        input.actionIntentId,
        input.now,
      )
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'awaiting_reason', reason = NULL,
                command_fingerprint = NULL, updated_at = $4
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid
            AND intent_kind IN (
              'correct_boolean', 'correct_checklist_item', 'delete_record'
            )
            AND state IN ('offered', 'ready') AND expires_at > $4`,
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

  public setReason(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly reason: string
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'ready', reason = $4,
                command_fingerprint = $5, updated_at = $6
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid AND state = 'awaiting_reason'
            AND expires_at > $6`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
        input.reason,
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

  public prepareCloseDay(input: {
    readonly actionIntentId: string
    readonly spaceId: string
    readonly memberId: string
    readonly sourceFactsRevision: bigint
    readonly previewSchemaVersion: string
    readonly previewHashVersion: string
    readonly previewHash: string
    readonly unresolvedCount: number
    readonly commandFingerprint: string
    readonly now: Date
  }): Promise<StoredTelegramActionIntent | null> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        `UPDATE telegram_action_intents
            SET state = 'ready', source_facts_revision = $4,
                close_preview_schema_version = $5,
                close_preview_hash_version = $6,
                close_preview_hash = $7,
                close_unresolved_count = $8,
                command_fingerprint = $9, updated_at = $10
          WHERE id = $1::uuid AND space_id = $2::uuid
            AND member_id = $3::uuid AND intent_kind = 'close_day'
            AND state = 'offered' AND expires_at > $10`,
        input.actionIntentId,
        input.spaceId,
        input.memberId,
        input.sourceFactsRevision,
        input.previewSchemaVersion,
        input.previewHashVersion,
        input.previewHash,
        input.unresolvedCount,
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
      readonly kind: 'tracking.fact-record.v1' | 'tracking.day-close.v1'
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
            AND state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready')`,
        actionIntentId,
        now,
      )
    })
  }
}
