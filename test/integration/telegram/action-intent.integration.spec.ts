import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  type DraftGoalConfigV1,
} from '@/modules/planning'
import {
  canonicalRecordFactPayload,
  createTrackingApplication,
} from '@/modules/tracking'
import {
  PrismaActionIntentRepository,
  TelegramActionIntentService,
} from '@/modules/telegram-bot'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { commandFingerprint } from '@/shared/application/command-fingerprint'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const G02_ACTION_INTENT_MIGRATION = '20260811200000_telegram_action_intents'
const G03_ACTION_INTENT_MIGRATION =
  '20260811201000_telegram_scalar_action_intents'
const G04_ACTION_INTENT_MIGRATION =
  '20260811202000_telegram_composite_action_intents'

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

function readMigration(directory: string): string {
  return readFileSync(
    resolve(process.cwd(), 'prisma', 'migrations', directory, 'migration.sql'),
    'utf8',
  )
}

async function deployMigrationsThrough(
  pool: Pool,
  lastDirectory: string,
): Promise<void> {
  const migrationDirectories = readdirSync(
    resolve(process.cwd(), 'prisma', 'migrations'),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory() && entry.name <= lastDirectory)
    .map((entry) => entry.name)
    .sort()

  for (const directory of migrationDirectories) {
    await pool.query(readMigration(directory))
  }
}

