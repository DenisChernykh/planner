import type { PoolClient } from 'pg'

export const LIST_PLAN_MONTH_FIXTURES = {
  future: {
    planMonthId: '10000000-0000-4000-8000-000000000001',
    publicationId: '20000000-0000-4000-8000-000000000001',
    targetMonth: '2031-04',
    publicationRevision: '1',
    lifecycleRevision: '2',
  },
  active: {
    planMonthId: '10000000-0000-4000-8000-000000000002',
    publicationId: '20000000-0000-4000-8000-000000000002',
    targetMonth: '2031-03',
    publicationRevision: '1',
    lifecycleRevision: '2',
  },
  cancelled: {
    planMonthId: '10000000-0000-4000-8000-000000000003',
    publicationId: '20000000-0000-4000-8000-000000000003',
    targetMonth: '2031-02',
    publicationRevision: '1',
    lifecycleRevision: '3',
  },
  graceOrdinary: {
    planMonthId: '10000000-0000-4000-8000-000000000004',
    publicationId: '20000000-0000-4000-8000-000000000004',
    targetMonth: '2031-01',
    publicationRevision: '1',
    lifecycleRevision: '3',
  },
  graceReopened: {
    planMonthId: '10000000-0000-4000-8000-000000000005',
    publicationId: '20000000-0000-4000-8000-000000000005',
    reportRevisionId: '30000000-0000-4000-8000-000000000005',
    targetMonth: '2030-12',
    publicationRevision: '1',
    reportRevision: '1',
    lifecycleRevision: '5',
  },
  closedOrdinary: {
    planMonthId: '10000000-0000-4000-8000-000000000006',
    publicationId: '20000000-0000-4000-8000-000000000006',
    reportRevisionId: '30000000-0000-4000-8000-000000000006',
    targetMonth: '2030-11',
    publicationRevision: '1',
    reportRevision: '1',
    lifecycleRevision: '4',
  },
  closedReopened: {
    planMonthId: '10000000-0000-4000-8000-000000000007',
    publicationId: '20000000-0000-4000-8000-000000000007',
    reportRevisionId: '30000000-0000-4000-8000-000000000007',
    originalReportRevisionId: '30000000-0000-4000-8000-000000000008',
    targetMonth: '2030-10',
    publicationRevision: '1',
    reportRevision: '2',
    lifecycleRevision: '6',
  },
} as const

const HASH = 'a'.repeat(64)
const CHECKSUM = 'b'.repeat(64)
const CREATED_AT = '2030-01-01T00:00:00.000Z'

async function settle(client: PoolClient): Promise<void> {
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  await client.query('SET CONSTRAINTS ALL DEFERRED')
}

interface FixtureIds {
  readonly planMonthId: string
  readonly publicationId: string
  readonly targetMonth: string
  readonly publicationRevision: string
  readonly lifecycleRevision: string
  readonly reportRevisionId?: string
  readonly originalReportRevisionId?: string
  readonly reportRevision?: string
}

interface SeedOptions {
  readonly spaceId: string
  readonly memberId: string
}

function uuid(suffix: number): string {
  return `40000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
}

async function insertMonth(
  client: PoolClient,
  month: FixtureIds,
  spaceId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO plan_months
       (id, space_id, month_start, status, lifecycle_mode, revision,
        facts_revision, active_publication_id, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, ($3 || '-01')::date, 'draft', 'ordinary', 1,
             0, NULL, $4::timestamptz, $4::timestamptz)`,
    [month.planMonthId, spaceId, month.targetMonth, CREATED_AT],
  )
  await client.query(
    `INSERT INTO plan_drafts
       (plan_month_id, focus, revision, created_at, updated_at)
     VALUES ($1::uuid, $2, 1, $3::timestamptz, $3::timestamptz)`,
    [month.planMonthId, `F02 ${month.targetMonth}`, CREATED_AT],
  )
}

