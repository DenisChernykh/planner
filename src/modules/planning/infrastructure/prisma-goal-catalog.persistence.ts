import { randomUUID } from 'node:crypto'

import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  ChangeGoalDefinitionStatePersistenceInput,
  CopyGoalDefinitionPersistenceInput,
  CreateGoalDefinitionPersistenceInput,
  GoalCatalogCommandIdentity,
  GoalCatalogPersistencePort,
  GoalDefinitionRef,
  VersionGoalDefinitionPersistenceInput,
} from '../application/goal-catalog-persistence.port'
import type {
  GoalDefinitionDetail,
  GoalDefinitionListState,
  GoalDefinitionState,
  GoalDefinitionSummary,
  GoalDefinitionVersionView,
  SeriesDecision,
} from '../application/goal-catalog.types'
import {
  GoalDefinitionNotFoundError,
  GoalDefinitionRevisionConflictError,
  GoalDefinitionStateConflictError,
} from '../application/planning-errors'

type Client = Parameters<Parameters<PrismaClientProvider['withClient']>[0]>[0]
type CurrentRow = {
  readonly goal_definition_id: string
  readonly state: string
  readonly revision: bigint
  readonly version_id: string
  readonly version_number: bigint
  readonly series_id: string
  readonly series_decision: string
  readonly title: string
  readonly why: string
  readonly category: string
}
type ViewRow = CurrentRow & { readonly created_at: Date }

function state(value: string): GoalDefinitionState {
  if (value === 'active' || value === 'archived') return value
  throw new Error('Invalid stored goal definition state')
}

function seriesDecision(value: string): SeriesDecision {
  if (value === 'continue' || value === 'new') return value
  throw new Error('Invalid stored series decision')
}

function versionView(row: CurrentRow): GoalDefinitionVersionView {
  return Object.freeze({
    goalDefinitionVersionId: row.version_id,
    versionNumber: row.version_number,
    goalSeriesId: row.series_id,
    seriesDecision: seriesDecision(row.series_decision),
    title: row.title,
    why: row.why,
    category: row.category,
  })
}

function summary(
  row: CurrentRow,
  currentVersion = versionView(row),
): GoalDefinitionSummary {
  return Object.freeze({
    goalDefinitionId: row.goal_definition_id,
    state: state(row.state),
    revision: row.revision,
    currentVersion,
  })
}