describe('G03 populated G02 action-intent migration', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let populatedPublicationId: string
  let populatedPlanGoalSnapshotId: string

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g03_migration_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await deployMigrationsThrough(pool, G02_ACTION_INTENT_MIGRATION)

    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 12,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(2_000))
    const transaction = new PrismaTransactionAdapter(
      provider,
      context,
      runtimeConfig,
    )
    const members = new PrismaWorkspaceMemberResolver(provider)
    const clock = new FakeProductClock(new Date('2026-04-10T07:00:00.000Z'))
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })

    await pool.query(`
      INSERT INTO users (id) VALUES ('${firstUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot)
      VALUES (
        '${firstMemberId}'::uuid,
        '${spaceId}'::uuid,
        '${firstUserId}'::uuid,
        1
      );
    `)
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2026-04', focus: 'G03 migration fixture' },
    })
    const definition = await planning.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: {
        title: 'Legacy quantity',
        why: 'G03 migration fixture',
        category: 'G03',
      },
    })
    await planning.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'ml',
            precision: 0,
            aggregation: 'latest',
            target: '1000',
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
    if (preview === null) throw new Error('migration preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshot = await pool.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    const planGoalSnapshotId = snapshot.rows[0]?.id
    if (planGoalSnapshotId === undefined) {
      throw new Error('migration snapshot missing')
    }
    populatedPublicationId = publication.aggregateId
    populatedPlanGoalSnapshotId = planGoalSnapshotId

    const legacyRows = [
      {
        kind: 'quantity',
        state: 'offered',
        booleanResult: null,
        quantityValue: null,
        fingerprint: null,
        completed: false,
      },
      {
        kind: 'quantity',
        state: 'awaiting_value',
        booleanResult: null,
        quantityValue: null,
        fingerprint: null,
        completed: false,
      },
      {
        kind: 'quantity',
        state: 'ready',
        booleanResult: null,
        quantityValue: '7000',
        fingerprint: '3'.repeat(64),
        completed: false,
      },
      {
        kind: 'boolean',
        state: 'ready',
        booleanResult: 'done',
        quantityValue: null,
        fingerprint: '4'.repeat(64),
        completed: false,
      },
      {
        kind: 'boolean',
        state: 'completed',
        booleanResult: 'not_done',
        quantityValue: null,
        fingerprint: '5'.repeat(64),
        completed: true,
      },
      {
        kind: 'quantity',
        state: 'expired',
        booleanResult: null,
        quantityValue: null,
        fingerprint: null,
        completed: false,
      },
      {
        kind: 'quantity',
        state: 'expired',
        booleanResult: null,
        quantityValue: '12.5',
        fingerprint: '7'.repeat(64),
        completed: false,
      },
    ] as const

    for (const [index, row] of legacyRows.entries()) {
      const intentId = randomUUID()
      await pool.query(
        `INSERT INTO telegram_action_intents (
           id, semantic_key, command_id, space_id, member_id,
           publication_id, plan_goal_snapshot_id, local_date,
           source_facts_revision, intent_kind, state, boolean_result,
           quantity_value, command_fingerprint, result_kind,
           result_aggregate_id, result_aggregate_revision, expires_at,
           completed_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, DATE '2026-04-10',
           $7::bigint, $8, $9, $10, $11, $12,
           $13, $14::uuid, $15::bigint,
           TIMESTAMPTZ '2026-04-10 08:00:00+00',
           $16::timestamptz,
           TIMESTAMPTZ '2026-04-10 07:00:00+00',
           TIMESTAMPTZ '2026-04-10 07:01:00+00'
         )`,
        [
          intentId,
          String(index + 1).repeat(64),
          spaceId,
          firstMemberId,
          publication.aggregateId,
          planGoalSnapshotId,
          index === 4 ? '9223372036854775806' : String(index),
          row.kind,
          row.state,
          row.booleanResult,
          row.quantityValue,
          row.fingerprint,
          row.completed ? 'tracking.fact-record.v1' : null,
          row.completed ? randomUUID() : null,
          row.completed ? '9223372036854775806' : null,
          row.completed ? '2026-04-10 07:01:00+00' : null,
        ],
      )
    }
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('upgrades every valid G02 row shape atomically and enforces G03 guards', async () => {
    const migrationSql = readMigration(G03_ACTION_INTENT_MIGRATION)
    const before = await pool.query<{
      readonly semantic_key: string
      readonly source_facts_revision: string
      readonly state: string
    }>(
      `SELECT btrim(semantic_key) semantic_key,
              source_facts_revision::text,
              state
         FROM telegram_action_intents
        ORDER BY semantic_key`,
    )

    const rollbackClient = await pool.connect()
    try {
      await rollbackClient.query('BEGIN')
      await rollbackClient.query(migrationSql)
      await expect(rollbackClient.query('SELECT 1 / 0')).rejects.toThrow()
      await rollbackClient.query('ROLLBACK')
    } finally {
      rollbackClient.release()
    }
    const rolledBackColumn = await pool.query<{ readonly exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'telegram_action_intents'
            AND column_name = 'checkpoint_id'
       ) exists`,
    )
    expect(rolledBackColumn.rows[0]?.exists).toBe(false)
    await expect(
      pool.query(
        `UPDATE telegram_action_intents
            SET state = 'awaiting_value', quantity_value = NULL,
                command_fingerprint = NULL, updated_at = updated_at
          WHERE semantic_key = $1`,
        ['3'.repeat(64)],
      ),
    ).rejects.toThrow(/transition is invalid/)

    const migrationClient = await pool.connect()
    try {
      await migrationClient.query('BEGIN')
      await migrationClient.query(migrationSql)
      await migrationClient.query('COMMIT')
    } catch (error) {
      await migrationClient.query('ROLLBACK')
      throw error
    } finally {
      migrationClient.release()
    }

    const after = await pool.query<{
      readonly actual_time_value: string | null
      readonly checkpoint_id: string | null
      readonly rating_value: string | null
      readonly result_aggregate_revision: string | null
      readonly semantic_key: string
      readonly source_facts_revision: string
      readonly state: string
    }>(
      `SELECT actual_time_value::text, checkpoint_id::text,
              rating_value::text, result_aggregate_revision::text,
              btrim(semantic_key) semantic_key,
              source_facts_revision::text, state
         FROM telegram_action_intents
        ORDER BY semantic_key`,
    )
    expect(
      after.rows.map(({ semantic_key, source_facts_revision, state }) => ({
        semantic_key,
        source_facts_revision,
        state,
      })),
    ).toEqual(before.rows)
    expect(
      after.rows.every(
        (row) =>
          row.actual_time_value === null &&
          row.checkpoint_id === null &&
          row.rating_value === null,
      ),
    ).toBe(true)
    expect(after.rows[4]).toMatchObject({
      result_aggregate_revision: '9223372036854775806',
      source_facts_revision: '9223372036854775806',
    })

    await expect(
      pool.query(
        `UPDATE telegram_action_intents
            SET state = 'ready', quantity_value = '1000',
                command_fingerprint = $2, updated_at = updated_at
          WHERE semantic_key = $1`,
        ['2'.repeat(64), 'b'.repeat(64)],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      pool.query(
        `UPDATE telegram_action_intents
            SET state = 'awaiting_value', quantity_value = NULL,
                command_fingerprint = NULL, updated_at = updated_at
          WHERE semantic_key = $1`,
        ['3'.repeat(64)],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      pool.query(
        `UPDATE telegram_action_intents
            SET state = 'ready', quantity_value = '7100',
                command_fingerprint = $2, updated_at = updated_at
          WHERE semantic_key = $1`,
        ['3'.repeat(64), 'a'.repeat(64)],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      pool.query(
        `UPDATE telegram_action_intents
            SET source_facts_revision = source_facts_revision + 1
          WHERE semantic_key = $1`,
        ['4'.repeat(64)],
      ),
    ).rejects.toThrow(/identity is immutable/)
    await expect(
      pool.query(
        'DELETE FROM telegram_action_intents WHERE semantic_key = $1',
        ['6'.repeat(64)],
      ),
    ).rejects.toThrow(/cannot be deleted/)

    const g03TypedRows = [
      {
        key: 'g03-actual-time',
        kind: 'actual_time',
        checkpointId: null,
        actualTime: '09:15',
        rating: null,
      },
      {
        key: 'g03-rating',
        kind: 'rating',
        checkpointId: null,
        actualTime: null,
        rating: 5,
      },
      {
        key: 'g03-checkpoint-time',
        kind: 'checkpoint_actual_time',
        checkpointId: randomUUID(),
        actualTime: '10:30',
        rating: null,
      },
      {
        key: 'g03-checkpoint-rating',
        kind: 'checkpoint_rating',
        checkpointId: randomUUID(),
        actualTime: null,
        rating: 7,
      },
    ] as const
    for (const [index, row] of g03TypedRows.entries()) {
      await pool.query(
        `INSERT INTO telegram_action_intents (
           id, semantic_key, command_id, space_id, member_id,
           publication_id, plan_goal_snapshot_id, local_date,
           source_facts_revision, intent_kind, state, checkpoint_id,
           actual_time_value, rating_value, command_fingerprint,
           expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, DATE '2026-04-10', 0, $7, 'ready',
           $8::uuid, $9::time, $10, $11,
           TIMESTAMPTZ '2026-04-10 08:00:00+00',
           TIMESTAMPTZ '2026-04-10 07:00:00+00',
           TIMESTAMPTZ '2026-04-10 07:00:00+00'
         )`,
        [
          randomUUID(),
          row.key.padEnd(64, String(index)).slice(0, 64),
          spaceId,
          firstMemberId,
          populatedPublicationId,
          populatedPlanGoalSnapshotId,
          row.kind,
          row.checkpointId,
          row.actualTime,
          row.rating,
          `${String(index + 8)}`.repeat(64).slice(0, 64),
        ],
      )
    }

    const g04MigrationSql = readMigration(G04_ACTION_INTENT_MIGRATION)
    const g04RollbackClient = await pool.connect()
    try {
      await g04RollbackClient.query('BEGIN')
      await g04RollbackClient.query(g04MigrationSql)
      await expect(g04RollbackClient.query('SELECT 1 / 0')).rejects.toThrow()
      await g04RollbackClient.query('ROLLBACK')
    } finally {
      g04RollbackClient.release()
    }
    const rolledBackTextColumn = await pool.query<{ readonly exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'telegram_action_intents'
            AND column_name = 'text_result'
       ) exists`,
    )
    expect(rolledBackTextColumn.rows[0]?.exists).toBe(false)
    const g04MigrationClient = await pool.connect()
    try {
      await g04MigrationClient.query('BEGIN')
      await g04MigrationClient.query(g04MigrationSql)
      await g04MigrationClient.query('COMMIT')
    } catch (error) {
      await g04MigrationClient.query('ROLLBACK')
      throw error
    } finally {
      g04MigrationClient.release()
    }
    const preservedG03Rows = await pool.query<{
      readonly intent_kind: string
      readonly checkpoint_id: string | null
      readonly actual_time_value: string | null
      readonly rating_value: string | null
    }>(
      `SELECT intent_kind, checkpoint_id::text, actual_time_value::text,
              rating_value::text
         FROM telegram_action_intents
        WHERE semantic_key LIKE 'g03-%'
        ORDER BY semantic_key`,
    )
    expect(preservedG03Rows.rows).toHaveLength(4)
    expect(preservedG03Rows.rows.map((row) => row.intent_kind)).toEqual([
      'actual_time',
      'checkpoint_rating',
      'checkpoint_actual_time',
      'rating',
    ])

    const textIntentId = randomUUID()
    const textIntentKey = 'g04-text-intent'.padEnd(64, '0')
    await pool.query(
      `INSERT INTO telegram_action_intents (
         id, semantic_key, command_id, space_id, member_id,
         publication_id, plan_goal_snapshot_id, local_date,
         source_facts_revision, intent_kind, state, text_result,
         command_fingerprint, expires_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, DATE '2026-04-10', 0,
         'text', 'offered', 'done', NULL,
         TIMESTAMPTZ '2026-04-10 08:00:00+00',
         TIMESTAMPTZ '2026-04-10 07:00:00+00',
         TIMESTAMPTZ '2026-04-10 07:00:00+00'
       )`,
      [
        textIntentId,
        textIntentKey,
        spaceId,
        firstMemberId,
        populatedPublicationId,
        populatedPlanGoalSnapshotId,
      ],
    )
    await pool.query(
      `UPDATE telegram_action_intents
          SET state = 'awaiting_value', updated_at = updated_at
        WHERE id = $1::uuid`,
      [textIntentId],
    )
    await pool.query(
      `UPDATE telegram_action_intents
          SET state = 'ready', text_value = $2,
              command_fingerprint = $3, updated_at = updated_at
        WHERE id = $1::uuid`,
      [textIntentId, '  first raw value  ', 'a'.repeat(64)],
    )
    await pool.query(
      `UPDATE telegram_action_intents
          SET state = 'awaiting_value', text_value = NULL,
              command_fingerprint = NULL, updated_at = updated_at
        WHERE id = $1::uuid`,
      [textIntentId],
    )
    await pool.query(
      `UPDATE telegram_action_intents
          SET state = 'ready', text_value = $2,
              command_fingerprint = $3, updated_at = updated_at
        WHERE id = $1::uuid`,
      [textIntentId, 'replacement', 'b'.repeat(64)],
    )
    await pool.query(
      `UPDATE telegram_action_intents
          SET state = 'expired', updated_at = updated_at
        WHERE id = $1::uuid`,
      [textIntentId],
    )
    const replacedText = await pool.query<{
      readonly state: string
      readonly text_value: string | null
    }>(
      `SELECT state, text_value
         FROM telegram_action_intents
        WHERE id = $1::uuid`,
      [textIntentId],
    )
    expect(replacedText.rows[0]).toEqual({
      state: 'expired',
      text_value: 'replacement',
    })

    await expect(
      pool.query(
        `INSERT INTO telegram_action_intents (
           id, semantic_key, command_id, space_id, member_id,
           publication_id, plan_goal_snapshot_id, local_date,
           source_facts_revision, intent_kind, state, checklist_item_state,
           command_fingerprint, expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, DATE '2026-04-10', 0,
           'quantity', 'offered', 'done', NULL,
           TIMESTAMPTZ '2026-04-10 08:00:00+00',
           TIMESTAMPTZ '2026-04-10 07:00:00+00',
           TIMESTAMPTZ '2026-04-10 07:00:00+00'
         )`,
        [
          randomUUID(),
          'g04-invalid-state'.padEnd(64, '0'),
          spaceId,
          firstMemberId,
          populatedPublicationId,
          populatedPlanGoalSnapshotId,
        ],
      ),
    ).rejects.toThrow()
  }, 120_000)
})