async function insertAction(
  client: PoolClient,
  values: {
    readonly id: string
    readonly kind: string
    readonly actorKind: 'member' | 'system'
    readonly actorScope: string
    readonly memberId: string | null
    readonly systemActorId: string | null
    readonly planMonthId: string
    readonly commandType: string
    readonly commandId: string
    readonly beforeRevision: string | null
    readonly afterRevision: string
    readonly occurredAt: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO planning_action_groups
       (id, action_kind, actor_kind, actor_scope, member_id,
        system_actor_id, plan_month_id, goal_definition_id,
        command_type, command_id, before_revision, after_revision,
        occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::uuid, NULL,
             $8, $9::uuid, $10::bigint, $11::bigint, $12::timestamptz)`,
    [
      values.id,
      values.kind,
      values.actorKind,
      values.actorScope,
      values.memberId,
      values.systemActorId,
      values.planMonthId,
      values.commandType,
      values.commandId,
      values.beforeRevision,
      values.afterRevision,
      values.occurredAt,
    ],
  )
}

async function insertReceipt(
  client: PoolClient,
  values: {
    readonly actorScope: string
    readonly commandType: string
    readonly commandId: string
    readonly resultKind: string
    readonly aggregateId: string
    readonly aggregateRevision: string
    readonly completedAt: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO command_receipts
       (actor_scope, command_type, command_id, fingerprint, result_kind,
        aggregate_id, aggregate_revision, completed_at)
     VALUES ($1, $2, $3::uuid, $4, $5, $6::uuid, $7::bigint, $8::timestamptz)`,
    [
      values.actorScope,
      values.commandType,
      values.commandId,
      `${values.commandId.slice(0, 1)}${'0'.repeat(63)}`,
      values.resultKind,
      values.aggregateId,
      values.aggregateRevision,
      values.completedAt,
    ],
  )
}

async function insertPublication(
  client: PoolClient,
  month: FixtureIds,
  spaceId: string,
  memberId: string,
  publishedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO plan_publications
       (id, space_id, plan_month_id, publication_revision,
        source_draft_revision, source_plan_month_revision, focus,
        activation_mode, active_local_date, late_publication, time_zone,
        source_preview_schema_version, preview_hash_version, preview_hash,
        calendar_formula_version, evaluation_formula_version,
        score_formula_version, published_by_member_id, published_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, 1, 1, $5,
             'scheduled', $6::date, false, 'Asia/Yekaterinburg',
             'planner.publication-preview.v1',
             'planner.publication-preview-hash.v1', $7,
             'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
             'planner.score-coverage.v1', $8::uuid, $9::timestamptz)`,
    [
      month.publicationId,
      spaceId,
      month.planMonthId,
      month.publicationRevision,
      `F02 ${month.targetMonth}`,
      month.targetMonth + '-01',
      HASH,
      memberId,
      publishedAt,
    ],
  )
}

async function publishMonth(
  client: PoolClient,
  month: FixtureIds,
  spaceId: string,
  memberId: string,
  publishedAt: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const actorScope = `member:${memberId}`
  await insertPublication(client, month, spaceId, memberId, publishedAt)
  await insertAction(client, {
    id: actionId,
    kind: 'month_published',
    actorKind: 'member',
    actorScope,
    memberId,
    systemActorId: null,
    planMonthId: month.planMonthId,
    commandType: 'planning.publish-month.v1',
    commandId,
    beforeRevision: '1',
    afterRevision: '2',
    occurredAt: publishedAt,
  })
  await client.query(
    `INSERT INTO planning_publication_changes
       (action_id, publication_id, change_kind, confirmed_draft_revision,
        confirmed_preview_schema_version, confirmed_preview_hash_version,
        confirmed_preview_hash, before_active_publication_id,
        after_active_publication_id)
     VALUES ($1::uuid, $2::uuid, 'published', 1,
             'planner.publication-preview.v1',
             'planner.publication-preview-hash.v1', $3,
             NULL, $2::uuid)`,
    [actionId, month.publicationId, HASH],
  )
  await client.query(
    `UPDATE plan_months
        SET status = 'published', active_publication_id = $2::uuid,
            revision = 2, updated_at = $3::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, month.publicationId, publishedAt],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.publish-month.v1',
    commandId,
    resultKind: 'planning.plan-publication.v1',
    aggregateId: month.publicationId,
    aggregateRevision: month.publicationRevision,
    completedAt: publishedAt,
  })
}

