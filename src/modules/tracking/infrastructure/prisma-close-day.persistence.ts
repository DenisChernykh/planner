import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  CloseDayPersistenceInput,
  CloseDayPersistencePort,
  CloseDayPreviewPersistenceInput,
  CloseDayPreviewPersistenceState,
  DayCloseRef,
} from '../application/close-day-persistence.port'
import { closeDayPreviewHash } from '../application/close-day-preview'
import type {
  CloseDayComponentKindV1,
  CloseDayPreviewItemV1,
} from '../application/close-day.types'
import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
} from '../application/close-day.types'
import {
  CloseDayAlreadyClosedError,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
} from '../application/tracking-errors'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

const MAX_CLOSE_DAY_EXPECTATIONS = 10_000

export type CloseDayWritePhase =
  | 'records'
  | 'revisions'
  | 'pointers'
  | 'facts_revision'
  | 'history'
  | 'changes'
  | 'closure_detail'

export type CloseDayWriteObserver = (
  phase: CloseDayWritePhase,
) => void | Promise<void>

type HeaderRow = {
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly active_publication_id: string | null
  readonly month_start: string
  readonly month_end: string
  readonly active_local_date: string
  readonly correction_deadline: string
}

type ClosureRow = {
  readonly action_id: string
  readonly after_facts_revision: bigint
  readonly occurred_at: Date
  readonly closed_count: number
}

type UnresolvedRow = {
  readonly fixed_expectation_id: string
  readonly plan_goal_snapshot_id: string
  readonly goal_title: string
  readonly display_order: number
  readonly scope_kind: 'personal' | 'shared'
  readonly component_kind: CloseDayComponentKindV1
  readonly component_id: string | null
  readonly config: unknown
}

type MaterializedClose = UnresolvedRow & {
  readonly recordId: string
  readonly revisionId: string
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored CloseDay config is invalid')
  }
  return value as Record<string, unknown>
}

function componentLabel(row: UnresolvedRow): string | null {
  if (row.component_kind === 'goal') return null
  const config = object(row.config)
  if (row.component_kind === 'checkpoint') {
    const checkpoints = object(config['checkpoints'])
    const storedItems = checkpoints['items']
    if (!Array.isArray(storedItems)) {
      throw new Error('Stored checkpoints are invalid')
    }
    const items = storedItems as readonly unknown[]
    const item = items.find(
      (value) => object(value)['checkpointId'] === row.component_id,
    )
    const name = item === undefined ? undefined : object(item)['name']
    if (typeof name !== 'string') {
      throw new Error('Stored checkpoint label is invalid')
    }
    return name
  }
  const measurement = object(config['measurement'])
  const storedItems = measurement['items']
  if (!Array.isArray(storedItems))
    throw new Error('Stored checklist is invalid')
  const items = storedItems as readonly unknown[]
  const item = items.find(
    (value) => object(value)['itemId'] === row.component_id,
  )
  const label = item === undefined ? undefined : object(item)['label']
  if (typeof label !== 'string') {
    throw new Error('Stored checklist label is invalid')
  }
  return label
}

function previewItems(
  rows: readonly UnresolvedRow[],
): readonly CloseDayPreviewItemV1[] {
  if (rows.length > MAX_CLOSE_DAY_EXPECTATIONS) {
    throw new Error('CloseDay exceeds its bounded expectation set')
  }
  return rows.map((row) => ({
    fixedExpectationId: row.fixed_expectation_id,
    planGoalSnapshotId: row.plan_goal_snapshot_id,
    goalTitle: row.goal_title,
    componentKind: row.component_kind,
    componentId: row.component_id,
    componentLabel: componentLabel(row),
    scope: row.scope_kind,
  }))
}

function validateTarget(
  header: HeaderRow,
  input: CloseDayPreviewPersistenceInput,
): void {
  if (input.localDate > input.currentLocalDate) {
    throw new CloseDayTargetUnavailableError('future_date')
  }
  if (
    input.localDate < header.month_start ||
    input.localDate > header.month_end ||
    input.localDate < header.active_local_date
  ) {
    throw new CloseDayTargetUnavailableError('not_applicable')
  }
  if (
    header.status === 'closed' ||
    input.currentLocalDate > header.correction_deadline
  ) {
    throw new CloseDayTargetUnavailableError('closed')
  }
  if (
    header.active_publication_id !== input.publicationId ||
    !['published', 'grace'].includes(header.status) ||
    input.currentLocalDate < header.active_local_date
  ) {
    throw new CloseDayTargetUnavailableError('not_active')
  }
}

