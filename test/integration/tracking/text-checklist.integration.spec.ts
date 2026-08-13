import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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
  createTrackingApplication,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  PrismaFactPersistence,
  RecordTextCommand,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  type FactWritePhase,
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
const migrationsThroughT02 = [
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
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly snapshots: Readonly<
    Record<
      | 'text'
      | 'checklist'
      | 'textCheckpoints'
      | 'checklistCheckpoints'
      | 'flexibleChecklist',
      string
    >
  >
  readonly checklistItems: readonly string[]
  readonly checkpointChecklistItems: readonly string[]
  readonly textCheckpointId: string
  readonly checklistCheckpointId: string
}

function deployMigrations(databaseUrl: string): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`)
}

async function applyMigration(target: Pool, name: string): Promise<void> {
  await target.query(
    readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
  )
}

function config(url: string): {
  readonly database: {
    readonly url: string
    readonly poolMax: number
    readonly connectionTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly healthTimeoutMs: number
    readonly transactionMaxWaitMs: number
    readonly transactionTimeoutMs: number
  }
} {
  return {
    database: {
      url,
      poolMax: 12,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 20_000,
    },
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

function ids(configValue: unknown, path: 'items' | 'checkpoints'): string[] {
  const value = configValue as {
    measurement: { items: { itemId: string }[] }
    checkpoints: { items: { checkpointId: string }[] }
  }
  return path === 'items'
    ? value.measurement.items.map((item) => item.itemId)
    : value.checkpoints.items.map((item) => item.checkpointId)
}

describe('T03 text and checklist facts in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t03_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const runtimeConfig = config(postgres.getConnectionUri())
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-04-09T20:00:00.123Z'))
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
    clock.set(new Date('2026-04-09T20:00:00.123Z'))
  }

  async function publishedFixture(): Promise<Fixture> {
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'T03 facts' },
    })
    const definitions = await Promise.all(
      [
        ['Important task', 'Text result'],
        ['Channels', 'Fixed checklist'],
        ['Text checkpoints', 'Nested text'],
        ['Checklist checkpoints', 'Nested checklist'],
        ['Flexible channels', 'T04 boundary'],
      ].map(([title, why]) =>
        planning.createGoalDefinition.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: { title: title!, why: why!, category: 'T03' },
        }),
      ),
    )
    const checklist = (): {
      readonly itemId: null
      readonly label: string
    }[] =>
      ['VK', 'Dzen', 'TikTok', 'Instagram'].map((label) => ({
        itemId: null,
        label,
      }))
    const configs = [
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'text' as const },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'checklist' as const, items: checklist() },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'text' as const },
        checkpoints: {
          aggregation: 'independent' as const,
          items: [
            {
              checkpointId: null,
              name: 'Evening',
              deadline: '22:00',
              satisfaction: { kind: 'text' as const },
            },
          ],
        },
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'checklist' as const, items: checklist() },
        checkpoints: {
          aggregation: 'independent' as const,
          items: [
            {
              checkpointId: null,
              name: 'Publish',
              deadline: '20:00',
              satisfaction: { kind: 'checklist' as const },
            },
          ],
        },
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'weekly' as const, n: '2' },
        measurement: { kind: 'checklist' as const, items: checklist() },
        checkpoints: null,
      },
    ] as const
    for (let index = 0; index < definitions.length; index += 1) {
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definitions[index]!.aggregateId,
          config: configs[index]!,
          sourceProvenance: null,
        },
      })
    }
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('T03 preview missing')
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
    const rows = await pool.query<{
      readonly id: string
      readonly config: unknown
    }>(
      `SELECT id::text, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
        ORDER BY display_order`,
      [publication.aggregateId],
    )
    clock.set(new Date('2026-04-10T20:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      snapshots: {
        text: rows.rows[0]!.id,
        checklist: rows.rows[1]!.id,
        textCheckpoints: rows.rows[2]!.id,
        checklistCheckpoints: rows.rows[3]!.id,
        flexibleChecklist: rows.rows[4]!.id,
      },
      checklistItems: ids(rows.rows[1]!.config, 'items'),
      checkpointChecklistItems: ids(rows.rows[3]!.config, 'items'),
      textCheckpointId: ids(rows.rows[2]!.config, 'checkpoints')[0]!,
      checklistCheckpointId: ids(rows.rows[3]!.config, 'checkpoints')[0]!,
    }
  }

  async function progress(
    fixture: Fixture,
    snapshot: keyof Fixture['snapshots'],
  ): Promise<unknown> {
    return tracking.getGoalProgress.execute({
      trustedActor: actor(secondMemberId),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots[snapshot],
      asOfLocalDate: '2026-04-10',
    })
  }

  it('stores non-empty text plus result and CAS-corrects done to not_done', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const commandId = randomUUID()
    const command = {
      commandId,
      trustedActor: actor(secondMemberId),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.text,
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Позвонить партнёру',
        result: 'done' as const,
      },
    }
    const first = await tracking.recordText.execute(command)
    await expect(tracking.recordText.execute(command)).resolves.toEqual(first)
    await expect(
      tracking.recordText.execute({
        ...command,
        commandId: randomUUID(),
        expectedRevision: first.aggregateRevision,
        payload: {
          ...command.payload,
          text: 'Партнёр недоступен',
          result: 'not_done',
        },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 2n })
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.text,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      factsRevision: 2n,
      fact: {
        kind: 'text',
        revision: 2n,
        text: 'Партнёр недоступен',
        result: 'not_done',
      },
    })
    await expect(progress(fixture, 'text')).resolves.toMatchObject({
      progress: { basisPoints: '0' },
      coverage: { filled: '1', applicable: '1' },
    })
  })

  it('uses each required fixed checklist item as one unit without a parent', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const expectations = await pool.query<Record<string, string>>(
      `SELECT component_kind, count(*)::text count
         FROM fixed_expectations
        WHERE publication_id = $1::uuid
          AND plan_goal_snapshot_id = $2::uuid
          AND expectation_date = '2026-04-10'::date
        GROUP BY component_kind`,
      [fixture.publicationId, fixture.snapshots.checklist],
    )
    expect(expectations.rows).toEqual([
      { component_kind: 'checklist_item', count: '4' },
    ])
    for (const [index, state] of ['done', 'done', 'not_done'].entries()) {
      await tracking.recordChecklistItem.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.checklist,
          expectationDate: '2026-04-10',
          checkpointId: null,
          checklistItemId: fixture.checklistItems[index]!,
          state: state as 'done' | 'not_done',
        },
      })
    }
    await expect(progress(fixture, 'checklist')).resolves.toMatchObject({
      progress: { basisPoints: '5000' },
      score: { basisPoints: '5000' },
      coverage: { filled: '3', applicable: '4' },
    })
    const records = await pool.query<Record<string, string>>(
      `SELECT count(*)::text records,
              count(DISTINCT checklist_item_id)::text items
         FROM tracking_fact_records
        WHERE plan_goal_snapshot_id = $1::uuid`,
      [fixture.snapshots.checklist],
    )
    expect(records.rows[0]).toEqual({ records: '3', items: '3' })
  })

  it('records nested text and checklist items against one checkpoint expectation', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.textCheckpoints,
        expectationDate: '2026-04-10',
        checkpointId: fixture.textCheckpointId,
        text: 'Вечерний итог',
        result: 'done',
      },
    })
    for (const [index, state] of ['done', 'done', 'not_done'].entries()) {
      await tracking.recordChecklistItem.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.checklistCheckpoints,
          expectationDate: '2026-04-10',
          checkpointId: fixture.checklistCheckpointId,
          checklistItemId: fixture.checkpointChecklistItems[index]!,
          state: state as 'done' | 'not_done',
        },
      })
    }
    await expect(progress(fixture, 'textCheckpoints')).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })
    await expect(
      progress(fixture, 'checklistCheckpoints'),
    ).resolves.toMatchObject({
      progress: { basisPoints: '5000' },
      coverage: { filled: '3', applicable: '4' },
    })
    const physical = await pool.query<Record<string, string>>(
      `SELECT count(DISTINCT fixed_expectation_id)::text expectations,
              count(*)::text records
         FROM tracking_fact_records
        WHERE plan_goal_snapshot_id = $1::uuid`,
      [fixture.snapshots.checklistCheckpoints],
    )
    expect(physical.rows[0]).toEqual({ expectations: '1', records: '3' })
  })

  it('preserves precedence and rejects unauthorized, mismatched, flexible and concurrent writes', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const command = {
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.checklist,
        expectationDate: '2026-04-10',
        checkpointId: null,
        checklistItemId: fixture.checklistItems[0]!,
        state: 'done' as const,
      },
    }
    const first = await tracking.recordChecklistItem.execute(command)
    await expect(
      tracking.recordChecklistItem.execute(command),
    ).resolves.toEqual(first)
    await expect(
      tracking.recordChecklistItem.execute({
        ...command,
        payload: { ...command.payload, state: 'not_done' },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    await expect(
      tracking.recordChecklistItem.execute({
        ...command,
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        payload: {
          ...command.payload,
          checklistItemId: fixture.checklistItems[1]!,
        },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    await expect(
      tracking.recordChecklistItem.execute({
        ...command,
        commandId: randomUUID(),
        payload: { ...command.payload, checklistItemId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)
    await expect(
      tracking.recordChecklistItem.execute({
        ...command,
        commandId: randomUUID(),
        payload: {
          ...command.payload,
          planGoalSnapshotId: fixture.snapshots.flexibleChecklist,
          checklistItemId: fixture.checkpointChecklistItems[0]!,
        },
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('unsupported'))

    const competing = await Promise.allSettled(
      [1, 2].map(() =>
        tracking.recordChecklistItem.execute({
          ...command,
          commandId: randomUUID(),
          payload: {
            ...command.payload,
            checklistItemId: fixture.checklistItems[1]!,
          },
        }),
      ),
    )
    expect(
      competing.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = competing.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )
    expect(rejected?.reason).toBeInstanceOf(FactRevisionConflictError)
    const counts = await pool.query<Record<string, string>>(
      `SELECT count(*)::text records,
              (SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid)
                facts_revision
         FROM tracking_fact_records`,
      [fixture.planMonthId],
    )
    expect(counts.rows[0]).toEqual({ records: '2', facts_revision: '2' })
  })

  it('rolls back every text write phase and completed receipt', async () => {
    const phases: readonly FactWritePhase[] = [
      'record',
      'revision',
      'pointer',
      'facts_revision',
      'history',
    ]
    for (const phase of phases) {
      await resetPair()
      const fixture = await publishedFixture()
      const persistence = new PrismaFactPersistence(provider, (current) => {
        if (current === phase) throw new Error(`failpoint:${phase}`)
      })
      const recordText = new RecordTextCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        persistence,
      )
      await expect(
        recordText.execute({
          commandId: randomUUID(),
          trustedActor: actor(secondMemberId),
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.text,
            expectationDate: '2026-04-10',
            checkpointId: null,
            text: 'Rollback',
            result: 'done',
          },
        }),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
      const counts = await pool.query<Record<string, string>>(`
        SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
               (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
               (SELECT count(*)::text FROM tracking_action_groups) actions,
               (SELECT count(*)::text FROM tracking_fact_changes) changes,
               (SELECT count(*)::text FROM command_receipts
                 WHERE command_type = 'tracking.record-text.v1') receipts,
               (SELECT facts_revision::text FROM plan_months
                 WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
      `)
      expect(counts.rows[0]).toEqual({
        records: '0',
        revisions: '0',
        actions: '0',
        changes: '0',
        receipts: '0',
        facts_revision: '0',
      })
    }
  })

  it('enforces typed values, immutable identity and deferred exact shapes in SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const result = await tracking.recordChecklistItem.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.checklist,
        expectationDate: '2026-04-10',
        checkpointId: null,
        checklistItemId: fixture.checklistItems[0]!,
        state: 'done',
      },
    })
    const shape = await pool.query<{ valid: boolean }>(
      `SELECT t01_action_has_exact_shape(action.id) valid
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change ON change.action_id = action.id
        WHERE change.fact_record_id = $1::uuid`,
      [result.aggregateId],
    )
    expect(shape.rows).toEqual([{ valid: true }])
    await expect(
      pool.query(
        `UPDATE tracking_fact_records
            SET checklist_item_id = $2::uuid
          WHERE id = $1::uuid`,
        [result.aggregateId, fixture.checklistItems[1]],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state,
           recorded_by_member_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 99, 'recorded', NULL, NULL,
                 NULL, NULL, '   ', 'done', NULL, $2::uuid, now())`,
        [result.aggregateId, firstMemberId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'tracking_fact_revisions_value_check',
    })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state,
           recorded_by_member_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 99, 'recorded', NULL, NULL,
                 NULL, NULL, 'Текст есть', NULL, NULL, $2::uuid, now())`,
        [result.aggregateId, firstMemberId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'tracking_fact_revisions_value_check',
    })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state,
           recorded_by_member_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 99, 'recorded', NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, $2::uuid, now())`,
        [result.aggregateId, firstMemberId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'tracking_fact_revisions_value_check',
    })
  })

  it('upgrades populated T01/T02 envelopes byte-stably through the dispatcher', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t03_upgrade')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const upgradePool = new Pool({
      connectionString: upgrade.getConnectionUri(),
    })
    const runtimeConfig = config(upgrade.getConnectionUri())
    const upgradeContext = new PrismaTransactionContext()
    const upgradeProvider = new PrismaClientProvider(
      runtimeConfig,
      upgradeContext,
    )
    try {
      for (const migration of migrationsThroughT02) {
        await applyMigration(upgradePool, migration)
      }
      await upgradePool.query(`
        INSERT INTO users (id) VALUES
          ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
        INSERT INTO spaces (id, singleton_key)
        VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot) VALUES
          ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
          ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
      `)
      await upgradeProvider.connect(AbortSignal.timeout(2_000))
      const upgradeTransaction = new PrismaTransactionAdapter(
        upgradeProvider,
        upgradeContext,
        runtimeConfig,
      )
      const upgradeMembers = new PrismaWorkspaceMemberResolver(upgradeProvider)
      const upgradeClock = new FakeProductClock(
        new Date('2026-04-09T20:00:00.123Z'),
      )
      const upgradePlanning = createPlanningApplication({
        database: upgradeProvider,
        transaction: upgradeTransaction,
        workspaceMembers: upgradeMembers,
        clock: upgradeClock,
      })
      const drafts = await Promise.all(
        ['2026-04', '2026-05'].map((targetMonth) =>
          upgradePlanning.createEmptyDraft.execute({
            commandId: randomUUID(),
            trustedActor: actor(),
            payload: {
              targetMonth,
              focus: `T03 upgrade fixture ${targetMonth}`,
            },
          }),
        ),
      )
      const definitions = await Promise.all(
        [
          ['Legacy Boolean', 'T01 envelope'],
          ['Legacy Rating', 'T02 envelope'],
        ].map(([title, why]) =>
          upgradePlanning.createGoalDefinition.execute({
            commandId: randomUUID(),
            trustedActor: actor(),
            payload: { title: title!, why: why!, category: 'T03 upgrade' },
          }),
        ),
      )
      const legacyConfigs = [
        {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' as const },
          measurement: { kind: 'boolean' as const },
          checkpoints: null,
        },
        {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' as const },
          measurement: {
            kind: 'rating' as const,
            minimum: 1,
            maximum: 10,
          },
          checkpoints: null,
        },
      ] as const
      for (let index = 0; index < definitions.length; index += 1) {
        await upgradePlanning.addDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId: drafts[index]!.aggregateId,
            goalDefinitionId: definitions[index]!.aggregateId,
            config: legacyConfigs[index]!,
            sourceProvenance: null,
          },
        })
      }
      const publications: { readonly aggregateId: string }[] = []
      const snapshotIds: string[] = []
      for (let index = 0; index < drafts.length; index += 1) {
        const targetMonth = index === 0 ? '2026-04' : '2026-05'
        const preview = await upgradePlanning.buildPublicationPreview.execute({
          trustedUserId: firstUserId,
          targetMonth,
        })
        if (preview === null) throw new Error('T03 upgrade preview missing')
        const publication = await upgradePlanning.publishMonth.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: BigInt(preview.draftRevision),
          payload: {
            planMonthId: drafts[index]!.aggregateId,
            previewSchemaVersion: preview.schemaVersion,
            previewHashVersion: preview.previewHashVersion,
            previewHash: preview.previewHash,
          },
        })
        publications.push(publication)
        const snapshots = await upgradePool.query<{ readonly id: string }>(
          `SELECT id::text FROM plan_goal_snapshots
            WHERE publication_id = $1::uuid`,
          [publication.aggregateId],
        )
        const snapshotId = snapshots.rows[0]?.id
        if (snapshotId === undefined) {
          throw new Error('T03 upgrade snapshot missing')
        }
        snapshotIds.push(snapshotId)
      }

      const revisionIds: string[] = []
      async function insertLegacyFact(input: {
        readonly planMonthId: string
        readonly publicationId: string
        readonly snapshotId: string
        readonly expectationDate: string
        readonly factKind: 'boolean' | 'rating'
        readonly booleanResult: 'done' | null
        readonly ratingValue: number | null
        readonly occurredAt: string
        readonly fingerprintCharacter: 'a' | 'b'
      }): Promise<void> {
        const factRecordId = randomUUID()
        const factRevisionId = randomUUID()
        const actionId = randomUUID()
        const commandId = randomUUID()
        const commandType =
          input.factKind === 'boolean'
            ? 'tracking.record-fact.v1'
            : 'tracking.record-rating.v1'
        const client = await upgradePool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `INSERT INTO tracking_fact_records
              (id, space_id, plan_month_id, publication_id,
               plan_goal_snapshot_id, local_date, fact_kind,
               fixed_expectation_id, flexible_period_id, contribution_id,
               current_revision_id, created_by_member_id, created_at, updated_at)
             SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                    $6::date, $7, expectation.id,
                    NULL, NULL, NULL, $8::uuid, $9::timestamptz, $9::timestamptz
               FROM fixed_expectations expectation
             WHERE expectation.publication_id = $4::uuid
                AND expectation.plan_goal_snapshot_id = $5::uuid
                AND expectation.expectation_date = $6::date
                AND expectation.component_kind = 'goal'
                AND expectation.component_id IS NULL`,
            [
              factRecordId,
              spaceId,
              input.planMonthId,
              input.publicationId,
              input.snapshotId,
              input.expectationDate,
              input.factKind,
              firstMemberId,
              input.occurredAt,
            ],
          )
          await client.query(
            `INSERT INTO tracking_fact_revisions
              (id, fact_record_id, revision_number, revision_kind,
               boolean_result, quantity_value, actual_time_value, rating_value,
               recorded_by_member_id, created_at)
             VALUES ($1::uuid, $2::uuid, 1, 'recorded', $3, NULL, NULL,
                     $4::bigint, $5::uuid, $6::timestamptz)`,
            [
              factRevisionId,
              factRecordId,
              input.booleanResult,
              input.ratingValue,
              firstMemberId,
              input.occurredAt,
            ],
          )
          await client.query(
            `UPDATE tracking_fact_records SET current_revision_id = $2::uuid
              WHERE id = $1::uuid`,
            [factRecordId, factRevisionId],
          )
          await client.query(
            `UPDATE plan_months SET facts_revision = 1
              WHERE id = $1::uuid AND facts_revision = 0`,
            [input.planMonthId],
          )
          await client.query(
            `INSERT INTO tracking_action_groups
              (id, action_kind, actor_kind, actor_scope, member_id, space_id,
               plan_month_id, publication_id, plan_goal_snapshot_id,
               command_type, command_id, before_facts_revision,
               after_facts_revision, occurred_at)
             VALUES ($1::uuid, 'fact_recorded', 'member', $2, $3::uuid,
                     $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8,
                     $9::uuid, $10, $11, $12::timestamptz)`,
            [
              actionId,
              `member:${firstMemberId}`,
              firstMemberId,
              spaceId,
              input.planMonthId,
              input.publicationId,
              input.snapshotId,
              commandType,
              commandId,
              0n,
              1n,
              input.occurredAt,
            ],
          )
          await client.query(
            `INSERT INTO tracking_fact_changes
              (action_id, fact_record_id, before_revision_id, after_revision_id)
             VALUES ($1::uuid, $2::uuid, NULL, $3::uuid)`,
            [actionId, factRecordId, factRevisionId],
          )
          await client.query(
            `INSERT INTO command_receipts
              (actor_scope, command_type, command_id, fingerprint, result_kind,
               aggregate_id, aggregate_revision, completed_at)
             VALUES ($1, $2, $3::uuid, repeat($4, 64),
                     'tracking.fact-record.v1', $5::uuid, 1, $6::timestamptz)`,
            [
              `member:${firstMemberId}`,
              commandType,
              commandId,
              input.fingerprintCharacter,
              factRecordId,
              input.occurredAt,
            ],
          )
          await client.query('COMMIT')
          revisionIds.push(factRevisionId)
        } finally {
          await client.query('ROLLBACK').catch(() => undefined)
          client.release()
        }
      }

      await insertLegacyFact({
        planMonthId: drafts[0]!.aggregateId,
        publicationId: publications[0]!.aggregateId,
        snapshotId: snapshotIds[0]!,
        expectationDate: '2026-04-10',
        factKind: 'boolean',
        booleanResult: 'done',
        ratingValue: null,
        occurredAt: '2026-04-10T20:00:00.123Z',
        fingerprintCharacter: 'a',
      })
      await insertLegacyFact({
        planMonthId: drafts[1]!.aggregateId,
        publicationId: publications[1]!.aggregateId,
        snapshotId: snapshotIds[1]!,
        expectationDate: '2026-05-10',
        factKind: 'rating',
        booleanResult: null,
        ratingValue: 5,
        occurredAt: '2026-05-10T20:00:01.123Z',
        fingerprintCharacter: 'b',
      })

      const digest = (): Promise<{ rows: Record<string, unknown>[] }> =>
        upgradePool.query<Record<string, unknown>>(
          `SELECT record.id::text record_id, record.fact_kind,
                  record.current_revision_id::text current_revision_id,
                  revision.revision_number::text revision_number,
                  revision.boolean_result, revision.rating_value::text,
                  month.facts_revision::text facts_revision,
                  action.id::text action_id, action.command_type,
                  action.before_facts_revision::text,
                  action.after_facts_revision::text,
                  receipt.fingerprint, receipt.result_kind,
                  receipt.aggregate_id::text aggregate_id,
                  receipt.aggregate_revision::text aggregate_revision
             FROM tracking_fact_records record
             JOIN tracking_fact_revisions revision
               ON revision.id = record.current_revision_id
             JOIN plan_months month ON month.id = record.plan_month_id
             JOIN tracking_fact_changes change ON change.fact_record_id = record.id
             JOIN tracking_action_groups action ON action.id = change.action_id
             JOIN command_receipts receipt
               ON receipt.actor_scope = action.actor_scope
              AND receipt.command_type = action.command_type
              AND receipt.command_id = action.command_id
            ORDER BY record.fact_kind`,
        )
      const before = await digest()
      await applyMigration(upgradePool, '20260811162000_text_checklist_facts')
      const after = await digest()
      expect(after.rows).toEqual(before.rows)
      await expect(
        upgradePool.query(
          `SELECT record.fact_kind, record.checklist_item_id,
                  revision.text_value, revision.text_result,
                  revision.checklist_item_state,
                  t01_fact_record_has_exact_shape(record.id) record_valid,
                  t01_action_has_exact_shape(action.id) action_valid
             FROM tracking_fact_records record
             JOIN tracking_fact_revisions revision
               ON revision.id = record.current_revision_id
             JOIN tracking_fact_changes change ON change.fact_record_id = record.id
             JOIN tracking_action_groups action ON action.id = change.action_id
            ORDER BY record.fact_kind`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            fact_kind: 'boolean',
            checklist_item_id: null,
            text_value: null,
            text_result: null,
            checklist_item_state: null,
            record_valid: true,
            action_valid: true,
          },
          {
            fact_kind: 'rating',
            checklist_item_id: null,
            text_value: null,
            text_result: null,
            checklist_item_state: null,
            record_valid: true,
            action_valid: true,
          },
        ],
      })
      await expect(
        upgradePool.query(
          `UPDATE tracking_fact_revisions SET boolean_result = boolean_result
            WHERE id = $1::uuid`,
          [revisionIds[0]],
        ),
      ).rejects.toMatchObject({ code: '55000' })
    } finally {
      await upgradeProvider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
      await upgradePool.end()
      await upgrade.stop()
    }
  })
})