async function startGrace(
  client: PoolClient,
  month: FixtureIds,
  timestamp: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const actorScope = 'system:planner-worker'
  await insertAction(client, {
    id: actionId,
    kind: 'month_grace_started',
    actorKind: 'system',
    actorScope,
    memberId: null,
    systemActorId: 'planner-worker',
    planMonthId: month.planMonthId,
    commandType: 'planning.start-month-grace.v1',
    commandId,
    beforeRevision: '2',
    afterRevision: '3',
    occurredAt: timestamp,
  })
  await client.query(
    `UPDATE plan_months
        SET status = 'grace', revision = 3, updated_at = $2::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, timestamp],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.start-month-grace.v1',
    commandId,
    resultKind: 'planning.plan-month.v1',
    aggregateId: month.planMonthId,
    aggregateRevision: '3',
    completedAt: timestamp,
  })
}

async function closeOrdinary(
  client: PoolClient,
  month: FixtureIds,
  timestamp: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const reportId = month.originalReportRevisionId ?? month.reportRevisionId!
  const actorScope = 'system:planner-worker'
  await insertAction(client, {
    id: actionId,
    kind: 'month_closed',
    actorKind: 'system',
    actorScope,
    memberId: null,
    systemActorId: 'planner-worker',
    planMonthId: month.planMonthId,
    commandType: 'planning.close-month.v1',
    commandId,
    beforeRevision: '3',
    afterRevision: '4',
    occurredAt: timestamp,
  })
  await client.query(
    `INSERT INTO report_revisions
       (id, plan_month_id, publication_id, revision,
        publication_snapshot_hash, source_facts_revision, formula_version,
        payload, payload_checksum, status, created_at,
        created_by_system_actor_id, created_by_member_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, 0,
             'planner.report.v1', '{}'::jsonb, $5, 'original',
             $6::timestamptz, 'planner-worker', NULL)`,
    [
      reportId,
      month.planMonthId,
      month.publicationId,
      HASH,
      CHECKSUM,
      timestamp,
    ],
  )
  await client.query(
    `UPDATE plan_months
        SET status = 'closed', revision = 4, updated_at = $2::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, timestamp],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.close-month.v1',
    commandId,
    resultKind: 'planning.report-revision.v1',
    aggregateId: reportId,
    aggregateRevision: '1',
    completedAt: timestamp,
  })
}

async function reopenMonth(
  client: PoolClient,
  month: FixtureIds,
  memberId: string,
  timestamp: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const actorScope = `member:${memberId}`
  await insertAction(client, {
    id: actionId,
    kind: 'month_reopened',
    actorKind: 'member',
    actorScope,
    memberId,
    systemActorId: null,
    planMonthId: month.planMonthId,
    commandType: 'planning.reopen-month.v1',
    commandId,
    beforeRevision: '4',
    afterRevision: '5',
    occurredAt: timestamp,
  })
  await client.query(
    `INSERT INTO planning_month_reopen_changes (action_id, reason)
     VALUES ($1::uuid, 'F02 fixture reopen')`,
    [actionId],
  )
  await client.query(
    `UPDATE plan_months
        SET status = 'grace', lifecycle_mode = 'reopened', revision = 5,
            updated_at = $2::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, timestamp],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.reopen-month.v1',
    commandId,
    resultKind: 'planning.plan-month.v1',
    aggregateId: month.planMonthId,
    aggregateRevision: '5',
    completedAt: timestamp,
  })
}

async function recloseMonth(
  client: PoolClient,
  month: FixtureIds,
  memberId: string,
  timestamp: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const actorScope = `member:${memberId}`
  const reportId = month.reportRevisionId!
  await insertAction(client, {
    id: actionId,
    kind: 'month_reclosed',
    actorKind: 'member',
    actorScope,
    memberId,
    systemActorId: null,
    planMonthId: month.planMonthId,
    commandType: 'planning.reclose-month.v1',
    commandId,
    beforeRevision: '5',
    afterRevision: '6',
    occurredAt: timestamp,
  })
  await client.query(
    `INSERT INTO report_revisions
       (id, plan_month_id, publication_id, revision,
        publication_snapshot_hash, source_facts_revision, formula_version,
        payload, payload_checksum, status, created_at,
        created_by_system_actor_id, created_by_member_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 2, $4, 0,
             'planner.report.v1', '{}'::jsonb, $5, 'revised',
             $6::timestamptz, NULL, $7::uuid)`,
    [
      reportId,
      month.planMonthId,
      month.publicationId,
      HASH,
      CHECKSUM,
      timestamp,
      memberId,
    ],
  )
  await client.query(
    `UPDATE plan_months
        SET status = 'closed', revision = 6, updated_at = $2::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, timestamp],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.reclose-month.v1',
    commandId,
    resultKind: 'planning.report-revision.v1',
    aggregateId: reportId,
    aggregateRevision: '2',
    completedAt: timestamp,
  })
}