export class PrismaCloseDayPersistence implements CloseDayPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: CloseDayWriteObserver = () => undefined,
  ) {}

  public preview(
    input: CloseDayPreviewPersistenceInput,
  ): Promise<CloseDayPreviewPersistenceState> {
    return this.database.withClient(async (client) => {
      await client.$executeRawUnsafe(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      const header = await this.header(client, input, false)
      validateTarget(header, input)
      const existing = await this.existingClosure(client, input)
      if (existing !== undefined) return this.closedState(existing)
      const rows = await this.unresolved(client, input)
      return {
        state: 'ready',
        factsRevision: header.facts_revision,
        unresolved: previewItems(rows),
      }
    })
  }

  public close(input: CloseDayPersistenceInput): Promise<DayCloseRef> {
    return this.database.withClient(async (client) => {
      const header = await this.header(client, input, true)
      validateTarget(header, input)
      const existing = await this.existingClosure(client, input)
      if (existing !== undefined) {
        throw new CloseDayAlreadyClosedError({
          dayCloseId: existing.action_id,
          revision: existing.after_facts_revision,
        })
      }
      if (header.facts_revision !== input.expectedRevision) {
        throw new CloseDayRevisionConflictError(
          input.expectedRevision,
          header.facts_revision,
        )
      }
      const unresolvedRows = await this.unresolved(client, input)
      const unresolved = previewItems(unresolvedRows)
      const actualHash = closeDayPreviewHash({
        publicationId: input.publicationId,
        localDate: input.localDate,
        memberId: input.memberId,
        factsRevision: header.facts_revision,
        unresolved,
      })
      if (
        input.previewSchemaVersion !== CLOSE_DAY_PREVIEW_SCHEMA_VERSION ||
        input.previewHashVersion !== CLOSE_DAY_PREVIEW_HASH_VERSION ||
        input.previewHash !== actualHash
      ) {
        throw new CloseDayPreviewConflictError()
      }

      const materialized: readonly MaterializedClose[] = unresolvedRows.map(
        (row) => ({ ...row, recordId: randomUUID(), revisionId: randomUUID() }),
      )
      const payload = JSON.stringify(
        materialized.map((row) => ({
          record_id: row.recordId,
          revision_id: row.revisionId,
          expectation_id: row.fixed_expectation_id,
          snapshot_id: row.plan_goal_snapshot_id,
        })),
      )
      if (materialized.length > 0) {
        await client.$executeRaw`
          INSERT INTO tracking_fact_records
            (id, space_id, plan_month_id, publication_id,
             plan_goal_snapshot_id, local_date, fact_kind,
             fixed_expectation_id, flexible_period_id, contribution_id,
             checklist_item_id, or_variant_id, current_revision_id,
             created_by_member_id, created_at, updated_at)
          SELECT item.record_id, ${input.spaceId}::uuid,
                 ${header.plan_month_id}::uuid, ${input.publicationId}::uuid,
                 item.snapshot_id, ${input.localDate}::date,
                 'fixed_not_done', item.expectation_id,
                 NULL, NULL, NULL, NULL, NULL,
                 ${input.memberId}::uuid, ${input.occurredAt}, ${input.occurredAt}
            FROM jsonb_to_recordset(${payload}::jsonb) AS item(
              record_id uuid, revision_id uuid, expectation_id uuid,
              snapshot_id uuid
            )
        `
        await this.afterWritePhase('records')
        await client.$executeRaw`
          INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, actual_time_value, rating_value,
             text_value, text_result, checklist_item_state, or_variant_value,
             fixed_outcome, recorded_by_member_id, created_at)
          SELECT item.revision_id, item.record_id, 1, 'recorded',
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 'not_done', ${input.memberId}::uuid, ${input.occurredAt}
            FROM jsonb_to_recordset(${payload}::jsonb) AS item(
              record_id uuid, revision_id uuid, expectation_id uuid,
              snapshot_id uuid
            )
        `
        await this.afterWritePhase('revisions')
        await client.$executeRaw`
          UPDATE tracking_fact_records record
             SET current_revision_id = item.revision_id
            FROM jsonb_to_recordset(${payload}::jsonb) AS item(
              record_id uuid, revision_id uuid, expectation_id uuid,
              snapshot_id uuid
            )
           WHERE record.id = item.record_id
        `
        await this.afterWritePhase('pointers')
      }

      const afterFactsRevision = header.facts_revision + 1n
      const updated = await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${header.plan_month_id}::uuid
           AND facts_revision = ${header.facts_revision}
      `
      if (updated !== 1) {
        throw new CloseDayRevisionConflictError(
          input.expectedRevision,
          header.facts_revision,
        )
      }
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
        VALUES
          (${actionId}::uuid, 'day_closed', 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${header.plan_month_id}::uuid, ${input.publicationId}::uuid,
           NULL, 'tracking.close-day.v1', ${input.commandId}::uuid,
           ${header.facts_revision}, ${afterFactsRevision}, NULL,
           ${input.occurredAt})
      `
      await this.afterWritePhase('history')
      if (materialized.length > 0) {
        await client.$executeRaw`
          INSERT INTO tracking_fact_changes
            (action_id, fact_record_id, before_revision_id, after_revision_id)
          SELECT ${actionId}::uuid, item.record_id, NULL, item.revision_id
            FROM jsonb_to_recordset(${payload}::jsonb) AS item(
              record_id uuid, revision_id uuid, expectation_id uuid,
              snapshot_id uuid
            )
        `
        await this.afterWritePhase('changes')
      }
      const expectationIds = materialized.map((row) => row.fixed_expectation_id)
      await client.$executeRaw`
        INSERT INTO tracking_day_closures
          (action_id, publication_id, local_date, member_id,
           preview_schema_version, preview_hash_version, preview_hash,
           expectation_ids, closed_count)
        VALUES
          (${actionId}::uuid, ${input.publicationId}::uuid,
           ${input.localDate}::date, ${input.memberId}::uuid,
           ${input.previewSchemaVersion}, ${input.previewHashVersion},
           ${input.previewHash}, ${expectationIds}::uuid[],
           ${materialized.length})
      `
      await this.afterWritePhase('closure_detail')
      return { dayCloseId: actionId, factsRevision: afterFactsRevision }
    })
  }

  private async header(
    client: Client,
    input: CloseDayPreviewPersistenceInput,
    lock: boolean,
  ): Promise<HeaderRow> {
    const suffix = lock ? ' FOR UPDATE OF month' : ''
    const rows = await client.$queryRawUnsafe<HeaderRow[]>(
      `SELECT month.id::text plan_month_id, month.facts_revision,
              month.status, month.active_publication_id::text,
              month.month_start::text,
              (month.month_start + INTERVAL '1 month - 1 day')::date::text
                month_end,
              publication.active_local_date::text,
              (month.month_start + INTERVAL '1 month + 2 days')::date::text
                correction_deadline
         FROM plan_publications publication
         JOIN plan_months month ON month.id = publication.plan_month_id
        WHERE publication.id = $1::uuid
          AND publication.space_id = $2::uuid${suffix}`,
      input.publicationId,
      input.spaceId,
    )
    const header = rows[0]
    if (header === undefined) throw new CloseDayTargetNotFoundError()
    return header
  }

  private async existingClosure(
    client: Client,
    input: CloseDayPreviewPersistenceInput,
  ): Promise<ClosureRow | undefined> {
    const rows = await client.$queryRaw<ClosureRow[]>`
      SELECT detail.action_id::text, action.after_facts_revision,
             action.occurred_at, detail.closed_count
        FROM tracking_day_closures detail
        JOIN tracking_action_groups action ON action.id = detail.action_id
       WHERE detail.publication_id = ${input.publicationId}::uuid
         AND detail.local_date = ${input.localDate}::date
         AND detail.member_id = ${input.memberId}::uuid
    `
    return rows[0]
  }

  private closedState(row: ClosureRow): CloseDayPreviewPersistenceState {
    return {
      state: 'closed',
      dayCloseId: row.action_id,
      revision: row.after_facts_revision,
      closedAt: new Date(row.occurred_at.getTime()),
      closedCount: row.closed_count,
    }
  }

  private unresolved(
    client: Client,
    input: CloseDayPreviewPersistenceInput,
  ): Promise<UnresolvedRow[]> {
    return client.$queryRaw<UnresolvedRow[]>`
      SELECT expectation.id::text fixed_expectation_id,
             snapshot.id::text plan_goal_snapshot_id,
             snapshot.title goal_title, snapshot.display_order,
             snapshot.scope_kind, expectation.component_kind,
             expectation.component_id::text, snapshot.config
        FROM fixed_expectations expectation
        JOIN plan_goal_snapshots snapshot
          ON snapshot.publication_id = expectation.publication_id
         AND snapshot.id = expectation.plan_goal_snapshot_id
       WHERE expectation.publication_id = ${input.publicationId}::uuid
         AND expectation.expectation_date = ${input.localDate}::date
         AND (
           snapshot.scope_kind = 'shared'
           OR snapshot.owner_member_id = ${input.memberId}::uuid
         )
         AND NOT EXISTS (
           SELECT 1
             FROM tracking_fact_records record
             JOIN tracking_fact_revisions revision
               ON revision.id = record.current_revision_id
            WHERE record.fixed_expectation_id = expectation.id
              AND revision.revision_kind = 'recorded'
         )
       ORDER BY snapshot.display_order,
                CASE expectation.component_kind
                  WHEN 'goal' THEN 0
                  WHEN 'checkpoint' THEN 1
                  ELSE 2
                END,
                expectation.component_id NULLS FIRST, expectation.id
       LIMIT ${MAX_CLOSE_DAY_EXPECTATIONS + 1}
    `
  }
}
