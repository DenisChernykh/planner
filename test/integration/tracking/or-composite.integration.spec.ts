import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

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
  PrismaFactPersistence,
  RecordCompositeOccurrenceCommand,
  TrackingDependencyUnavailableError,
  type FactWritePhase,
  type GoalProgressStateV1,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
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
    Record<
      | 'fixedOr'
      | 'checkpointOr'
      | 'flexibleOr'
      | 'flexibleChecklist'
      | 'informationalFixed'
      | 'informationalFlexible',
      string
    >
  >
  readonly fixedVariants: readonly string[]
  readonly checkpointVariants: readonly string[]
  readonly flexibleVariants: readonly string[]
  readonly checklistItems: readonly string[]
  readonly checkpointId: string
}

type PublishedConfig = {
  readonly measurement: {
    readonly variants?: readonly { readonly variantId: string }[]
    readonly items?: readonly { readonly itemId: string }[]
  }
  readonly checkpoints: {
    readonly items: readonly { readonly checkpointId: string }[]
  } | null
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

function runtimeConfig(url: string): {
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

describe('T04 OR, informational and flexible composite facts', () => {
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
      .withDatabase('planner_t04_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const context = new PrismaTransactionContext()
    const config = runtimeConfig(postgres.getConnectionUri())
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, config)
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
      payload: { targetMonth: '2026-04', focus: 'T04 facts' },
    })
    const titles = [
      'Fixed OR',
      'Checkpoint OR',
      'Flexible OR',
      'Flexible checklist',
      'Informational fixed',
      'Informational flexible',
    ]
    const definitions = await Promise.all(
      titles.map((title) =>
        planning.createGoalDefinition.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: { title, why: `${title} tracking`, category: 'T04' },
        }),
      ),
    )
    const variants = (
      targets: readonly (readonly [string, string])[],
    ): readonly {
      readonly variantId: null
      readonly label: string
      readonly unit: string
      readonly precision: 0
      readonly target: string
    }[] =>
      targets.map(([label, target]) => ({
        variantId: null,
        label,
        unit: 'раз',
        precision: 0 as const,
        target,
      }))
    const configs = [
      {
        schemaVersion: 1 as const,
        scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'any_of' as const,
          variants: variants([
            ['pages', '100'],
            ['audio', '60'],
          ]),
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'any_of' as const,
          variants: variants([
            ['first', '10'],
            ['second', '20'],
          ]),
        },
        checkpoints: {
          aggregation: 'independent' as const,
          items: [
            {
              checkpointId: null,
              name: 'OR checkpoint',
              deadline: '22:00',
              satisfaction: { kind: 'any_of' as const },
            },
          ],
        },
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'weekly' as const, n: '2' },
        measurement: {
          kind: 'any_of' as const,
          variants: variants([
            ['home', '2'],
            ['studio', '1'],
          ]),
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'weekly' as const, n: '2' },
        measurement: {
          kind: 'checklist' as const,
          items: ['one', 'two'].map((label) => ({ itemId: null, label })),
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'quantity' as const,
          mode: 'informational' as const,
          unit: 'мл',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: null,
        },
        checkpoints: null,
      },
      {
        schemaVersion: 1 as const,
        scope: { kind: 'shared' as const },
        repetition: { kind: 'weekly' as const, n: '2' },
        measurement: {
          kind: 'quantity' as const,
          mode: 'informational' as const,
          unit: 'км',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: null,
        },
        checkpoints: null,
      },
    ] as const
    for (let index = 0; index < configs.length; index += 1) {
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
    if (preview === null) throw new Error('T04 preview missing')
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
      readonly config: PublishedConfig
    }>(
      `SELECT id::text, config FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid ORDER BY display_order`,
      [publication.aggregateId],
    )
    clock.set(new Date('2026-04-11T20:00:00.123Z'))
    return {
      planMonthId: draft.aggregateId,
      publicationId: publication.aggregateId,
      snapshots: {
        fixedOr: rows.rows[0]!.id,
        checkpointOr: rows.rows[1]!.id,
        flexibleOr: rows.rows[2]!.id,
        flexibleChecklist: rows.rows[3]!.id,
        informationalFixed: rows.rows[4]!.id,
        informationalFlexible: rows.rows[5]!.id,
      },
      fixedVariants: rows.rows[0]!.config.measurement.variants!.map(
        (item: { variantId: string }) => item.variantId,
      ),
      checkpointVariants: rows.rows[1]!.config.measurement.variants!.map(
        (item: { variantId: string }) => item.variantId,
      ),
      flexibleVariants: rows.rows[2]!.config.measurement.variants!.map(
        (item: { variantId: string }) => item.variantId,
      ),
      checklistItems: rows.rows[3]!.config.measurement.items!.map(
        (item: { itemId: string }) => item.itemId,
      ),
      checkpointId: rows.rows[1]!.config.checkpoints!.items[0]!.checkpointId,
    }
  }

  function progress(
    fixture: Fixture,
    snapshot: keyof Fixture['snapshots'],
    asOfLocalDate = '2026-04-11',
  ): Promise<GoalProgressStateV1 | null> {
    return tracking.getGoalProgress.execute({
      trustedActor: actor(secondMemberId),
      publicationId: fixture.publicationId,
      planGoalSnapshotId: fixture.snapshots[snapshot],
      asOfLocalDate,
    })
  }

  it('stores partial OR variants independently and projects max, not sum', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const first = await tracking.recordOrVariant.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.fixedOr,
        expectationDate: '2026-04-10',
        checkpointId: null,
        variantId: fixture.fixedVariants[0]!,
        value: '50',
      },
    })
    await tracking.recordOrVariant.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.fixedOr,
        expectationDate: '2026-04-10',
        checkpointId: null,
        variantId: fixture.fixedVariants[1]!,
        value: '40',
      },
    })
    await expect(
      progress(fixture, 'fixedOr', '2026-04-10'),
    ).resolves.toMatchObject({
      progress: { basisPoints: '6667' },
      coverage: { filled: '1', applicable: '1' },
    })
    await tracking.recordOrVariant.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: first.aggregateRevision,
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.fixedOr,
        expectationDate: '2026-04-10',
        checkpointId: null,
        variantId: fixture.fixedVariants[0]!,
        value: '100',
      },
    })
    await expect(
      progress(fixture, 'fixedOr', '2026-04-10'),
    ).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
    })
    const rows = await pool.query<Record<string, string>>(
      `SELECT count(DISTINCT record.id)::text records,
              count(DISTINCT or_variant_id)::text variants,
              max(revision_number)::text maximum_revision
         FROM tracking_fact_records record
         JOIN tracking_fact_revisions revision
           ON revision.fact_record_id = record.id
        WHERE record.plan_goal_snapshot_id = $1::uuid`,
      [fixture.snapshots.fixedOr],
    )
    expect(rows.rows[0]).toEqual({
      records: '2',
      variants: '2',
      maximum_revision: '2',
    })
  })

  it('projects checkpoint OR and per-date flexible composite occurrences', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await tracking.recordOrVariant.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.checkpointOr,
        expectationDate: '2026-04-10',
        checkpointId: fixture.checkpointId,
        variantId: fixture.checkpointVariants[0]!,
        value: '10',
      },
    })
    await expect(
      progress(fixture, 'checkpointOr', '2026-04-10'),
    ).resolves.toMatchObject({
      progress: { basisPoints: '10000' },
      coverage: { filled: '1', applicable: '1' },
    })

    for (const [localDate, variantId, value] of [
      ['2026-04-10', fixture.flexibleVariants[0]!, '1'],
      ['2026-04-10', fixture.flexibleVariants[1]!, '0'],
      ['2026-04-11', fixture.flexibleVariants[1]!, '1'],
    ] as const) {
      await tracking.recordCompositeOccurrence.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.flexibleOr,
          localDate,
          component: { kind: 'or_variant', variantId, value },
        },
      })
    }
    await expect(progress(fixture, 'flexibleOr')).resolves.toMatchObject({
      progress: { basisPoints: '15000' },
      coverage: { filled: '0', applicable: '0' },
      periods: [
        {
          actualEquivalentOccurrences: { numerator: '3', denominator: '2' },
        },
      ],
    })

    for (const [localDate, itemId, state] of [
      ['2026-04-10', fixture.checklistItems[0]!, 'done'],
      ['2026-04-10', fixture.checklistItems[1]!, 'not_done'],
      ['2026-04-11', fixture.checklistItems[0]!, 'done'],
      ['2026-04-11', fixture.checklistItems[1]!, 'done'],
    ] as const) {
      await tracking.recordCompositeOccurrence.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots.flexibleChecklist,
          localDate,
          component: { kind: 'checklist_item', checklistItemId: itemId, state },
        },
      })
    }
    await expect(progress(fixture, 'flexibleChecklist')).resolves.toMatchObject(
      {
        progress: { basisPoints: '15000' },
        coverage: { filled: '0', applicable: '0' },
      },
    )
  })

  it('keeps informational quantity scoreless with fixed-only coverage', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    for (const snapshot of [
      'informationalFixed',
      'informationalFlexible',
    ] as const) {
      await tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        payload: {
          publicationId: fixture.publicationId,
          planGoalSnapshotId: fixture.snapshots[snapshot],
          localDate: '2026-04-10',
          value: { kind: 'quantity', value: '7' },
        },
      })
    }
    await expect(
      progress(fixture, 'informationalFixed', '2026-04-10'),
    ).resolves.toMatchObject({
      progress: { available: false, reason: 'informational' },
      score: { available: false, reason: 'informational' },
      coverage: { filled: '1', applicable: '1' },
    })
    await expect(
      progress(fixture, 'informationalFlexible'),
    ).resolves.toMatchObject({
      progress: { available: false, reason: 'informational' },
      score: { available: false, reason: 'informational' },
      coverage: { filled: '0', applicable: '0' },
    })
  })

  it('serializes concurrent writes to one component CAS identity', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const attempts = await Promise.allSettled(
      ['1', '2'].map((value) =>
        tracking.recordCompositeOccurrence.execute({
          commandId: randomUUID(),
          trustedActor: actor(secondMemberId),
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.flexibleOr,
            localDate: '2026-04-10',
            component: {
              kind: 'or_variant',
              variantId: fixture.flexibleVariants[0]!,
              value,
            },
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
    const count = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count FROM tracking_fact_records
        WHERE plan_goal_snapshot_id = $1::uuid`,
      [fixture.snapshots.flexibleOr],
    )
    expect(count.rows[0]?.count).toBe('1')
  })

  it('rolls back every composite write phase with its receipt', async () => {
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
      const command = new RecordCompositeOccurrenceCommand(
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
          payload: {
            publicationId: fixture.publicationId,
            planGoalSnapshotId: fixture.snapshots.flexibleOr,
            localDate: '2026-04-10',
            component: {
              kind: 'or_variant',
              variantId: fixture.flexibleVariants[0]!,
              value: '1',
            },
          },
        }),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
      const counts = await pool.query<Record<string, string>>(
        `SELECT (SELECT count(*)::text FROM tracking_fact_records) records,
                (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
                (SELECT count(*)::text FROM tracking_action_groups) actions,
                (SELECT count(*)::text FROM command_receipts
                  WHERE command_type =
                    'tracking.record-composite-occurrence.v1') receipts,
                (SELECT facts_revision::text FROM plan_months
                  WHERE id = $1::uuid) facts_revision`,
        [fixture.planMonthId],
      )
      expect(counts.rows[0]).toEqual({
        records: '0',
        revisions: '0',
        actions: '0',
        receipts: '0',
        facts_revision: '0',
      })
    }
  })

  it('enforces typed values, immutable identities and exact deferred effects', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    const result = await tracking.recordCompositeOccurrence.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots.flexibleOr,
        localDate: '2026-04-10',
        component: {
          kind: 'or_variant',
          variantId: fixture.flexibleVariants[0]!,
          value: '1',
        },
      },
    })
    await expect(
      pool.query(
        `UPDATE tracking_fact_records SET or_variant_id = $2::uuid
          WHERE id = $1::uuid`,
        [result.aggregateId, fixture.flexibleVariants[1]],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `INSERT INTO tracking_fact_revisions
          (id, fact_record_id, revision_number, revision_kind,
           boolean_result, quantity_value, actual_time_value, rating_value,
           text_value, text_result, checklist_item_state, or_variant_value,
           recorded_by_member_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 99, 'recorded', NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, $2::uuid, now())`,
        [result.aggregateId, secondMemberId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'tracking_fact_revisions_value_check',
    })
    const shape = await pool.query<{ readonly valid: boolean }>(
      `SELECT t01_action_has_exact_shape(action.id) valid
         FROM tracking_action_groups action
         JOIN tracking_fact_changes change ON change.action_id = action.id
        WHERE change.fact_record_id = $1::uuid`,
      [result.aggregateId],
    )
    expect(shape.rows).toEqual([{ valid: true }])
  })
})
