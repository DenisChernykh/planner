import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  FactPersistencePort,
  FactRecordRef,
  GetFactStatePersistenceInput,
  RecordFactPersistenceInput,
} from '../application/fact-persistence.port'
import {
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
} from '../application/tracking-errors'
import type {
  FactStateV1,
  FactValueStateV1,
  QuantityAddContributionV1,
} from '../application/tracking.types'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]

export type FactWritePhase =
  'record' | 'revision' | 'pointer' | 'facts_revision' | 'history'

export type FactWriteObserver = (phase: FactWritePhase) => void | Promise<void>

type TargetRow = {
  readonly plan_month_id: string
  readonly facts_revision: bigint
  readonly status: string
  readonly active_publication_id: string | null
  readonly month_start: string
  readonly month_end: string
  readonly active_local_date: string
  readonly space_id: string
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
  readonly config: unknown
  readonly fixed_expectation_id: string | null
  readonly flexible_period_id: string | null
}

type CurrentRecordRow = {
  readonly id: string
  readonly current_revision_id: string | null
  readonly revision_number: bigint | null
}

type StateRow = {
  readonly fact_record_id: string
  readonly fact_kind: 'boolean' | 'quantity_add' | 'quantity_latest'
  readonly contribution_id: string | null
  readonly revision_number: bigint
  readonly revision_kind: 'recorded' | 'tombstoned'
  readonly boolean_result: 'done' | 'not_done' | null
  readonly quantity_value: string | null
  readonly recorded_by_member_id: string
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Published fact config is invalid')
  }
  return value as Record<string, unknown>
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function quantityScale(value: string): number {
  const point = value.indexOf('.')
  return point < 0 ? 0 : value.length - point - 1
}

