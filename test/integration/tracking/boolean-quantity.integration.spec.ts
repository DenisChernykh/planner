import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { createPlanningApplication } from '@/modules/planning'
import {
  createTrackingApplication,
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  PrismaFactPersistence,
  RecordFactCommand,
  TrackingDependencyUnavailableError,
  type FactWritePhase,
  type RecordFactApplicationCommand,
  TrackingAuthorizationDeniedError,
  type TrackingApplication,
} from '@/modules/tracking'
import type { PlanningApplication } from '@/modules/planning'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
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

type Fixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly snapshots: Readonly<
    Record<'water' | 'steps' | 'vitamin' | 'shared', string>
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

async function executeMigration(targetPool: Pool, sql: string): Promise<void> {
  const client = await targetPool.connect()
  try {
    await client.query(sql)
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
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

describe('T01 Boolean and quantity record kernel', () => {
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
      .withDatabase('planner_t01_integration')
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
    clock = new FakeProductClock(new Date('2026-03-30T18:00:00.123Z'))
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
    clock.set(new Date('2026-03-30T18:00:00.123Z'))
  }

  async function publishedFixture(): Promise<Fixture> {
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', focus: 'T01 fact kernel' },
    })
    const definitions = []
    for (const [title, config] of [
      [
        'Water',
        {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' as const },
          measurement: {
            kind: 'quantity' as const,
            mode: 'targeted' as const,
            unit: 'ml',
            precision: 0 as const,
            aggregation: 'add' as const,
            target: '1200',
          },
          checkpoints: null,
        },
      ],
      [
        'Steps',
        {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'weekly' as const, n: '5' },
          measurement: {
            kind: 'quantity' as const,
            mode: 'targeted' as const,
            unit: 'steps',
            precision: 0 as const,
            aggregation: 'latest' as const,
            target: '7000',
          },
          checkpoints: null,
        },
      ],
      [
        'Vitamin',
        {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' as const },
          measurement: { kind: 'boolean' as const },
          checkpoints: null,
        },
      ],
      [
        'Shared order',
        {
          schemaVersion: 1 as const,
          scope: { kind: 'shared' as const },
          repetition: { kind: 'daily' as const },
          measurement: { kind: 'boolean' as const },
          checkpoints: null,
        },
      ],
    ] as const) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: { title, why: `${title} reason`, category: 'T01' },
      })
      definitions.push(definition.aggregateId)
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(definitions.length),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config,
          sourceProvenance: null,
        },
      })
    }
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
    const rows = await pool.query<{ id: string; title: string }>(
      `SELECT id::text, title FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid ORDER BY display_order`,
      [publication.aggregateId],
    )
    clock.set(new Date('2026-04-10T07:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      snapshots: {
        water: rows.rows[0]!.id,
        steps: rows.rows[1]!.id,
        vitamin: rows.rows[2]!.id,
        shared: rows.rows[3]!.id,
      },
    }
  }

  function command(
    fixture: Fixture,
    snapshot: keyof Fixture['snapshots'],
    value:
      | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
      | { readonly kind: 'quantity'; readonly value: string },
    input: {
      readonly commandId?: string
      readonly memberId?: string
      readonly expectedRevision?: bigint
      readonly localDate?: string
    } = {},
  ): RecordFactApplicationCommand {
    return {
      commandId: input.commandId ?? randomUUID(),
      trustedActor: actor(input.memberId),
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots[snapshot],
        localDate: input.localDate ?? '2026-04-10',
        value,
      },
    }
  }

  it('sums independent water add contributions and increments facts revision once per command', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await tracking.recordFact.execute(
      command(fixture, 'water', { kind: 'quantity', value: '400' }),
    )
    await tracking.recordFact.execute(
      command(fixture, 'water', { kind: 'quantity', value: '800' }),
    )
    await expect(
      tracking.getFactState.execute({
        trustedActor: actor(secondMemberId),
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.water,
        localDate: '2026-04-10',
      }),
    ).resolves.toMatchObject({
      factsRevision: 2n,
      fact: {
        kind: 'quantity_add',
        contributions: [{ value: '400' }, { value: '800' }],
      },
    })
  })

  it('keeps only the current latest quantity while retaining append-only revisions', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await tracking.recordFact.execute(
      command(fixture, 'steps', { kind: 'quantity', value: '2000' }),
    )
    const latest = await tracking.recordFact.execute(
      command(
        fixture,
        'steps',
        { kind: 'quantity', value: '7000' },
        { expectedRevision: 1n },
      ),
    )
    expect({ first, latest }).toMatchObject({
      first: { aggregateRevision: 1n },
      latest: { aggregateId: first.aggregateId, aggregateRevision: 2n },
    })
    const state = await tracking.getFactState.execute({
      trustedActor: actor(),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots.steps,
      localDate: '2026-04-10',
    })
    expect(state).toMatchObject({
      factsRevision: 2n,
      fact: { kind: 'quantity_latest', revision: 2n, value: '7000' },
    })
    const revisions = await pool.query<{ value: string }>(
      `SELECT quantity_value value FROM tracking_fact_revisions
        WHERE fact_record_id = $1::uuid ORDER BY revision_number`,
      [first.aggregateId],
    )
    expect(revisions.rows).toEqual([{ value: '2000' }, { value: '7000' }])
  })

  it('replays a Boolean command exactly and rejects the same key with another payload', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const commandId = randomUUID()
    const original = command(
      fixture,
      'vitamin',
      { kind: 'boolean', result: 'done' },
      { commandId },
    )
    const first = await tracking.recordFact.execute(original)
    await expect(tracking.recordFact.execute(original)).resolves.toEqual(first)
    await expect(
      tracking.recordFact.execute({
        ...original,
        payload: {
          ...original.payload,
          value: { kind: 'boolean', result: 'not_done' },
        },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    const counts = await pool.query<{
      records: string
      revisions: string
      actions: string
    }>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions
    `)
    expect(counts.rows[0]).toEqual({
      records: '1',
      revisions: '1',
      actions: '1',
    })
  })

  it('accepts concurrent add contributions but creates one shared Boolean effect', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const adds = await Promise.allSettled([
      tracking.recordFact.execute(
        command(fixture, 'water', { kind: 'quantity', value: '100' }),
      ),
      tracking.recordFact.execute(
        command(fixture, 'water', { kind: 'quantity', value: '200' }),
      ),
    ])
    expect(adds.every((result) => result.status === 'fulfilled')).toBe(true)

    const shared = await Promise.allSettled([
      tracking.recordFact.execute(
        command(fixture, 'shared', { kind: 'boolean', result: 'done' }),
      ),
      tracking.recordFact.execute(
        command(
          fixture,
          'shared',
          { kind: 'boolean', result: 'done' },
          { memberId: secondMemberId },
        ),
      ),
    ])
    expect(
      shared.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = shared.find((result) => result.status === 'rejected')
    expect(
      rejected?.status === 'rejected' ? rejected.reason : null,
    ).toBeInstanceOf(FactRevisionConflictError)
    const state = await tracking.getFactState.execute({
      trustedActor: actor(),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots.shared,
      localDate: '2026-04-10',
    })
    expect(state).toMatchObject({ fact: { kind: 'boolean', revision: 1n } })
  })

  it('enforces personal ownership, target type, precision, future date and stale CAS with zero writes', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const before = await pool.query<{ facts_revision: string }>(
      'SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid',
      [fixture.planMonthId],
    )
    await expect(
      tracking.recordFact.execute(
        command(
          fixture,
          'water',
          { kind: 'quantity', value: '400' },
          { memberId: secondMemberId },
        ),
      ),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    await expect(
      tracking.recordFact.execute(
        command(fixture, 'water', { kind: 'quantity', value: '1.5' }),
      ),
    ).rejects.toBeInstanceOf(FactValueInvalidError)
    await expect(
      tracking.recordFact.execute(
        command(fixture, 'vitamin', { kind: 'quantity', value: '1' }),
      ),
    ).rejects.toBeInstanceOf(FactValueInvalidError)
    await expect(
      tracking.recordFact.execute(
        command(
          fixture,
          'water',
          { kind: 'quantity', value: '400' },
          { expectedRevision: 1n },
        ),
      ),
    ).rejects.toEqual(new FactRevisionConflictError(1n, null))
    await expect(
      tracking.recordFact.execute(
        command(
          fixture,
          'vitamin',
          { kind: 'boolean', result: 'done' },
          { localDate: '2026-04-11' },
        ),
      ),
    ).rejects.toEqual(new FactTargetUnavailableError('future_date'))

    const first = await tracking.recordFact.execute(
      command(fixture, 'steps', { kind: 'quantity', value: '2000' }),
    )
    await tracking.recordFact.execute(
      command(
        fixture,
        'steps',
        { kind: 'quantity', value: '7000' },
        { expectedRevision: first.aggregateRevision },
      ),
    )
    await expect(
      tracking.recordFact.execute(
        command(
          fixture,
          'steps',
          { kind: 'quantity', value: '6000' },
          { expectedRevision: 1n },
        ),
      ),
    ).rejects.toMatchObject({
      name: 'FactRevisionConflictError',
      expectedRevision: 1n,
      currentRevision: 2n,
    })
    const after = await pool.query<{ facts_revision: string }>(
      'SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid',
      [fixture.planMonthId],
    )
    expect({ before: before.rows[0], after: after.rows[0] }).toEqual({
      before: { facts_revision: '0' },
      after: { facts_revision: '2' },
    })
  })

  it('hides missing targets and rejects an inactive publication without writes', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await expect(
      tracking.recordFact.execute({
        ...command(fixture, 'vitamin', { kind: 'boolean', result: 'done' }),
        payload: {
          ...command(fixture, 'vitamin', {
            kind: 'boolean',
            result: 'done',
          }).payload,
          publicationId: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(FactTargetNotFoundError)

    clock.set(new Date('2026-03-30T18:00:00.123Z'))
    await planning.cancelPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: fixture.planMonthId,
        publicationId: fixture.publicationId,
      },
    })
    clock.set(new Date('2026-04-10T07:00:00.123Z'))
    await expect(
      tracking.recordFact.execute(
        command(fixture, 'vitamin', { kind: 'boolean', result: 'done' }),
      ),
    ).rejects.toEqual(new FactTargetUnavailableError('not_active'))
    const counts = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT count(*)::text FROM tracking_fact_changes) changes,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    expect(counts.rows[0]).toEqual({
      records: '0',
      revisions: '0',
      actions: '0',
      changes: '0',
      facts_revision: '0',
    })
  })

  it('rolls back every fact write phase and the completed receipt', async () => {
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
      const recordFact = new RecordFactCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        persistence,
      )
      await expect(
        recordFact.execute(
          command(fixture, 'water', { kind: 'quantity', value: '400' }),
        ),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
      const counts = await pool.query<Record<string, string>>(`
        SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
               (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
               (SELECT count(*)::text FROM tracking_action_groups) actions,
               (SELECT count(*)::text FROM tracking_fact_changes) changes,
               (SELECT count(*)::text FROM command_receipts
                 WHERE command_type = 'tracking.record-fact.v1') receipts,
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

  it('enforces immutable history and deferred action/receipt/effect constraints in SQL', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await tracking.recordFact.execute(
      command(fixture, 'vitamin', { kind: 'boolean', result: 'done' }),
    )
    const result = await tracking.recordFact.execute(
      command(
        fixture,
        'vitamin',
        { kind: 'boolean', result: 'not_done' },
        { expectedRevision: first.aggregateRevision },
      ),
    )
    const shape = await pool.query<{ valid: boolean }>(
      `SELECT t01_action_has_exact_shape(action.id) valid
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change ON change.action_id = action.id
         JOIN tracking_fact_records record ON record.id = change.fact_record_id
        WHERE change.fact_record_id = $1::uuid
          AND change.after_revision_id = record.current_revision_id`,
      [result.aggregateId],
    )
    expect(shape.rows).toEqual([{ valid: true }])
    await expect(
      pool.query(
        `INSERT INTO tracking_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, space_id,
           plan_month_id, publication_id, plan_goal_snapshot_id,
           command_type, command_id, before_facts_revision,
           after_facts_revision, occurred_at)
         SELECT gen_random_uuid(), action_kind, actor_kind, actor_scope,
                member_id, space_id, plan_month_id, publication_id,
                plan_goal_snapshot_id, command_type, gen_random_uuid(),
                before_facts_revision, after_facts_revision, occurred_at
           FROM tracking_action_groups
          WHERE plan_month_id = $1::uuid
            AND after_facts_revision = 2`,
        [fixture.planMonthId],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'tracking_action_groups_month_facts_revision_key',
    })
    for (const sql of [
      `UPDATE tracking_fact_revisions SET revision_kind = revision_kind
        WHERE fact_record_id = '${result.aggregateId}'::uuid`,
      `DELETE FROM tracking_action_groups
        WHERE id IN (SELECT action_id FROM tracking_fact_changes
          WHERE fact_record_id = '${result.aggregateId}'::uuid)`,
      `UPDATE tracking_fact_records SET local_date = local_date + 1
        WHERE id = '${result.aggregateId}'::uuid`,
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE plan_months SET facts_revision = facts_revision + 1
          WHERE id = $1::uuid`,
        [fixture.planMonthId],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }

    const pointerClient = await pool.connect()
    try {
      await pointerClient.query('BEGIN')
      await pointerClient.query(
        `UPDATE tracking_fact_records record
            SET current_revision_id = revision.id,
                updated_at = revision.created_at
           FROM tracking_fact_revisions revision
          WHERE record.id = $1::uuid
            AND revision.fact_record_id = record.id
            AND revision.revision_number = 1`,
        [result.aggregateId],
      )
      await expect(pointerClient.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await pointerClient.query('ROLLBACK').catch(() => undefined)
      pointerClient.release()
    }
    const state = await tracking.getFactState.execute({
      trustedActor: actor(),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots.vitamin,
      localDate: '2026-04-10',
    })
    expect(state).toMatchObject({ factsRevision: 2n, fact: { revision: 2n } })
  })

  it('rejects a complete direct-SQL fact envelope for a future local date', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const before = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT count(*)::text FROM tracking_fact_changes) changes,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type = 'tracking.record-fact.v1') receipts,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    const factRecordId = randomUUID()
    const factRevisionId = randomUUID()
    const actionId = randomUUID()
    const commandId = randomUUID()
    const occurredAt = '2026-04-10T07:00:00.123Z'
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO tracking_fact_records
          (id, space_id, plan_month_id, publication_id,
           plan_goal_snapshot_id, local_date, fact_kind,
           fixed_expectation_id, flexible_period_id, contribution_id,
           current_revision_id, created_by_member_id, created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                '2026-04-11'::date, 'boolean', expectation.id,
                NULL, NULL, NULL, $6::uuid, $7::timestamptz, $7::timestamptz
           FROM fixed_expectations expectation
          WHERE expectation.publication_id = $4::uuid
            AND expectation.plan_goal_snapshot_id = $5::uuid
            AND expectation.expectation_date = '2026-04-11'::date
            AND expectation.component_kind = 'goal'
            AND expectation.component_id IS NULL`,
        [
          factRecordId,
          spaceId,
          fixture.planMonthId,
          fixture.publicationId,
          fixture.snapshots.vitamin,
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
        [fixture.planMonthId],
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
          fixture.planMonthId,
          fixture.publicationId,
          fixture.snapshots.vitamin,
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
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const after = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT count(*)::text FROM tracking_fact_changes) changes,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type = 'tracking.record-fact.v1') receipts,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${fixture.planMonthId}'::uuid) facts_revision
    `)
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('fails closed when upgrading legacy tracking receipts or unexplained facts revision', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t01_upgrade')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const upgradePool = new Pool({
      connectionString: upgrade.getConnectionUri(),
    })
    try {
      const beforeT01 = [
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
      ] as const
      for (const name of beforeT01) {
        await executeMigration(
          upgradePool,
          readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
        )
      }
      const t01 = readFileSync(
        'prisma/migrations/20260811160000_tracking_record_kernel/migration.sql',
        'utf8',
      )
      await upgradePool.query(`
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES ('member:${firstMemberId}', 'tracking.record-fact.v1',
                gen_random_uuid(), repeat('a', 64), 'planning.plan-draft.v1',
                gen_random_uuid(), 1, now())
      `)
      await expect(executeMigration(upgradePool, t01)).rejects.toMatchObject({
        code: '23514',
      })
      await upgradePool.query(`
        TRUNCATE TABLE command_receipts, planning_action_groups CASCADE;
        INSERT INTO spaces (id, singleton_key)
        VALUES ('${spaceId}'::uuid, 1);
      `)
      await upgradePool.query('ALTER TABLE plan_months DISABLE TRIGGER USER')
      await upgradePool.query(`
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, facts_revision,
           active_publication_id, created_at, updated_at)
        VALUES (gen_random_uuid(), '${spaceId}'::uuid, '2026-04-01'::date,
                'draft', 1, 1, NULL, now(), now());
      `)
      await upgradePool.query('ALTER TABLE plan_months ENABLE TRIGGER USER')
      await expect(executeMigration(upgradePool, t01)).rejects.toMatchObject({
        code: '23514',
      })
      const failedTables = await upgradePool.query<{ count: string }>(`
        SELECT count(*)::text count FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name LIKE 'tracking_%'
      `)
      expect(failedTables.rows).toEqual([{ count: '0' }])
      await upgradePool.query('ALTER TABLE plan_months DISABLE TRIGGER USER')
      await upgradePool.query('UPDATE plan_months SET facts_revision = 0')
      await upgradePool.query('ALTER TABLE plan_months ENABLE TRIGGER USER')
      await expect(executeMigration(upgradePool, t01)).resolves.toBeUndefined()
    } finally {
      await upgradePool.end()
      await upgrade.stop()
    }
  })
})
