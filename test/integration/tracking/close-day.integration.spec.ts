import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  type PlanningApplication,
} from '@/modules/planning'
import {
  CloseDayAlreadyClosedError,
  CloseDayCommand,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  PrismaCloseDayPersistence,
  createTrackingApplication,
  type CloseDayWritePhase,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const migrationsThroughT06 = [
  '20260811090000_planner_foundation',
  '20260811100000_local_user_session',
  '20260811110000_pair_workspace',
  '20260811120000_telegram_external_identity',
  '20260811130000_plan_draft_kernel',
  '20260811140000_goal_catalog',
  '20260811150000_typed_draft_goals',
  '20260811151000_plan_publication',
  '20260811152000_cancel_republish',
  '20260811153000_copy_month',
  '20260811155000_seed_consumption',
  '20260811160000_tracking_record_kernel',
  '20260811161000_time_rating_checkpoints',
  '20260811162000_text_checklist_facts',
  '20260811163000_or_composite_facts',
  '20260811164000_fact_corrections_tombstones',
  '20260811165000_fact_undo',
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly waterSnapshotId: string
}

async function applyMigration(target: Pool, name: string): Promise<void> {
  await target.query(
    readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
  )
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

describe('T08 Atomic CloseDay on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t08_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrationsThroughT06) {
      await applyMigration(pool, migration)
    }
    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 12,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 30_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(3_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-03-30T07:00:00.000Z'))
    planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })

    await resetPair()
    const upgradeFixture = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: upgradeFixture.publicationId,
        planGoalSnapshotId: upgradeFixture.waterSnapshotId,
        localDate: '2026-04-09',
        value: { kind: 'quantity', value: '600' },
      },
    })
    const beforeUpgrade = await trackingDigest(pool)
    await applyMigration(pool, '20260811166000_close_day')
    expect(await trackingDigest(pool)).toBe(beforeUpgrade)
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function resetPair(): Promise<void> {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
    clock.set(new Date('2026-03-30T07:00:00.000Z'))
  }

  async function trackingDigest(target: Pool): Promise<string> {
    const rows = await target.query<{ readonly digest: string }>(`
      SELECT jsonb_build_object(
        'months', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
          FROM (SELECT id, facts_revision FROM plan_months) row_value),
        'records', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
          FROM (SELECT * FROM tracking_fact_records) row_value),
        'revisions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
          FROM (SELECT id, fact_record_id, revision_number, revision_kind,
                       boolean_result, quantity_value, actual_time_value,
                       rating_value, text_value, text_result,
                       checklist_item_state, or_variant_value,
                       recorded_by_member_id, created_at
                  FROM tracking_fact_revisions) row_value),
        'actions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
          FROM (SELECT * FROM tracking_action_groups) row_value),
        'changes', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.action_id)
          FROM (SELECT * FROM tracking_fact_changes) row_value),
        'receipts', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.command_id)
          FROM (SELECT * FROM command_receipts) row_value)
      )::text digest
    `)
    return rows.rows[0]!.digest
  }

  async function fixture(): Promise<Fixture> {
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('publication preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const water = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid AND title = 'Вода 1200 мл'`,
      [publication.aggregateId],
    )
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      waterSnapshotId: water.rows[0]!.id,
    }
  }

  async function flexibleOnlyFixture(): Promise<Fixture> {
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'Empty CloseDay' },
    })
    const definition = await planning.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Weekly only', why: 'No fixed rows', category: 'T08' },
    })
    await planning.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'weekly', n: '3' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'times',
            precision: 0,
            aggregation: 'latest',
            target: '3',
          },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('publication preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshot = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      waterSnapshotId: snapshot.rows[0]!.id,
    }
  }

  beforeEach(async () => {
    await resetPair()
  })

  it('closes the own/shared unresolved set, exposes it in Month and lets typed fact plus undo reveal the marker again', async () => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-09',
    })
    expect(preview.state).toBe('ready')
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    expect(preview.unresolved.length).toBeGreaterThan(0)
    expect(preview.unresolved.some((item) => item.scope === 'shared')).toBe(
      true,
    )
    const foreignPersonal = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count
         FROM fixed_expectations expectation
         JOIN plan_goal_snapshots snapshot ON snapshot.id = expectation.plan_goal_snapshot_id
        WHERE expectation.publication_id = $1::uuid
          AND expectation.expectation_date = '2026-04-09'
          AND snapshot.scope_kind = 'personal'
          AND snapshot.owner_member_id = $2::uuid
          AND expectation.id = ANY($3::uuid[])`,
      [
        value.publicationId,
        secondMemberId,
        preview.unresolved.map((item) => item.fixedExpectationId),
      ],
    )
    expect(foreignPersonal.rows[0]!.count).toBe('0')

    const commandId = randomUUID()
    const closeCommand = {
      commandId,
      trustedActor: actor(),
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate: '2026-04-09',
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    } as const
    const closed = await tracking.closeDay.execute(closeCommand)
    expect(closed).toMatchObject({
      kind: 'tracking.day-close.v1',
      aggregateRevision: 1n,
    })
    await expect(tracking.closeDay.execute(closeCommand)).resolves.toEqual(
      closed,
    )
    await expect(
      tracking.previewCloseDay.execute({
        trustedActor: actor(),
        publicationId: value.publicationId,
        localDate: '2026-04-09',
      }),
    ).resolves.toMatchObject({
      state: 'closed',
      dayCloseId: closed.aggregateId,
      revision: closed.aggregateRevision,
      closedCount: preview.unresolved.length,
    })

    const stored = await pool.query<{
      readonly action_count: string
      readonly change_count: string
      readonly marker_count: string
      readonly facts_revision: string
    }>(
      `SELECT
         (SELECT count(*) FROM tracking_action_groups
           WHERE command_type = 'tracking.close-day.v1')::text action_count,
         (SELECT count(*) FROM tracking_fact_changes change
           JOIN tracking_action_groups action ON action.id = change.action_id
          WHERE action.command_type = 'tracking.close-day.v1')::text change_count,
         (SELECT count(*) FROM tracking_fact_records
           WHERE fact_kind = 'fixed_not_done')::text marker_count,
         (SELECT facts_revision FROM plan_months WHERE id = $1::uuid)::text
           facts_revision`,
      [value.planMonthId],
    )
    expect(stored.rows[0]).toEqual({
      action_count: '1',
      change_count: String(preview.unresolved.length),
      marker_count: String(preview.unresolved.length),
      facts_revision: '1',
    })

    const month = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published month expected')
    const day = month.days.find((item) => item.localDate === '2026-04-09')!
    expect(day.closure).toMatchObject({
      state: 'closed',
      dayCloseId: closed.aggregateId,
      revision: 1n,
      closedCount: preview.unresolved.length,
    })
    const waterBefore = day.goals.find(
      (goal) => goal.planGoalSnapshotId === value.waterSnapshotId,
    )!.fixedExpectations[0]!
    expect(waterBefore.state).toBe('not_done')
    expect(waterBefore.facts).toEqual([
      expect.objectContaining({
        factKind: 'fixed_not_done',
        value: { kind: 'fixed_not_done', result: 'not_done' },
      }),
    ])

    const recorded = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: value.waterSnapshotId,
        localDate: '2026-04-09',
        value: { kind: 'quantity', value: '1200' },
      },
    })
    const withTyped = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (withTyped.state !== 'published') throw new Error('published expected')
    const waterTyped = withTyped.days
      .find((item) => item.localDate === '2026-04-09')!
      .goals.find((goal) => goal.planGoalSnapshotId === value.waterSnapshotId)!
      .fixedExpectations[0]!
    expect(waterTyped.state).toBe('done')
    expect(waterTyped.facts.map((fact) => fact.factKind)).toEqual([
      'quantity_add',
    ])

    await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: recorded.aggregateRevision,
      payload: { factRecordId: recorded.aggregateId },
    })
    const afterUndo = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (afterUndo.state !== 'published') throw new Error('published expected')
    const waterAfterUndo = afterUndo.days
      .find((item) => item.localDate === '2026-04-09')!
      .goals.find((goal) => goal.planGoalSnapshotId === value.waterSnapshotId)!
      .fixedExpectations[0]!
    expect(waterAfterUndo.state).toBe('not_done')
    expect(waterAfterUndo.facts.map((fact) => fact.factKind)).toContain(
      'fixed_not_done',
    )
  })

  it('allows retrospective close through grace day three and keeps forgotten days no_data after the deadline', async () => {
    const value = await fixture()
    clock.set(new Date('2026-05-03T07:00:00.000Z'))
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-01',
    })
    expect(preview.state).toBe('ready')

    clock.set(new Date('2026-05-04T00:00:00.000Z'))
    await expect(
      tracking.previewCloseDay.execute({
        trustedActor: actor(),
        publicationId: value.publicationId,
        localDate: '2026-04-02',
      }),
    ).rejects.toMatchObject({
      reason: 'closed',
    })
    const month = await tracking.getMonth.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published month expected')
    const forgotten = month.days
      .find((day) => day.localDate === '2026-04-02')!
      .goals.find((goal) => goal.planGoalSnapshotId === value.waterSnapshotId)!
      .fixedExpectations[0]!
    expect(forgotten.state).toBe('no_data')
  })

  it('rejects future, pre-activation, stale/hash races and a second intent without partial writes', async () => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    await expect(
      tracking.previewCloseDay.execute({
        trustedActor: actor(),
        publicationId: value.publicationId,
        localDate: '2026-04-11',
      }),
    ).rejects.toMatchObject({
      reason: 'future_date',
    })
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-09',
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    const base = {
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate: '2026-04-09',
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    } as const
    await expect(
      tracking.closeDay.execute({
        ...base,
        commandId: randomUUID(),
        expectedRevision: preview.factsRevision + 1n,
      }),
    ).rejects.toBeInstanceOf(CloseDayRevisionConflictError)
    await expect(
      tracking.closeDay.execute({
        ...base,
        commandId: randomUUID(),
        payload: { ...base.payload, previewHash: '0'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(CloseDayPreviewConflictError)
    const closed = await tracking.closeDay.execute(base)
    await expect(
      tracking.closeDay.execute({ ...base, commandId: randomUUID() }),
    ).rejects.toEqual(
      new CloseDayAlreadyClosedError({
        dayCloseId: closed.aggregateId,
        revision: closed.aggregateRevision,
      }),
    )
    await expect(
      tracking.closeDay.execute({
        ...base,
        payload: { ...base.payload, previewHash: 'f'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    const counts = await pool.query<{ readonly actions: string }>(
      `SELECT count(*)::text actions FROM tracking_action_groups
        WHERE command_type = 'tracking.close-day.v1'`,
    )
    expect(counts.rows[0]!.actions).toBe('1')
  })

  it('creates an explicit empty closure and increments facts revision once', async () => {
    const value = await flexibleOnlyFixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const localDate = '2026-04-09'
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate,
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    expect(preview.unresolved).toHaveLength(0)
    const closed = await tracking.closeDay.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    expect(closed.aggregateRevision).toBe(1n)
    const detail = await pool.query<{
      readonly closed_count: number
      readonly changes: string
    }>(
      `SELECT detail.closed_count,
              (SELECT count(*) FROM tracking_fact_changes change
                WHERE change.action_id = detail.action_id)::text changes
         FROM tracking_day_closures detail WHERE detail.action_id = $1::uuid`,
      [closed.aggregateId],
    )
    expect(detail.rows[0]).toEqual({ closed_count: 0, changes: '0' })
  })

  it('serializes two concurrent CloseDay intents into one durable closure', async () => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-09',
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    const makeCommand = (): Parameters<
      TrackingApplication['closeDay']['execute']
    >[0] => ({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate: '2026-04-09',
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const results = await Promise.allSettled([
      tracking.closeDay.execute(makeCommand()),
      tracking.closeDay.execute(makeCommand()),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') {
      throw new Error('one concurrent CloseDay must be rejected')
    }
    expect(rejected.reason).toBeInstanceOf(CloseDayAlreadyClosedError)
    const state = await pool.query<{
      readonly actions: string
      readonly closures: string
      readonly facts_revision: string
    }>(
      `SELECT
         (SELECT count(*) FROM tracking_action_groups
           WHERE command_type = 'tracking.close-day.v1')::text actions,
         (SELECT count(*) FROM tracking_day_closures)::text closures,
         (SELECT facts_revision FROM plan_months WHERE id = $1::uuid)::text
           facts_revision`,
      [value.planMonthId],
    )
    expect(state.rows[0]).toEqual({
      actions: '1',
      closures: '1',
      facts_revision: '1',
    })
  })

  it.each([
    'records',
    'revisions',
    'pointers',
    'facts_revision',
    'history',
    'changes',
    'closure_detail',
  ] as const)('rolls back every write phase after %s', async (phase) => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-09',
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    const failingPersistence = new PrismaCloseDayPersistence(
      provider,
      (observed: CloseDayWritePhase) => {
        if (observed === phase) throw new Error(`fail after ${phase}`)
      },
    )
    const executor = new DurableCommandExecutor(
      transaction,
      new PrismaCommandReceiptAdapter(provider),
      clock,
    )
    const failing = new CloseDayCommand(executor, members, failingPersistence)
    await expect(
      failing.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: preview.factsRevision,
        payload: {
          publicationId: value.publicationId,
          localDate: '2026-04-09',
          previewSchemaVersion: preview.schemaVersion,
          previewHashVersion: preview.previewHashVersion,
          previewHash: preview.previewHash,
        },
      }),
    ).rejects.toThrow()
    const state = await pool.query<{
      readonly facts_revision: string
      readonly actions: string
      readonly records: string
      readonly receipts: string
    }>(
      `SELECT
         (SELECT facts_revision FROM plan_months WHERE id = $1::uuid)::text facts_revision,
         (SELECT count(*) FROM tracking_action_groups WHERE command_type = 'tracking.close-day.v1')::text actions,
         (SELECT count(*) FROM tracking_fact_records WHERE fact_kind = 'fixed_not_done')::text records,
         (SELECT count(*) FROM command_receipts WHERE command_type = 'tracking.close-day.v1')::text receipts`,
      [value.planMonthId],
    )
    expect(state.rows[0]).toEqual({
      facts_revision: '0',
      actions: '0',
      records: '0',
      receipts: '0',
    })
  })

  it('rejects mutable or orphan closure history at the SQL boundary', async () => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const preview = await tracking.previewCloseDay.execute({
      trustedActor: actor(),
      publicationId: value.publicationId,
      localDate: '2026-04-09',
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    const closed = await tracking.closeDay.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: value.publicationId,
        localDate: '2026-04-09',
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    await expect(
      pool.query(
        `UPDATE tracking_day_closures SET closed_count = 0
          WHERE action_id = $1::uuid`,
        [closed.aggregateId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `INSERT INTO tracking_day_closures
          (action_id, publication_id, local_date, member_id,
           preview_schema_version, preview_hash_version, preview_hash,
           expectation_ids, closed_count)
         VALUES ($1::uuid, $2::uuid, '2026-04-10', $3::uuid,
           'tracking.close-day-preview.v1',
           'tracking.close-day-preview-hash.v1', $4, ARRAY[]::uuid[], 0)`,
        [randomUUID(), value.publicationId, firstMemberId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('rejects a second effect appended to a legacy single-effect action', async () => {
    const value = await fixture()
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const recorded = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: value.waterSnapshotId,
        localDate: '2026-04-09',
        value: { kind: 'quantity', value: '600' },
      },
    })
    const action = await pool.query<{ readonly id: string }>(
      `SELECT change.action_id::text id
         FROM tracking_fact_changes change
        WHERE change.fact_record_id = $1::uuid`,
      [recorded.aggregateId],
    )
    const forgedRecordId = randomUUID()
    const forgedRevisionId = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           fixed_expectation_id, flexible_period_id, contribution_id,
           checklist_item_id, or_variant_id, current_revision_id,
           created_by_member_id, created_at, updated_at)
         SELECT $2::uuid, source.space_id, source.plan_month_id,
                source.publication_id, source.plan_goal_snapshot_id,
                source.local_date, source.fact_kind,
                source.fixed_expectation_id, source.flexible_period_id,
                $3::uuid, source.checklist_item_id, source.or_variant_id,
                $4::uuid, source.created_by_member_id,
                source.created_at, source.updated_at
           FROM tracking_fact_records source
          WHERE source.id = $1::uuid`,
        [recorded.aggregateId, forgedRecordId, randomUUID(), forgedRevisionId],
      )
      await client.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           fixed_outcome, recorded_by_member_id, created_at)
         SELECT $2::uuid, $3::uuid, source.revision_number,
                source.revision_kind, source.boolean_result,
                source.quantity_value, source.actual_time_value,
                source.rating_value, source.text_value, source.text_result,
                source.checklist_item_state, source.or_variant_value,
                source.fixed_outcome, source.recorded_by_member_id,
                source.created_at
           FROM tracking_fact_revisions source
          WHERE source.id = (
            SELECT current_revision_id FROM tracking_fact_records
             WHERE id = $1::uuid
          )`,
        [recorded.aggregateId, forgedRevisionId, forgedRecordId],
      )
      await client.query(
        `INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid)`,
        [action.rows[0]!.id, forgedRecordId, forgedRevisionId],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const residue = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count FROM tracking_fact_records
        WHERE id = $1::uuid`,
      [forgedRecordId],
    )
    expect(residue.rows[0]!.count).toBe('0')
  })
})