describe('G02 semantic Telegram action intents', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let clock: FakeProductClock
  let service: TelegramActionIntentService
  let tracking: ReturnType<typeof createTrackingApplication>

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g02_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 12,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-04-10T07:00:00.000Z'))
    tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    service = new TelegramActionIntentService(
      new PrismaActionIntentRepository(provider),
      tracking,
      transaction,
      clock,
    )
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('persists bounded intents and confirms T01 exactly once', async () => {
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
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const member = { spaceId, memberId: firstMemberId, userId: firstUserId }
    const secondMember = {
      spaceId,
      memberId: secondMemberId,
      userId: secondUserId,
    }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2026-04', focus: 'G02 actions' },
    })
    const goals: readonly {
      readonly title: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        title: 'Vitamin',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        title: 'Water',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'ml',
            precision: 0,
            aggregation: 'add',
            target: '1200',
          },
          checkpoints: null,
        },
      },
      {
        title: 'Steps',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'steps',
            precision: 0,
            aggregation: 'latest',
            target: '7000',
          },
          checkpoints: null,
        },
      },
      {
        title: 'Routine',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Routine checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'boolean' },
              },
            ],
          },
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: goals[index]!.title,
          why: 'G02 integration',
          category: 'G02',
        },
      })
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: goals[index]!.config,
          sourceProvenance: null,
        },
      })
    }
    const publicationPreview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (publicationPreview === null) throw new Error('preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: BigInt(publicationPreview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: publicationPreview.schemaVersion,
        previewHashVersion: publicationPreview.previewHashVersion,
        previewHash: publicationPreview.previewHash,
      },
    })

    const today = await tracking.getToday.execute({ trustedActor: actor })
    if (today.state !== 'published') throw new Error('published state missing')
    const vitaminGoal = today.goals.find((goal) => goal.title === 'Vitamin')
    if (vitaminGoal === undefined) throw new Error('Vitamin goal missing')
    const legacySemanticKey = createHash('sha256')
      .update(
        JSON.stringify({
          booleanResult: 'done',
          factsRevision: today.factsRevision.toString(10),
          goalId: vitaminGoal.planGoalSnapshotId,
          kind: 'boolean',
          localDate: today.day.localDate,
          memberId: firstMemberId,
          publicationId: publication.aggregateId,
          spaceId,
        }),
        'utf8',
      )
      .digest('hex')
    const legacyIntentId = randomUUID()
    const legacyFingerprint = commandFingerprint(
      {
        commandType: 'tracking.record-fact.v1',
        resultKind: 'tracking.fact-record.v1',
        toCanonicalPayload: canonicalRecordFactPayload,
      },
      {
        commandId: legacyIntentId,
        trustedActor: { kind: 'member', id: firstMemberId },
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: vitaminGoal.planGoalSnapshotId,
          localDate: today.day.localDate,
          value: { kind: 'boolean', result: 'done' },
        },
      },
    )
    await pool.query(
      `INSERT INTO telegram_action_intents (
         id, semantic_key, command_id, space_id, member_id,
         publication_id, plan_goal_snapshot_id, local_date,
         source_facts_revision, intent_kind, state, boolean_result,
         command_fingerprint, expires_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2, $1::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::date, $8, 'boolean', 'ready', 'done',
         $9, TIMESTAMPTZ '2026-04-10 08:00:00+00',
         TIMESTAMPTZ '2026-04-10 07:00:00+00',
         TIMESTAMPTZ '2026-04-10 07:00:00+00'
       )`,
      [
        legacyIntentId,
        legacySemanticKey,
        spaceId,
        firstMemberId,
        publication.aggregateId,
        vitaminGoal.planGoalSnapshotId,
        today.day.localDate,
        today.factsRevision,
        legacyFingerprint,
      ],
    )
    const firstRender = await service.offerTodayActions(member, today)
    const secondRender = await service.offerTodayActions(member, today)
    expect(secondRender).toEqual(firstRender)
    expect(
      firstRender.find((button) => button.text === '✓ Vitamin')?.actionIntentId,
    ).toBe(legacyIntentId)
    expect(
      firstRender.filter((button) =>
        button.text.includes('Routine checkpoint'),
      ),
    ).toHaveLength(2)

    const vitamin = firstRender.find((button) => button.text === '✓ Vitamin')
    if (vitamin === undefined) throw new Error('Vitamin action missing')
    await expect(
      service.select(secondMember, vitamin.actionIntentId),
    ).resolves.toEqual({ kind: 'not_found' })
    await expect(
      service.select(member, vitamin.actionIntentId),
    ).resolves.toMatchObject({
      kind: 'preview',
      value: { kind: 'boolean', result: 'done' },
    })
    const firstConfirm = await service.confirm(member, vitamin.actionIntentId)
    const replayConfirm = await service.confirm(member, vitamin.actionIntentId)
    expect(replayConfirm).toEqual(firstConfirm)
    expect(firstConfirm).toMatchObject({ kind: 'completed', title: 'Vitamin' })
    const exactOnce = await pool.query<{
      readonly facts_revision: string
      readonly receipts: string
      readonly records: string
    }>(
      `SELECT month.facts_revision::text,
              (SELECT count(*)::text FROM command_receipts
                WHERE command_type = 'tracking.record-fact.v1') receipts,
              (SELECT count(*)::text FROM tracking_fact_records
                WHERE publication_id = $2::uuid) records
         FROM plan_months month WHERE month.id = $1::uuid`,
      [draft.aggregateId, publication.aggregateId],
    )
    expect(exactOnce.rows[0]).toEqual({
      facts_revision: '1',
      receipts: '1',
      records: '1',
    })
    if (firstConfirm.kind !== 'completed') {
      throw new Error('Vitamin confirmation did not complete')
    }
    await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: firstConfirm.result.aggregateRevision,
      payload: {
        factRecordId: firstConfirm.result.aggregateId,
        reason: 'Проверка Boolean tombstone в G02',
      },
    })

    const refreshed = await tracking.getToday.execute({ trustedActor: actor })
    if (refreshed.state !== 'published')
      throw new Error('published state missing')
    const quantityActions = await service.offerTodayActions(member, refreshed)
    expect(
      quantityActions.some(
        (button) => button.text === '✓ Vitamin' || button.text === '✕ Vitamin',
      ),
    ).toBe(false)
    const water = quantityActions.find(
      (button) => button.text === 'Ввести Water',
    )
    const steps = quantityActions.find(
      (button) => button.text === 'Ввести Steps',
    )
    if (water === undefined || steps === undefined) {
      throw new Error('Quantity actions missing')
    }
    await expect(service.select(member, water.actionIntentId)).resolves.toEqual(
      {
        kind: 'awaiting_quantity',
        title: 'Water',
      },
    )
    await expect(service.acceptQuantity(member, '1.5')).resolves.toEqual({
      kind: 'invalid_quantity',
      title: 'Water',
    })
    await expect(
      service.acceptQuantity(member, ' 400 '),
    ).resolves.toMatchObject({
      kind: 'preview',
      value: { kind: 'quantity', value: '400' },
      unit: 'ml',
      aggregation: 'add',
    })
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: {
        publicationId: publication.aggregateId,
        planGoalSnapshotId: refreshed.goals.find(
          (goal) => goal.title === 'Water',
        )!.planGoalSnapshotId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value: '100' },
      },
    })
    await expect(
      service.confirm(member, water.actionIntentId),
    ).resolves.toEqual({
      kind: 'stale',
    })

    await expect(service.select(member, steps.actionIntentId)).resolves.toEqual(
      {
        kind: 'awaiting_quantity',
        title: 'Steps',
      },
    )
    clock.set(new Date('2026-04-10T07:16:00.000Z'))
    await expect(service.acceptQuantity(member, '7000')).resolves.toBeNull()
    await expect(service.select(member, steps.actionIntentId)).resolves.toEqual(
      {
        kind: 'expired',
      },
    )
    const afterExpiry = await service.offerTodayActions(
      member,
      await tracking.getToday.execute({ trustedActor: actor }),
    )
    expect(
      afterExpiry.find((button) => button.text === 'Ввести Steps')
        ?.actionIntentId,
    ).not.toBe(steps.actionIntentId)

    const newSteps = afterExpiry.find(
      (button) => button.text === 'Ввести Steps',
    )
    if (newSteps === undefined) throw new Error('Renewed Steps action missing')
    await service.select(member, newSteps.actionIntentId)
    await service.acceptQuantity(member, '7000')
    const stepsCompleted = await service.confirm(
      member,
      newSteps.actionIntentId,
    )
    if (stepsCompleted.kind !== 'completed') {
      throw new Error('Steps confirmation did not complete')
    }
    await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: stepsCompleted.result.aggregateRevision,
      payload: {
        factRecordId: stepsCompleted.result.aggregateId,
        reason: 'Проверка tombstone в G02',
      },
    })
    const afterTombstone = await service.offerTodayActions(
      member,
      await tracking.getToday.execute({ trustedActor: actor }),
    )
    expect(
      afterTombstone.some((button) => button.text === 'Ввести Steps'),
    ).toBe(false)
    const newWater = afterTombstone.find(
      (button) => button.text === 'Ввести Water',
    )
    if (newWater === undefined) throw new Error('Water add action missing')
    await service.select(member, newWater.actionIntentId)
    await service.acceptQuantity(member, '300')
    await pool.query(`
      ALTER TABLE plan_months DISABLE TRIGGER USER;
      UPDATE plan_months SET status = 'closed'
       WHERE id = '${draft.aggregateId}'::uuid;
      ALTER TABLE plan_months ENABLE TRIGGER USER;
    `)
    await expect(
      service.confirm(member, newWater.actionIntentId),
    ).resolves.toEqual({
      kind: 'blocked',
    })
  }, 120_000)
})