export class PrismaFactPersistence implements FactPersistencePort {
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly afterWritePhase: FactWriteObserver = () => undefined,
  ) {}

  public record(input: RecordFactPersistenceInput): Promise<FactRecordRef> {
    return this.database.withClient(async (client) => {
      const target = await this.lockTarget(client, input)
      if (input.localDate > input.currentLocalDate) {
        throw new FactTargetUnavailableError('future_date')
      }
      if (target.status === 'closed') {
        throw new FactTargetUnavailableError('closed')
      }
      if (
        target.active_publication_id !== input.publicationId ||
        !['published', 'grace'].includes(target.status) ||
        input.currentLocalDate < target.active_local_date ||
        input.localDate < target.active_local_date
      ) {
        throw new FactTargetUnavailableError('not_active')
      }
      if (
        input.localDate < target.month_start ||
        input.localDate > target.month_end ||
        (target.fixed_expectation_id === null &&
          target.flexible_period_id === null)
      ) {
        throw new FactTargetUnavailableError('not_applicable')
      }
      if (
        target.scope_kind === 'personal' &&
        target.owner_member_id !== input.memberId
      ) {
        throw new TrackingAuthorizationDeniedError()
      }

      const config = record(target.config)
      const measurement = record(config['measurement'])
      const checkpoints = config['checkpoints']
      const repetition = record(config['repetition'])
      if (
        checkpoints !== null ||
        repetition['kind'] === 'weekly_planned_task'
      ) {
        throw new FactTargetUnavailableError('unsupported')
      }

      let factKind: 'boolean' | 'quantity_add' | 'quantity_latest'
      if (measurement['kind'] === 'boolean') {
        if (input.value.kind !== 'boolean') throw new FactValueInvalidError()
        factKind = 'boolean'
      } else if (measurement['kind'] === 'quantity') {
        if (input.value.kind !== 'quantity') throw new FactValueInvalidError()
        const precision = measurement['precision']
        if (
          !Number.isInteger(precision) ||
          ![0, 1, 2, 3].includes(precision as number) ||
          quantityScale(input.value.value) > (precision as number)
        ) {
          throw new FactValueInvalidError()
        }
        if (measurement['aggregation'] === 'add') factKind = 'quantity_add'
        else if (measurement['aggregation'] === 'latest') {
          factKind = 'quantity_latest'
        } else throw new FactValueInvalidError()
      } else {
        throw new FactValueInvalidError()
      }

      const existing =
        factKind === 'quantity_add'
          ? null
          : await this.findCurrentRecord(client, input)
      if (factKind === 'quantity_add') {
        if (input.expectedRevision !== null) {
          throw new FactRevisionConflictError(input.expectedRevision, null)
        }
      } else if (existing === null) {
        if (input.expectedRevision !== null) {
          throw new FactRevisionConflictError(input.expectedRevision, null)
        }
      } else if (
        input.expectedRevision === null ||
        existing.revision_number !== input.expectedRevision
      ) {
        throw new FactRevisionConflictError(
          input.expectedRevision,
          existing.revision_number,
        )
      }

      const factRecordId = existing?.id ?? randomUUID()
      const beforeRevisionId = existing?.current_revision_id ?? null
      const factRevision = (existing?.revision_number ?? 0n) + 1n
      const afterRevisionId = randomUUID()
      if (existing === null) {
        const contributionId = factKind === 'quantity_add' ? randomUUID() : null
        await client.$executeRaw`
          INSERT INTO tracking_fact_records
            (id, space_id, plan_month_id, publication_id,
             plan_goal_snapshot_id, local_date, fact_kind,
             fixed_expectation_id, flexible_period_id, contribution_id,
             current_revision_id, created_by_member_id, created_at, updated_at)
          VALUES
            (${factRecordId}::uuid, ${target.space_id}::uuid,
             ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
             ${input.planGoalSnapshotId}::uuid, ${input.localDate}::date,
             ${factKind}, ${target.fixed_expectation_id}::uuid,
             ${target.flexible_period_id}::uuid, ${contributionId}::uuid,
             NULL, ${input.memberId}::uuid, ${input.occurredAt},
             ${input.occurredAt})
        `
        await this.afterWritePhase('record')
      }

      const booleanResult =
        input.value.kind === 'boolean' ? input.value.result : null
      const quantityValue =
        input.value.kind === 'quantity' ? input.value.value : null
      await client.$executeRaw`
        INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, recorded_by_member_id, created_at)
        VALUES
          (${afterRevisionId}::uuid, ${factRecordId}::uuid, ${factRevision},
           'recorded', ${booleanResult}, ${quantityValue},
           ${input.memberId}::uuid, ${input.occurredAt})
      `
      await this.afterWritePhase('revision')
      await client.$executeRaw`
        UPDATE tracking_fact_records
           SET current_revision_id = ${afterRevisionId}::uuid,
               updated_at = ${input.occurredAt}
         WHERE id = ${factRecordId}::uuid
      `
      await this.afterWritePhase('pointer')

      const beforeFactsRevision = target.facts_revision
      const afterFactsRevision = beforeFactsRevision + 1n
      await client.$executeRaw`
        UPDATE plan_months
           SET facts_revision = ${afterFactsRevision}
         WHERE id = ${target.plan_month_id}::uuid
           AND facts_revision = ${beforeFactsRevision}
      `
      await this.afterWritePhase('facts_revision')

      const actionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, occurred_at)
        VALUES
          (${actionId}::uuid, 'fact_recorded', 'member', ${input.actorScope},
           ${input.memberId}::uuid, ${input.spaceId}::uuid,
           ${target.plan_month_id}::uuid, ${input.publicationId}::uuid,
           ${input.planGoalSnapshotId}::uuid, ${input.commandType},
           ${input.commandId}::uuid, ${beforeFactsRevision},
           ${afterFactsRevision}, ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
        VALUES
          (${actionId}::uuid, ${factRecordId}::uuid,
           ${beforeRevisionId}::uuid, ${afterRevisionId}::uuid)
      `
      await this.afterWritePhase('history')
      return { factRecordId, factRevision }
    })
  }

  public getState(
    input: GetFactStatePersistenceInput,
  ): Promise<FactStateV1 | null> {
    return this.database.withClient(async (client) => {
      const header = await client.$queryRaw<
        { readonly facts_revision: bigint }[]
      >`
        SELECT month.facts_revision
          FROM plan_publications publication
          JOIN plan_months month ON month.id = publication.plan_month_id
          JOIN plan_goal_snapshots snapshot
            ON snapshot.publication_id = publication.id
           AND snapshot.id = ${input.planGoalSnapshotId}::uuid
         WHERE publication.id = ${input.publicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
      `
      if (header.length === 0) return null
      const rows = await client.$queryRaw<StateRow[]>`
        SELECT record.id::text fact_record_id, record.fact_kind,
               record.contribution_id::text, revision.revision_number,
               revision.revision_kind, revision.boolean_result,
               revision.quantity_value,
               revision.recorded_by_member_id::text
          FROM tracking_fact_records record
          JOIN tracking_fact_revisions revision
            ON revision.id = record.current_revision_id
          JOIN tracking_fact_changes fact_change
            ON fact_change.after_revision_id = revision.id
          JOIN tracking_action_groups action
            ON action.id = fact_change.action_id
         WHERE record.publication_id = ${input.publicationId}::uuid
           AND record.plan_goal_snapshot_id = ${input.planGoalSnapshotId}::uuid
           AND record.local_date = ${input.localDate}::date
           AND revision.revision_kind = 'recorded'
         ORDER BY action.after_facts_revision, record.id
      `
      let fact: FactValueStateV1 | null = null
      const first = rows[0]
      if (first?.fact_kind === 'quantity_add') {
        const contributions: QuantityAddContributionV1[] = rows.map((row) => {
          if (
            row.fact_kind !== 'quantity_add' ||
            row.contribution_id === null ||
            row.quantity_value === null
          ) {
            throw new Error('Stored add fact state is invalid')
          }
          return {
            contributionId: row.contribution_id,
            factRecordId: row.fact_record_id,
            revision: row.revision_number,
            value: row.quantity_value,
            recordedByMemberId: row.recorded_by_member_id,
          }
        })
        fact = { kind: 'quantity_add', contributions }
      } else if (first?.fact_kind === 'quantity_latest') {
        if (first.quantity_value === null || rows.length !== 1) {
          throw new Error('Stored latest fact state is invalid')
        }
        fact = {
          kind: 'quantity_latest',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          value: first.quantity_value,
          recordedByMemberId: first.recorded_by_member_id,
        }
      } else if (first?.fact_kind === 'boolean') {
        if (first.boolean_result === null || rows.length !== 1) {
          throw new Error('Stored Boolean fact state is invalid')
        }
        fact = {
          kind: 'boolean',
          factRecordId: first.fact_record_id,
          revision: first.revision_number,
          result: first.boolean_result,
          recordedByMemberId: first.recorded_by_member_id,
        }
      }
      return freeze({
        publicationId: input.publicationId,
        planGoalSnapshotId: input.planGoalSnapshotId,
        localDate: input.localDate,
        factsRevision: header[0]!.facts_revision,
        fact,
      })
    })
  }

  private async lockTarget(
    client: Client,
    input: RecordFactPersistenceInput,
  ): Promise<TargetRow> {
    const rows = await client.$queryRaw<TargetRow[]>`
      SELECT month.id::text plan_month_id, month.facts_revision, month.status,
             month.active_publication_id::text,
             month.month_start::text,
             (month.month_start + INTERVAL '1 month - 1 day')::date::text month_end,
             publication.active_local_date::text,
             publication.space_id::text space_id,
             snapshot.scope_kind, snapshot.owner_member_id::text,
             snapshot.config,
             expectation.id::text fixed_expectation_id,
             period.id::text flexible_period_id
        FROM plan_publications publication
        JOIN plan_months month ON month.id = publication.plan_month_id
        JOIN plan_goal_snapshots snapshot
          ON snapshot.publication_id = publication.id
         AND snapshot.id = ${input.planGoalSnapshotId}::uuid
        LEFT JOIN fixed_expectations expectation
          ON expectation.publication_id = snapshot.publication_id
         AND expectation.plan_goal_snapshot_id = snapshot.id
         AND expectation.expectation_date = ${input.localDate}::date
         AND expectation.component_kind = 'goal'
         AND expectation.component_id IS NULL
        LEFT JOIN LATERAL (
          SELECT candidate.id
            FROM flexible_periods candidate
           WHERE candidate.publication_id = snapshot.publication_id
             AND candidate.plan_goal_snapshot_id = snapshot.id
             AND candidate.period_target > 0
             AND ${input.localDate}::date = ANY(candidate.eligible_dates)
           ORDER BY candidate.ordinal, candidate.id
           LIMIT 1
        ) period ON TRUE
       WHERE publication.id = ${input.publicationId}::uuid
         AND publication.space_id = ${input.spaceId}::uuid
       FOR UPDATE OF month
    `
    const target = rows[0]
    if (target === undefined) throw new FactTargetNotFoundError()
    return target
  }

  private async findCurrentRecord(
    client: Client,
    input: RecordFactPersistenceInput,
  ): Promise<CurrentRecordRow | null> {
    const rows = await client.$queryRaw<CurrentRecordRow[]>`
      SELECT record.id::text, record.current_revision_id::text,
             revision.revision_number
        FROM tracking_fact_records record
        LEFT JOIN tracking_fact_revisions revision
          ON revision.id = record.current_revision_id
       WHERE record.publication_id = ${input.publicationId}::uuid
         AND record.plan_goal_snapshot_id = ${input.planGoalSnapshotId}::uuid
         AND record.local_date = ${input.localDate}::date
         AND record.fact_kind IN ('boolean', 'quantity_latest')
    `
    return rows[0] ?? null
  }
}