export class PrismaGoalCatalogPersistence implements GoalCatalogPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public create(
    input: CreateGoalDefinitionPersistenceInput,
  ): Promise<GoalDefinitionRef> {
    return this.database.withClient(async (client) => {
      const goalDefinitionId = randomUUID()
      const goalSeriesId = randomUUID()
      const versionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO goal_definitions
          (id, space_id, state, revision, created_at, updated_at, archived_at)
        VALUES (${goalDefinitionId}::uuid, ${input.spaceId}::uuid, 'active', 1,
                ${input.occurredAt}, ${input.occurredAt}, NULL)
      `
      await client.$executeRaw`
        INSERT INTO goal_series (id, goal_definition_id, created_at)
        VALUES (${goalSeriesId}::uuid, ${goalDefinitionId}::uuid,
                ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
        VALUES (${versionId}::uuid, ${goalDefinitionId}::uuid, 1,
                ${goalSeriesId}::uuid, 'new', ${input.title}, ${input.why},
                ${input.category}, ${input.occurredAt})
      `
      await this.insertHistory(client, input, {
        actionKind: 'goal_definition_created',
        goalDefinitionId,
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: versionId,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: 'new',
      })
      return { goalDefinitionId, revision: 1n }
    })
  }

  public createVersion(
    input: VersionGoalDefinitionPersistenceInput,
  ): Promise<GoalDefinitionRef> {
    return this.database.withClient(async (client) => {
      const before = await this.current(
        client,
        input.spaceId,
        input.goalDefinitionId,
        true,
      )
      this.assertCurrent(before, input.expectedRevision)
      if (before.state !== 'active') {
        throw new GoalDefinitionStateConflictError(
          'active',
          state(before.state),
          before.revision,
        )
      }
      const nextRevision = before.revision + 1n
      const nextVersion = before.version_number + 1n
      const versionId = randomUUID()
      const goalSeriesId =
        input.seriesDecision === 'continue' ? before.series_id : randomUUID()
      if (input.seriesDecision === 'new') {
        await client.$executeRaw`
          INSERT INTO goal_series (id, goal_definition_id, created_at)
          VALUES (${goalSeriesId}::uuid, ${input.goalDefinitionId}::uuid,
                  ${input.occurredAt})
        `
      }
      await client.$executeRaw`
        INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
        VALUES (${versionId}::uuid, ${input.goalDefinitionId}::uuid,
                ${nextVersion}, ${goalSeriesId}::uuid, ${input.seriesDecision},
                ${input.title}, ${input.why}, ${input.category},
                ${input.occurredAt})
      `
      await client.$executeRaw`
        UPDATE goal_definitions
           SET revision = ${nextRevision}, updated_at = ${input.occurredAt}
         WHERE id = ${input.goalDefinitionId}::uuid
      `
      await this.insertHistory(client, input, {
        actionKind: 'goal_definition_versioned',
        goalDefinitionId: input.goalDefinitionId,
        beforeRevision: before.revision,
        afterRevision: nextRevision,
        beforeState: 'active',
        afterState: 'active',
        beforeVersionId: before.version_id,
        afterVersionId: versionId,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: input.seriesDecision,
      })
      return {
        goalDefinitionId: input.goalDefinitionId,
        revision: nextRevision,
      }
    })
  }

  public changeState(
    input: ChangeGoalDefinitionStatePersistenceInput,
  ): Promise<GoalDefinitionRef> {
    return this.database.withClient(async (client) => {
      const before = await this.current(
        client,
        input.spaceId,
        input.goalDefinitionId,
        true,
      )
      this.assertCurrent(before, input.expectedRevision)
      if (before.state === input.requestedState) {
        throw new GoalDefinitionStateConflictError(
          input.requestedState,
          state(before.state),
          before.revision,
        )
      }
      const nextRevision = before.revision + 1n
      const archivedAt =
        input.requestedState === 'archived' ? input.occurredAt : null
      await client.$executeRaw`
        UPDATE goal_definitions
           SET state = ${input.requestedState}, revision = ${nextRevision},
               updated_at = ${input.occurredAt}, archived_at = ${archivedAt}
         WHERE id = ${input.goalDefinitionId}::uuid
      `
      await this.insertHistory(client, input, {
        actionKind:
          input.requestedState === 'archived'
            ? 'goal_definition_archived'
            : 'goal_definition_restored',
        goalDefinitionId: input.goalDefinitionId,
        beforeRevision: before.revision,
        afterRevision: nextRevision,
        beforeState: state(before.state),
        afterState: input.requestedState,
        beforeVersionId: before.version_id,
        afterVersionId: before.version_id,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: null,
      })
      return {
        goalDefinitionId: input.goalDefinitionId,
        revision: nextRevision,
      }
    })
  }

  public copy(
    input: CopyGoalDefinitionPersistenceInput,
  ): Promise<GoalDefinitionRef> {
    return this.database.withClient(async (client) => {
      const source = await this.current(
        client,
        input.spaceId,
        input.sourceGoalDefinitionId,
        true,
      )
      this.assertCurrent(source, input.expectedRevision)
      const goalDefinitionId = randomUUID()
      const goalSeriesId = randomUUID()
      const versionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO goal_definitions
          (id, space_id, state, revision, created_at, updated_at, archived_at)
        VALUES (${goalDefinitionId}::uuid, ${input.spaceId}::uuid, 'active', 1,
                ${input.occurredAt}, ${input.occurredAt}, NULL)
      `
      await client.$executeRaw`
        INSERT INTO goal_series (id, goal_definition_id, created_at)
        VALUES (${goalSeriesId}::uuid, ${goalDefinitionId}::uuid,
                ${input.occurredAt})
      `
      await client.$executeRaw`
        INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
        VALUES (${versionId}::uuid, ${goalDefinitionId}::uuid, 1,
                ${goalSeriesId}::uuid, 'new', ${source.title}, ${source.why},
                ${source.category}, ${input.occurredAt})
      `
      await this.insertHistory(client, input, {
        actionKind: 'goal_definition_copied',
        goalDefinitionId,
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: versionId,
        copySourceDefinitionId: input.sourceGoalDefinitionId,
        copySourceVersionId: source.version_id,
        seriesDecision: 'new',
      })
      return { goalDefinitionId, revision: 1n }
    })
  }

  public list(
    spaceId: string,
    requestedState: GoalDefinitionListState,
  ): Promise<readonly GoalDefinitionSummary[]> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<ViewRow[]>`
        SELECT d.id::text goal_definition_id, d.state, d.revision, d.created_at,
               v.id::text version_id, v.version_number,
               v.goal_series_id::text series_id, v.series_decision,
               v.title, v.why, v.category
          FROM goal_definitions d
          JOIN LATERAL (
            SELECT * FROM goal_definition_versions
             WHERE goal_definition_id = d.id
             ORDER BY version_number DESC LIMIT 1
          ) v ON TRUE
         WHERE d.space_id = ${spaceId}::uuid
           AND (${requestedState} = 'all' OR d.state = ${requestedState})
         ORDER BY d.created_at, d.id
      `
      return Object.freeze(rows.map((row) => summary(row)))
    })
  }

  public get(
    spaceId: string,
    goalDefinitionId: string,
  ): Promise<GoalDefinitionDetail | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<CurrentRow[]>`
        SELECT d.id::text goal_definition_id, d.state, d.revision,
               v.id::text version_id, v.version_number,
               v.goal_series_id::text series_id, v.series_decision,
               v.title, v.why, v.category
          FROM goal_definitions d
          JOIN goal_definition_versions v ON v.goal_definition_id = d.id
         WHERE d.id = ${goalDefinitionId}::uuid
           AND d.space_id = ${spaceId}::uuid
         ORDER BY v.version_number DESC
      `
      const current = rows[0]
      if (current === undefined) return null
      const versions = Object.freeze(rows.map(versionView))
      return Object.freeze({
        ...summary(current, versions[0]),
        versions,
      })
    })
  }

  private async current(
    client: Client,
    spaceId: string,
    goalDefinitionId: string,
    lock: boolean,
  ): Promise<CurrentRow | null> {
    const rows = lock
      ? await client.$queryRaw<CurrentRow[]>`
          SELECT d.id::text goal_definition_id, d.state, d.revision,
                 v.id::text version_id, v.version_number,
                 v.goal_series_id::text series_id, v.series_decision,
                 v.title, v.why, v.category
            FROM goal_definitions d
            JOIN LATERAL (
              SELECT * FROM goal_definition_versions
               WHERE goal_definition_id = d.id
               ORDER BY version_number DESC LIMIT 1
            ) v ON TRUE
           WHERE d.id = ${goalDefinitionId}::uuid
             AND d.space_id = ${spaceId}::uuid
           FOR UPDATE OF d
        `
      : await client.$queryRaw<CurrentRow[]>`
          SELECT d.id::text goal_definition_id, d.state, d.revision,
                 v.id::text version_id, v.version_number,
                 v.goal_series_id::text series_id, v.series_decision,
                 v.title, v.why, v.category
            FROM goal_definitions d
            JOIN LATERAL (
              SELECT * FROM goal_definition_versions
               WHERE goal_definition_id = d.id
               ORDER BY version_number DESC LIMIT 1
            ) v ON TRUE
           WHERE d.id = ${goalDefinitionId}::uuid
             AND d.space_id = ${spaceId}::uuid
        `
    return rows[0] ?? null
  }

  private assertCurrent(
    current: CurrentRow | null,
    expectedRevision: bigint,
  ): asserts current is CurrentRow {
    if (current === null) throw new GoalDefinitionNotFoundError()
    if (current.revision !== expectedRevision) {
      throw new GoalDefinitionRevisionConflictError(
        expectedRevision,
        current.revision,
        state(current.state),
      )
    }
  }

  private async insertHistory(
    client: Client,
    input: GoalCatalogCommandIdentity,
    change: {
      readonly actionKind:
        | 'goal_definition_created'
        | 'goal_definition_versioned'
        | 'goal_definition_archived'
        | 'goal_definition_restored'
        | 'goal_definition_copied'
      readonly goalDefinitionId: string
      readonly beforeRevision: bigint | null
      readonly afterRevision: bigint
      readonly beforeState: GoalDefinitionState | null
      readonly afterState: GoalDefinitionState
      readonly beforeVersionId: string | null
      readonly afterVersionId: string
      readonly copySourceDefinitionId: string | null
      readonly copySourceVersionId: string | null
      readonly seriesDecision: SeriesDecision | null
    },
  ): Promise<void> {
    const actionId = randomUUID()
    await client.$executeRaw`
      INSERT INTO planning_action_groups
        (id, action_kind, actor_kind, actor_scope, member_id, system_actor_id,
         plan_month_id, goal_definition_id, command_type, command_id,
         before_revision, after_revision, occurred_at)
      VALUES (${actionId}::uuid, ${change.actionKind}, 'member',
              ${input.actorScope}, ${input.memberId}::uuid, NULL, NULL,
              ${change.goalDefinitionId}::uuid, ${input.commandType},
              ${input.commandId}::uuid, ${change.beforeRevision},
              ${change.afterRevision}, ${input.occurredAt})
    `
    await client.$executeRaw`
      INSERT INTO planning_goal_catalog_changes
        (action_id, goal_definition_id, before_state, after_state,
         before_version_id, after_version_id, copy_source_definition_id,
         copy_source_version_id, series_decision)
      VALUES (${actionId}::uuid, ${change.goalDefinitionId}::uuid,
              ${change.beforeState}, ${change.afterState},
              ${change.beforeVersionId}::uuid, ${change.afterVersionId}::uuid,
              ${change.copySourceDefinitionId}::uuid,
              ${change.copySourceVersionId}::uuid, ${change.seriesDecision})
    `
  }
}