async function cancelMonth(
  client: PoolClient,
  month: FixtureIds,
  memberId: string,
  timestamp: string,
  actionNumber: number,
): Promise<void> {
  const actionId = uuid(actionNumber)
  const commandId = uuid(100 + actionNumber)
  const actorScope = `member:${memberId}`
  await insertAction(client, {
    id: actionId,
    kind: 'month_publication_cancelled',
    actorKind: 'member',
    actorScope,
    memberId,
    systemActorId: null,
    planMonthId: month.planMonthId,
    commandType: 'planning.cancel-publication.v1',
    commandId,
    beforeRevision: '2',
    afterRevision: '3',
    occurredAt: timestamp,
  })
  await client.query(
    `UPDATE plan_months
        SET status = 'draft', active_publication_id = NULL,
            revision = 3, updated_at = $2::timestamptz
      WHERE id = $1::uuid`,
    [month.planMonthId, timestamp],
  )
  await client.query(
    `INSERT INTO planning_publication_changes
       (action_id, publication_id, change_kind,
        before_active_publication_id, after_active_publication_id)
     VALUES ($1::uuid, $2::uuid, 'cancelled', $2::uuid, NULL)`,
    [actionId, month.publicationId],
  )
  await insertReceipt(client, {
    actorScope,
    commandType: 'planning.cancel-publication.v1',
    commandId,
    resultKind: 'planning.plan-month.v1',
    aggregateId: month.planMonthId,
    aggregateRevision: '3',
    completedAt: timestamp,
  })
}

export async function seedListPlanMonthsFixture(
  pool: { connect(): Promise<PoolClient> },
  options: SeedOptions,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET CONSTRAINTS ALL DEFERRED')
    const months = Object.values(LIST_PLAN_MONTH_FIXTURES)
    for (const month of months) {
      await insertMonth(client, month, options.spaceId)
    }
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.future,
      options.spaceId,
      options.memberId,
      '2031-03-01T00:00:00.000Z',
      1,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.active,
      options.spaceId,
      options.memberId,
      '2031-02-01T00:00:00.000Z',
      2,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.cancelled,
      options.spaceId,
      options.memberId,
      '2031-01-01T00:00:00.000Z',
      3,
    )
    await settle(client)
    await cancelMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.cancelled,
      options.memberId,
      '2031-01-15T00:00:00.000Z',
      4,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceOrdinary,
      options.spaceId,
      options.memberId,
      '2030-12-01T00:00:00.000Z',
      5,
    )
    await settle(client)
    await startGrace(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceOrdinary,
      '2031-02-01T00:00:00.000Z',
      6,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceReopened,
      options.spaceId,
      options.memberId,
      '2030-11-01T00:00:00.000Z',
      7,
    )
    await settle(client)
    await startGrace(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceReopened,
      '2031-01-01T00:00:00.000Z',
      8,
    )
    await settle(client)
    await closeOrdinary(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceReopened,
      '2031-01-04T00:00:00.000Z',
      9,
    )
    await settle(client)
    await reopenMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.graceReopened,
      options.memberId,
      '2031-01-05T00:00:00.000Z',
      10,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedOrdinary,
      options.spaceId,
      options.memberId,
      '2030-10-01T00:00:00.000Z',
      11,
    )
    await settle(client)
    await startGrace(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedOrdinary,
      '2030-12-01T00:00:00.000Z',
      12,
    )
    await settle(client)
    await closeOrdinary(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedOrdinary,
      '2030-12-04T00:00:00.000Z',
      13,
    )
    await settle(client)
    await publishMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedReopened,
      options.spaceId,
      options.memberId,
      '2030-09-01T00:00:00.000Z',
      14,
    )
    await settle(client)
    await startGrace(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedReopened,
      '2030-11-01T00:00:00.000Z',
      15,
    )
    await settle(client)
    await closeOrdinary(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedReopened,
      '2030-11-04T00:00:00.000Z',
      16,
    )
    await settle(client)
    await reopenMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedReopened,
      options.memberId,
      '2030-11-05T00:00:00.000Z',
      17,
    )
    await settle(client)
    await recloseMonth(
      client,
      LIST_PLAN_MONTH_FIXTURES.closedReopened,
      options.memberId,
      '2030-11-06T00:00:00.000Z',
      18,
    )
    await settle(client)
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('COMMIT')
  } catch (error: unknown) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
