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
  CorrectRecordCommand,
  createTrackingApplication,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  PrismaFactPersistence,
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
const migrationsThroughT04 = [
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
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly personalTextSnapshotId: string
  readonly sharedQuantitySnapshotId: string
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

describe('T05 corrections and tombstones in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t05_integration')
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

  async function publishedFixture(
    application: PlanningApplication = planning,
    database: Pool = pool,
    runtimeClock: FakeProductClock = clock,
  ): Promise<Fixture> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'T05 mutations' },
    })
    const personal = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Personal text', why: 'Audit', category: 'T05' },
    })
    const shared = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Shared quantity', why: 'Audit', category: 'T05' },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: personal.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: shared.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'раз',
            precision: 0,
            aggregation: 'latest',
            target: '10',
          },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('T05 preview missing')
    const publication = await application.publishMonth.execute({
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
    const snapshots = await database.query<{ readonly id: string }>(
      `SELECT id::text FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid ORDER BY display_order`,
      [publication.aggregateId],
    )
    runtimeClock.set(new Date('2026-04-10T20:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      personalTextSnapshotId: snapshots.rows[0]!.id,
      sharedQuantitySnapshotId: snapshots.rows[1]!.id,
    }
  }

  async function recordPersonal(fixture: Fixture): Promise<{
    readonly aggregateId: string
    readonly aggregateRevision: bigint
  }> {
    return tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.personalTextSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Первоначально',
        result: 'not_done',
      },
    })
  }

  async function recordShared(fixture: Fixture): Promise<{
    readonly aggregateId: string
    readonly aggregateRevision: bigint
  }> {
    return tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.sharedQuantitySnapshotId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value: '4' },
      },
    })
  }

  it('corrects, tombstones and revives personal fact without changing original recorder', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordPersonal(fixture)
    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'text', text: 'Исправлено', result: 'done' },
        reason: 'Исправлена ошибка',
      },
    })
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: corrected.aggregateRevision,
      payload: { factRecordId: first.aggregateId, reason: 'Запись лишняя' },
    })
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.personalTextSnapshotId,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({ factsRevision: 3n, fact: null })
    await expect(
      tracking.getGoalProgress.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.personalTextSnapshotId,
        asOfLocalDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      progress: { basisPoints: '0' },
      coverage: { filled: '0', applicable: '1' },
    })
    const revived = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: deleted.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'text', text: 'Возвращено', result: 'done' },
        reason: 'Удаление было ошибочным',
      },
    })
    expect(revived.aggregateRevision).toBe(4n)
    await expect(
      tracking.getGoalProgress.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.personalTextSnapshotId,
        asOfLocalDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })
    const audit = await pool.query<Record<string, string | null>>(
      `SELECT record.created_by_member_id::text original_recorder,
              current_revision.recorded_by_member_id::text last_editor,
              current_revision.revision_kind,
              current_revision.text_value,
              count(revision.id)::text revisions,
              (SELECT string_agg(action.action_kind || ':' || action.reason, '|'
                         ORDER BY action.after_facts_revision)
                 FROM tracking_action_groups action
                WHERE action.plan_month_id = record.plan_month_id
                  AND action.action_kind <> 'fact_recorded') mutation_audit
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions current_revision
           ON current_revision.id = record.current_revision_id
         JOIN tracking_fact_revisions revision
           ON revision.fact_record_id = record.id
        WHERE record.id = $1::uuid
        GROUP BY record.id, current_revision.id`,
      [first.aggregateId],
    )
    expect(audit.rows[0]).toEqual({
      original_recorder: firstMemberId,
      last_editor: firstMemberId,
      revision_kind: 'recorded',
      text_value: 'Возвращено',
      revisions: '4',
      mutation_audit:
        'fact_corrected:Исправлена ошибка|fact_tombstoned:Запись лишняя|fact_corrected:Удаление было ошибочным',
    })
  })

  it('lets the partner correct shared fact with reason and forbids shared delete', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordShared(fixture)
    const command = {
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'quantity' as const, value: '7' },
        reason: 'Уточнено совместно',
      },
    }
    const corrected = await tracking.correctRecord.execute(command)
    await expect(tracking.correctRecord.execute(command)).resolves.toEqual(
      corrected,
    )
    await expect(
      tracking.deleteRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        expectedRevision: corrected.aggregateRevision,
        payload: { factRecordId: first.aggregateId, reason: 'Нельзя удалять' },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.sharedQuantitySnapshotId,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      factsRevision: 2n,
      fact: {
        value: '7',
        recordedByMemberId: secondMemberId,
        revision: 2n,
      },
    })
    const original = await pool.query<{ readonly member_id: string }>(
      `SELECT created_by_member_id::text member_id
         FROM tracking_fact_records WHERE id = $1::uuid`,
      [first.aggregateId],
    )
    expect(original.rows[0]?.member_id).toBe(firstMemberId)
  })

  it('denies partner personal mutations and requires dedicated correction command', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordPersonal(fixture)
    await expect(
      tracking.correctRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        expectedRevision: first.aggregateRevision,
        payload: {
          factRecordId: first.aggregateId,
          value: { kind: 'text', text: 'Чужое', result: 'done' },
          reason: 'Нет прав',
        },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    await expect(
      tracking.recordText.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: first.aggregateRevision,
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.personalTextSnapshotId,
          expectationDate: '2026-04-10',
          checkpointId: null,
          text: 'Обход',
          result: 'done',
        },
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('correction_required'))
    const counts = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
              (SELECT count(*)::text FROM tracking_action_groups) actions,
              (SELECT count(*)::text FROM command_receipts
                WHERE command_type IN (
                  'tracking.correct-record.v1', 'tracking.record-text.v1'
                )) receipts,
              (SELECT facts_revision::text FROM plan_months
                WHERE id = $1::uuid) facts_revision`,
      [fixture.planMonthId],
    )
    expect(counts.rows[0]).toEqual({
      revisions: '1',
      actions: '1',
      receipts: '1',
      facts_revision: '1',
    })
  })

  it('preserves replay precedence and rejects conflict, stale, missing and expired mutations', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordShared(fixture)
    const command = {
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      expectedRevision: first.aggregateRevision,
      payload: {
        factRecordId: first.aggregateId,
        value: { kind: 'quantity' as const, value: '6' },
        reason: 'Верное значение',
      },
    }
    const result = await tracking.correctRecord.execute(command)
    clock.set(new Date('2026-06-01T00:00:00.000Z'))
    await expect(tracking.correctRecord.execute(command)).resolves.toEqual(
      result,
    )
    await expect(
      tracking.correctRecord.execute({
        ...command,
        payload: { ...command.payload, reason: 'Другой fingerprint' },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    clock.set(new Date('2026-04-11T20:00:00.123Z'))
    await expect(
      tracking.correctRecord.execute({
        ...command,
        commandId: randomUUID(),
        expectedRevision: 1n,
      }),
    ).rejects.toBeInstanceOf(FactRevisionConflictError)
    await expect(
      tracking.correctRecord.execute({
        ...command,
        commandId: randomUUID(),
        payload: { ...command.payload, factRecordId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)
    clock.set(new Date('2026-05-03T19:00:00.000Z'))
    await expect(
      tracking.correctRecord.execute({
        ...command,
        commandId: randomUUID(),
        expectedRevision: 2n,
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('closed'))
  })

  it('serializes concurrent corrections with one revision and facts increment', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordShared(fixture)
    const attempts = await Promise.allSettled(
      ['6', '8'].map((value) =>
        tracking.correctRecord.execute({
          commandId: randomUUID(),
          trustedActor: actor(secondMemberId),
          expectedRevision: first.aggregateRevision,
          payload: {
            factRecordId: first.aggregateId,
            value: { kind: 'quantity', value },
            reason: `Concurrent ${value}`,
          },
        }),
      ),
    )
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    const loser = attempts.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )
    expect(loser?.reason).toBeInstanceOf(FactRevisionConflictError)
    const counts = await pool.query<Record<string, string>>(
      `SELECT count(*)::text revisions,
              (SELECT facts_revision::text FROM plan_months
                WHERE id = $2::uuid) facts_revision
         FROM tracking_fact_revisions WHERE fact_record_id = $1::uuid`,
      [first.aggregateId, fixture.planMonthId],
    )
    expect(counts.rows[0]).toEqual({ revisions: '2', facts_revision: '2' })
  })

  it('rolls back every correction write phase and completed receipt', async () => {
    const phases: readonly FactWritePhase[] = [
      'revision',
      'pointer',
      'facts_revision',
      'history',
    ]
    for (const phase of phases) {
      await resetPair()
      const fixture = await publishedFixture()
      const first = await recordShared(fixture)
      const persistence = new PrismaFactPersistence(provider, (current) => {
        if (current === phase) throw new Error(`failpoint:${phase}`)
      })
      const command = new CorrectRecordCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        persistence,
      )
      await expect(
        command.execute({
          commandId: randomUUID(),
          trustedActor: actor(secondMemberId),
          expectedRevision: first.aggregateRevision,
          payload: {
            factRecordId: first.aggregateId,
            value: { kind: 'quantity', value: '9' },
            reason: 'Rollback',
          },
        }),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
      const counts = await pool.query<Record<string, string>>(
        `SELECT (SELECT count(*)::text FROM tracking_fact_revisions
                  WHERE fact_record_id = $1::uuid) revisions,
                (SELECT count(*)::text FROM tracking_action_groups
                  WHERE action_kind = 'fact_corrected') corrections,
                (SELECT count(*)::text FROM command_receipts
                  WHERE command_type = 'tracking.correct-record.v1') receipts,
                (SELECT facts_revision::text FROM plan_months
                  WHERE id = $2::uuid) facts_revision`,
        [first.aggregateId, fixture.planMonthId],
      )
      expect(counts.rows[0]).toEqual({
        revisions: '1',
        corrections: '0',
        receipts: '0',
        facts_revision: '1',
      })
    }
  })

  it('preserves a populated T01-T04 correction envelope through T05 upgrade', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t05_upgrade')
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
      for (const migration of migrationsThroughT04) {
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
      const upgradeTracking = createTrackingApplication({
        database: upgradeProvider,
        transaction: upgradeTransaction,
        workspaceMembers: upgradeMembers,
        clock: upgradeClock,
      })
      const fixture = await publishedFixture(
        upgradePlanning,
        upgradePool,
        upgradeClock,
      )
      const first = await upgradeTracking.recordText.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.personalTextSnapshotId,
          expectationDate: '2026-04-10',
          checkpointId: null,
          text: 'До T05',
          result: 'not_done',
        },
      })
      const legacyActionId = randomUUID()
      const legacyRevisionId = randomUUID()
      const legacyCommandId = randomUUID()
      const occurredAt = '2026-04-11T01:00:00.123Z'
      const before = await upgradePool.query<{ readonly id: string }>(
        `SELECT current_revision_id::text id FROM tracking_fact_records
          WHERE id = $1::uuid`,
        [first.aggregateId],
      )
      const legacyClient = await upgradePool.connect()
      try {
        await legacyClient.query('BEGIN')
        await legacyClient.query(
          `INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, actual_time_value, rating_value,
             text_value, text_result, checklist_item_state, or_variant_value,
             recorded_by_member_id, created_at)
           VALUES ($1::uuid, $2::uuid, 2, 'recorded', NULL, NULL, NULL, NULL,
                   'Legacy correction', 'done', NULL, NULL,
                   $3::uuid, $4::timestamptz)`,
          [legacyRevisionId, first.aggregateId, firstMemberId, occurredAt],
        )
        await legacyClient.query(
          `UPDATE tracking_fact_records
              SET current_revision_id = $2::uuid, updated_at = $3::timestamptz
            WHERE id = $1::uuid`,
          [first.aggregateId, legacyRevisionId, occurredAt],
        )
        await legacyClient.query(
          `UPDATE plan_months SET facts_revision = 2 WHERE id = $1::uuid`,
          [fixture.planMonthId],
        )
        await legacyClient.query(
          `INSERT INTO tracking_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id, space_id,
             plan_month_id, publication_id, plan_goal_snapshot_id,
             command_type, command_id, before_facts_revision,
             after_facts_revision, occurred_at)
           VALUES ($1::uuid, 'fact_recorded', 'member', $2, $3::uuid, $4::uuid,
                   $5::uuid, $6::uuid, $7::uuid, 'tracking.record-text.v1',
                   $8::uuid, 1, 2, $9::timestamptz)`,
          [
            legacyActionId,
            `member:${firstMemberId}`,
            firstMemberId,
            spaceId,
            fixture.planMonthId,
            fixture.publicationId,
            fixture.personalTextSnapshotId,
            legacyCommandId,
            occurredAt,
          ],
        )
        await legacyClient.query(
          `INSERT INTO tracking_fact_changes
            (action_id, fact_record_id, before_revision_id, after_revision_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
          [
            legacyActionId,
            first.aggregateId,
            before.rows[0]!.id,
            legacyRevisionId,
          ],
        )
        await legacyClient.query(
          `INSERT INTO command_receipts
            (actor_scope, command_type, command_id, fingerprint, result_kind,
             aggregate_id, aggregate_revision, completed_at)
           VALUES ($1, 'tracking.record-text.v1', $2::uuid, repeat('c', 64),
                   'tracking.fact-record.v1', $3::uuid, 2, $4::timestamptz)`,
          [
            `member:${firstMemberId}`,
            legacyCommandId,
            first.aggregateId,
            occurredAt,
          ],
        )
        await legacyClient.query('COMMIT')
      } finally {
        await legacyClient.query('ROLLBACK').catch(() => undefined)
        legacyClient.release()
      }
      await expect(
        upgradePool.query<{ readonly valid: boolean }>(
          `SELECT t01_action_has_exact_shape($1::uuid) valid`,
          [legacyActionId],
        ),
      ).resolves.toMatchObject({ rows: [{ valid: true }] })
      await applyMigration(
        upgradePool,
        '20260811164000_fact_corrections_tombstones',
      )
      const after = await upgradePool.query<{
        readonly action_valid: boolean
        readonly record_valid: boolean
        readonly revisions: string
      }>(
        `SELECT t01_action_has_exact_shape($1::uuid) action_valid,
                t01_fact_record_has_exact_shape($2::uuid) record_valid,
                (SELECT count(*)::text FROM tracking_fact_revisions
                  WHERE fact_record_id = $2::uuid) revisions`,
        [legacyActionId, first.aggregateId],
      )
      expect(after.rows).toEqual([
        { action_valid: true, record_valid: true, revisions: '2' },
      ])
    } finally {
      await upgradeProvider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
      await upgradePool.end()
      await upgrade.stop()
    }
  })

  it('enforces reason, command mode, immutable history and tombstone shape in SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordPersonal(fixture)
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: { factRecordId: first.aggregateId, reason: 'SQL audit' },
    })
    const shape = await pool.query<{ readonly valid: boolean }>(
      `SELECT t01_action_has_exact_shape(action.id) valid
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change ON change.action_id = action.id
        WHERE change.after_revision_id = (
          SELECT id FROM tracking_fact_revisions
           WHERE fact_record_id = $1::uuid AND revision_number = 2
        )`,
      [first.aggregateId],
    )
    expect(shape.rows).toEqual([{ valid: true }])
    await expect(
      pool.query(
        `UPDATE tracking_action_groups SET reason = 'changed'
          WHERE command_type = 'tracking.delete-record.v1'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 99, 'tombstoned', NULL, NULL,
                 NULL, NULL, 'forged', NULL, NULL, NULL, $2::uuid, now())`,
        [first.aggregateId, firstMemberId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'tracking_fact_revisions_value_check',
    })
    await expect(
      tracking.deleteRecord.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: deleted.aggregateRevision,
        payload: { factRecordId: first.aggregateId, reason: 'Повтор' },
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('already_deleted'))
  })

  it('rejects a complete old record-command correction envelope in SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordPersonal(fixture)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query<{ readonly id: string }>(
        `SELECT current_revision_id::text id FROM tracking_fact_records
          WHERE id = $1::uuid`,
        [first.aggregateId],
      )
      const afterRevisionId = randomUUID()
      const actionId = randomUUID()
      const commandId = randomUUID()
      const occurredAt = '2026-04-11T01:00:00.123Z'
      await client.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
         VALUES ($1::uuid, $2::uuid, 2, 'recorded', NULL, NULL, NULL, NULL,
                 'Bypass', 'done', NULL, NULL, $3::uuid, $4::timestamptz)`,
        [afterRevisionId, first.aggregateId, firstMemberId, occurredAt],
      )
      await client.query(
        `UPDATE tracking_fact_records
            SET current_revision_id = $2::uuid, updated_at = $3::timestamptz
          WHERE id = $1::uuid`,
        [first.aggregateId, afterRevisionId, occurredAt],
      )
      await client.query(
        `UPDATE plan_months SET facts_revision = 2 WHERE id = $1::uuid`,
        [fixture.planMonthId],
      )
      await client.query(
        `INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
         VALUES ($1::uuid, 'fact_recorded', 'member', $2, $3::uuid, $4::uuid,
                 $5::uuid, $6::uuid, $7::uuid, 'tracking.record-text.v1',
                 $8::uuid, 1, 2, NULL, $9::timestamptz)`,
        [
          actionId,
          `member:${firstMemberId}`,
          firstMemberId,
          spaceId,
          fixture.planMonthId,
          fixture.publicationId,
          fixture.personalTextSnapshotId,
          commandId,
          occurredAt,
        ],
      )
      await client.query(
        `INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [actionId, first.aggregateId, before.rows[0]!.id, afterRevisionId],
      )
      await client.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'tracking.record-text.v1', $2::uuid, repeat('a', 64),
                 'tracking.fact-record.v1', $3::uuid, 2, $4::timestamptz)`,
        [`member:${firstMemberId}`, commandId, first.aggregateId, occurredAt],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('rejects a complete repeated tombstone envelope in SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await recordPersonal(fixture)
    const deleted = await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: { factRecordId: first.aggregateId, reason: 'Первое удаление' },
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query<{ readonly id: string }>(
        `SELECT current_revision_id::text id FROM tracking_fact_records
          WHERE id = $1::uuid`,
        [first.aggregateId],
      )
      const afterRevisionId = randomUUID()
      const actionId = randomUUID()
      const commandId = randomUUID()
      const occurredAt = '2026-04-11T02:00:00.123Z'
      await client.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
         VALUES ($1::uuid, $2::uuid, 3, 'tombstoned', NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, $3::uuid, $4::timestamptz)`,
        [afterRevisionId, first.aggregateId, firstMemberId, occurredAt],
      )
      await client.query(
        `UPDATE tracking_fact_records
            SET current_revision_id = $2::uuid, updated_at = $3::timestamptz
          WHERE id = $1::uuid`,
        [first.aggregateId, afterRevisionId, occurredAt],
      )
      await client.query(
        `UPDATE plan_months SET facts_revision = 3 WHERE id = $1::uuid`,
        [fixture.planMonthId],
      )
      await client.query(
        `INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, reason, occurred_at)
         VALUES ($1::uuid, 'fact_tombstoned', 'member', $2, $3::uuid, $4::uuid,
                 $5::uuid, $6::uuid, $7::uuid, 'tracking.delete-record.v1',
                 $8::uuid, 2, 3, 'Повторное удаление', $9::timestamptz)`,
        [
          actionId,
          `member:${firstMemberId}`,
          firstMemberId,
          spaceId,
          fixture.planMonthId,
          fixture.publicationId,
          fixture.personalTextSnapshotId,
          commandId,
          occurredAt,
        ],
      )
      await client.query(
        `INSERT INTO tracking_fact_changes
          (action_id, fact_record_id, before_revision_id, after_revision_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [actionId, first.aggregateId, before.rows[0]!.id, afterRevisionId],
      )
      await client.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'tracking.delete-record.v1', $2::uuid, repeat('b', 64),
                 'tracking.fact-record.v1', $3::uuid, 3, $4::timestamptz)`,
        [`member:${firstMemberId}`, commandId, first.aggregateId, occurredAt],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    expect(deleted.aggregateRevision).toBe(2n)
  })
})
