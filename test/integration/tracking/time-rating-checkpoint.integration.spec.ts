import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { createPlanningApplication } from '@/modules/planning'
import type { PlanningApplication } from '@/modules/planning'
import {
  createTrackingApplication,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const ratingMinimum = Number.MIN_SAFE_INTEGER
const ratingMaximum = Number.MAX_SAFE_INTEGER
const migrationsThroughT01 = [
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
] as const

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly snapshots: Readonly<
    Record<'sleep' | 'mood' | 'meals' | 'energy' | 'flexibleRating', string>
  >
  readonly checkpoints: Readonly<
    Record<
      'morning' | 'day' | 'evening' | 'breakfast' | 'lunch' | 'dinner',
      string
    >
  >
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

function checkpointIds(configValue: unknown): string[] {
  const configObject = configValue as {
    checkpoints: { items: { checkpointId: string }[] }
  }
  return configObject.checkpoints.items.map((item) => item.checkpointId)
}

describe('T02 actual time, rating and checkpoints in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t02_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const runtimeConfig = config(postgres.getConnectionUri())
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(2_000))
    const transaction = new PrismaTransactionAdapter(
      provider,
      context,
      runtimeConfig,
    )
    const members = new PrismaWorkspaceMemberResolver(provider)
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
      payload: { targetMonth: '2026-04', focus: 'T02 facts' },
    })
    const definitions = await Promise.all(
      [
        ['Overnight sleep', 'Cross-midnight actual time'],
        ['Mood checkpoints', 'Low rating is still filled'],
        ['Meal checkpoints', 'All checkpoints form one parent unit'],
        ['Energy rating', 'Top-level rating measurement'],
        ['Flexible rating', 'Deferred fixed-only boundary'],
      ].map(([title, why]) =>
        planning.createGoalDefinition.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: { title: title!, why: why!, category: 'T02' },
        }),
      ),
    )
    const configs = [
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'actual_time' as const,
          start: '22:30',
          end: '07:00',
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'rating' as const, minimum: 1, maximum: 10 },
        checkpoints: {
          aggregation: 'independent' as const,
          items: ['Morning', 'Day', 'Evening'].map((name, index) => ({
            checkpointId: null,
            name,
            deadline: ['12:00', '18:00', '22:00'][index]!,
            satisfaction: { kind: 'rating' as const },
          })),
        },
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'boolean' as const },
        checkpoints: {
          aggregation: 'all' as const,
          items: ['Breakfast', 'Lunch', 'Dinner'].map((name, index) => ({
            checkpointId: null,
            name,
            deadline: ['09:30', '12:30', '20:00'][index]!,
            satisfaction: { kind: 'boolean' as const },
          })),
        },
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'rating' as const,
          minimum: ratingMinimum,
          maximum: ratingMaximum,
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'weekly' as const, n: '1' },
        measurement: { kind: 'rating' as const, minimum: 1, maximum: 10 },
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
    if (preview === null) throw new Error('T02 preview missing')
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
      readonly title: string
      readonly config: unknown
    }>(
      `SELECT id::text, title, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
        ORDER BY display_order`,
      [publication.aggregateId],
    )
    const mood = checkpointIds(rows.rows[1]!.config)
    const meals = checkpointIds(rows.rows[2]!.config)
    clock.set(new Date('2026-04-10T20:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      snapshots: {
        sleep: rows.rows[0]!.id,
        mood: rows.rows[1]!.id,
        meals: rows.rows[2]!.id,
        energy: rows.rows[3]!.id,
        flexibleRating: rows.rows[4]!.id,
      },
      checkpoints: {
        morning: mood[0]!,
        day: mood[1]!,
        evening: mood[2]!,
        breakfast: meals[0]!,
        lunch: meals[1]!,
        dinner: meals[2]!,
      },
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

  it('binds overnight actual time to an explicit prior expectation date and CAS-corrects it', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.sleep,
        expectationDate: '2026-04-10',
        value: '00:30',
      },
    })
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.sleep,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      factsRevision: 1n,
      fact: { kind: 'actual_time', revision: 1n, value: '00:30' },
    })
    await expect(progress(fixture, 'sleep')).resolves.toMatchObject({
      progress: { available: true, basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })
    await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.sleep,
        expectationDate: '2026-04-10',
        value: '12:00',
      },
    })
    await expect(progress(fixture, 'sleep')).resolves.toMatchObject({
      progress: { available: true, basisPoints: '0' },
      coverage: { filled: '1', applicable: '1' },
    })
    await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.sleep,
        expectationDate: '2026-04-11',
        value: '23:00',
      },
    })
    await expect(progress(fixture, 'sleep')).resolves.toMatchObject({
      progress: { available: true, basisPoints: '0' },
      coverage: { filled: '1', applicable: '1' },
    })
    await expect(
      tracking.recordTime.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.sleep,
          expectationDate: '2026-04-10',
          value: '23:00',
        },
      }),
    ).rejects.toMatchObject({
      name: 'FactRevisionConflictError',
      currentRevision: 2n,
    })
  })

  it('rejects PostgreSQL 24:00 before a direct-SQL fact envelope can commit', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const factRecordId = randomUUID()
      await client.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           fixed_expectation_id, flexible_period_id, contribution_id,
           current_revision_id, created_by_member_id, created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                '2026-04-10'::date, 'actual_time', expectation.id,
                NULL, NULL, NULL, $6::uuid, $7::timestamptz, $7::timestamptz
           FROM fixed_expectations expectation
          WHERE expectation.publication_id = $4::uuid
            AND expectation.plan_goal_snapshot_id = $5::uuid
            AND expectation.expectation_date = '2026-04-10'::date
            AND expectation.component_kind = 'goal'
            AND expectation.component_id IS NULL`,
        [
          factRecordId,
          spaceId,
          fixture.planMonthId,
          fixture.publicationId,
          fixture.snapshots.sleep,
          firstMemberId,
          '2026-04-10T20:00:00.123Z',
        ],
      )
      await expect(
        client.query(
          `INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, actual_time_value, rating_value,
             recorded_by_member_id, created_at)
           VALUES (gen_random_uuid(), $1::uuid, 1, 'recorded', NULL, NULL,
                   TIME '24:00', NULL, $2::uuid, $3::timestamptz)`,
          [factRecordId, firstMemberId, '2026-04-10T20:00:00.123Z'],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'tracking_fact_revisions_value_check',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const counts = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    expect(counts.rows[0]).toEqual({
      records: '0',
      revisions: '0',
      facts_revision: '0',
    })
  })

  it('accepts rating min/max and treats a low rating as filled and satisfied', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const low = await tracking.recordRating.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.energy,
        expectationDate: '2026-04-10',
        value: ratingMinimum,
      },
    })
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.energy,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      fact: { kind: 'rating', revision: 1n, value: ratingMinimum },
    })
    await expect(progress(fixture, 'energy')).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
      score: { basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })
    await tracking.recordRating.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: low.aggregateRevision,
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.energy,
        expectationDate: '2026-04-10',
        value: ratingMaximum,
      },
    })
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.energy,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      fact: { kind: 'rating', revision: 2n, value: ratingMaximum },
    })
    for (const [checkpointId, value] of [
      [fixture.checkpoints.morning, 1],
      [fixture.checkpoints.day, 10],
    ] as const) {
      await tracking.recordCheckpoint.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.mood,
          expectationDate: '2026-04-10',
          checkpointId,
          value: { kind: 'rating', value },
        },
      })
    }
    await expect(progress(fixture, 'mood')).resolves.toMatchObject({
      progress: {
        available: true,
        exact: { numerator: '2', denominator: '3' },
      },
      score: { available: true, exact: { numerator: '2', denominator: '3' } },
      coverage: { filled: '2', applicable: '3' },
    })
    for (const value of [0, 11]) {
      await expect(
        tracking.recordCheckpoint.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.mood,
            expectationDate: '2026-04-10',
            checkpointId: fixture.checkpoints.evening,
            value: { kind: 'rating', value },
          },
        }),
      ).rejects.toBeInstanceOf(FactValueInvalidError)
    }
  })

  it('rejects flexible time and rating targets before writes', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    for (const execute of [
      () =>
        tracking.recordRating.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.flexibleRating,
            expectationDate: '2026-04-10',
            value: 1,
          },
        }),
      () =>
        tracking.recordTime.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.flexibleRating,
            expectationDate: '2026-04-10',
            value: '12:00',
          },
        }),
    ]) {
      await expect(execute()).rejects.toEqual(
        new FactTargetUnavailableError('unsupported'),
      )
    }
    const counts = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type IN (
                 'tracking.record-time.v1', 'tracking.record-rating.v1'
               )) receipts,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    expect(counts.rows[0]).toEqual({
      records: '0',
      revisions: '0',
      actions: '0',
      receipts: '0',
      facts_revision: '0',
    })
  })

  it('keeps all-checkpoint parent incomplete until every named checkpoint is filled', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    for (const checkpointId of [
      fixture.checkpoints.breakfast,
      fixture.checkpoints.lunch,
    ]) {
      await tracking.recordCheckpoint.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.meals,
          expectationDate: '2026-04-10',
          checkpointId,
          value: { kind: 'boolean', result: 'done' },
        },
      })
    }
    await expect(progress(fixture, 'meals')).resolves.toMatchObject({
      progress: { basisPoints: '0' },
      coverage: { filled: '0', applicable: '1' },
    })
    await tracking.recordCheckpoint.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.meals,
        expectationDate: '2026-04-10',
        checkpointId: fixture.checkpoints.dinner,
        value: { kind: 'boolean', result: 'done' },
      },
    })
    await expect(progress(fixture, 'meals')).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })
  })

  it('preserves replay precedence and rejects conflicts, foreign targets and concurrent duplicate creates with zero extra effect', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const commandId = randomUUID()
    const command = {
      commandId,
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.mood,
        expectationDate: '2026-04-10',
        checkpointId: fixture.checkpoints.morning,
        value: { kind: 'rating' as const, value: 1 },
      },
    }
    const first = await tracking.recordCheckpoint.execute(command)
    await expect(tracking.recordCheckpoint.execute(command)).resolves.toEqual(
      first,
    )
    await expect(
      tracking.recordCheckpoint.execute({
        ...command,
        payload: { ...command.payload, value: { kind: 'rating', value: 2 } },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    await expect(
      tracking.recordCheckpoint.execute({
        ...command,
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    await expect(
      tracking.recordCheckpoint.execute({
        ...command,
        commandId: randomUUID(),
        payload: { ...command.payload, checkpointId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)
    await expect(
      tracking.recordTime.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.sleep,
          expectationDate: '2026-04-12',
          value: '23:00',
        },
      }),
    ).rejects.toEqual(new FactTargetUnavailableError('future_date'))

    const competing = await Promise.allSettled(
      [1, 2].map((value) =>
        tracking.recordCheckpoint.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: {
            ...command.payload,
            checkpointId: fixture.checkpoints.day,
            value: { kind: 'rating' as const, value },
          },
        }),
      ),
    )
    expect(
      competing.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(competing.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    )
    expect(
      (
        competing.find(
          (item) => item.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toBeInstanceOf(FactRevisionConflictError)
    const audit = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    expect(audit.rows[0]).toEqual({
      records: '2',
      revisions: '2',
      actions: '2',
      facts_revision: '2',
    })
  })

  it('upgrades populated T01 records, history and receipts without rewriting them', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t02_upgrade')
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
      for (const migration of migrationsThroughT01) {
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
      const draft = await upgradePlanning.createEmptyDraft.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: { targetMonth: '2026-04', focus: 'T01 upgrade fixture' },
      })
      const definition = await upgradePlanning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          title: 'T01 Boolean fixture',
          why: 'Prove T02 migration preservation',
          category: 'T02',
        },
      })
      await upgradePlanning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'personal', ownerMemberId: firstMemberId },
            repetition: { kind: 'daily' },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      })
      const preview = await upgradePlanning.buildPublicationPreview.execute({
        trustedUserId: firstUserId,
        targetMonth: '2026-04',
      })
      if (preview === null) throw new Error('T01 upgrade preview missing')
      const publication = await upgradePlanning.publishMonth.execute({
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
      const snapshots = await upgradePool.query<{ readonly id: string }>(
        `SELECT id::text FROM plan_goal_snapshots
          WHERE publication_id = $1::uuid`,
        [publication.aggregateId],
      )
      const snapshotId = snapshots.rows[0]?.id
      if (snapshotId === undefined)
        throw new Error('T01 upgrade snapshot missing')
      const factRecordId = randomUUID()
      const factRevisionId = randomUUID()
      const actionId = randomUUID()
      const commandId = randomUUID()
      const occurredAt = '2026-04-10T20:00:00.123Z'
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
                  '2026-04-10'::date, 'boolean', expectation.id,
                  NULL, NULL, NULL, $6::uuid, $7::timestamptz, $7::timestamptz
             FROM fixed_expectations expectation
            WHERE expectation.publication_id = $4::uuid
              AND expectation.plan_goal_snapshot_id = $5::uuid
              AND expectation.expectation_date = '2026-04-10'::date
              AND expectation.component_kind = 'goal'
              AND expectation.component_id IS NULL`,
          [
            factRecordId,
            spaceId,
            draft.aggregateId,
            publication.aggregateId,
            snapshotId,
            firstMemberId,
            occurredAt,
          ],
        )
        await client.query(
          `INSERT INTO tracking_fact_revisions
            (id, fact_record_id, revision_number, revision_kind,
             boolean_result, quantity_value, recorded_by_member_id, created_at)
           VALUES ($1::uuid, $2::uuid, 1, 'recorded', 'done', NULL,
                   $3::uuid, $4::timestamptz)`,
          [factRevisionId, factRecordId, firstMemberId, occurredAt],
        )
        await client.query(
          `UPDATE tracking_fact_records
              SET current_revision_id = $2::uuid
            WHERE id = $1::uuid`,
          [factRecordId, factRevisionId],
        )
        await client.query(
          `UPDATE plan_months SET facts_revision = 1 WHERE id = $1::uuid`,
          [draft.aggregateId],
        )
        await client.query(
          `INSERT INTO tracking_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id, space_id,
             plan_month_id, publication_id, plan_goal_snapshot_id,
             command_type, command_id, before_facts_revision,
             after_facts_revision, occurred_at)
           VALUES ($1::uuid, 'fact_recorded', 'member', $2, $3::uuid, $4::uuid,
                   $5::uuid, $6::uuid, $7::uuid, 'tracking.record-fact.v1',
                   $8::uuid, 0, 1, $9::timestamptz)`,
          [
            actionId,
            `member:${firstMemberId}`,
            firstMemberId,
            spaceId,
            draft.aggregateId,
            publication.aggregateId,
            snapshotId,
            commandId,
            occurredAt,
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
           VALUES ($1, 'tracking.record-fact.v1', $2::uuid, repeat('a', 64),
                   'tracking.fact-record.v1', $3::uuid, 1, $4::timestamptz)`,
          [`member:${firstMemberId}`, commandId, factRecordId, occurredAt],
        )
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      const before = await upgradePool.query<Record<string, unknown>>(
        `SELECT record.id::text record_id, record.fact_kind,
                record.current_revision_id::text current_revision_id,
                revision.revision_number::text revision_number,
                revision.boolean_result, month.facts_revision::text facts_revision,
                action.id::text action_id, action.command_type,
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
          WHERE record.id = $1::uuid`,
        [factRecordId],
      )
      await applyMigration(
        upgradePool,
        '20260811161000_time_rating_checkpoints',
      )
      const after = await upgradePool.query<Record<string, unknown>>(
        `SELECT record.id::text record_id, record.fact_kind,
                record.current_revision_id::text current_revision_id,
                revision.revision_number::text revision_number,
                revision.boolean_result, month.facts_revision::text facts_revision,
                action.id::text action_id, action.command_type,
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
          WHERE record.id = $1::uuid`,
        [factRecordId],
      )
      expect(after.rows).toEqual(before.rows)
      await expect(
        upgradePool.query(
          `SELECT revision.actual_time_value, revision.rating_value,
                  t01_fact_record_has_exact_shape(record.id) record_valid,
                  t01_action_has_exact_shape(action.id) action_valid
             FROM tracking_fact_records record
             JOIN tracking_fact_revisions revision
               ON revision.id = record.current_revision_id
             JOIN tracking_fact_changes change
               ON change.fact_record_id = record.id
              AND change.after_revision_id = record.current_revision_id
             JOIN tracking_action_groups action ON action.id = change.action_id
            WHERE record.id = $1::uuid`,
          [factRecordId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            actual_time_value: null,
            rating_value: null,
            record_valid: true,
            action_valid: true,
          },
        ],
      })
      await expect(
        upgradePool.query(
          `UPDATE tracking_fact_revisions SET boolean_result = boolean_result
            WHERE id = $1::uuid`,
          [factRevisionId],
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
