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
  createReportingApplication,
  PilotReportSourceInvalidError,
  PilotReportSourceNotFoundError,
  type ReportingApplication,
} from '@/modules/reporting'
import {
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'

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
    Record<'complete' | 'partial' | 'over' | 'partner' | 'shared', string>
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

describe('R01 pilot report on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let reporting: ReportingApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_r01_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const config = runtimeConfig(postgres.getConnectionUri())
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, config)
    const members = new PrismaWorkspaceMemberResolver(provider)
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
    reporting = createReportingApplication({ database: provider, transaction })
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
      payload: { targetMonth: '2026-04', focus: 'R01 report fixture' },
    })
    const definitions: string[] = []
    for (const [title, scope, measurement] of [
      [
        'Complete',
        { kind: 'personal' as const, ownerMemberId: firstMemberId },
        {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'items',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: '100',
        },
      ],
      [
        'Partial',
        { kind: 'personal' as const, ownerMemberId: firstMemberId },
        {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'items',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: '100',
        },
      ],
      [
        'Over',
        { kind: 'personal' as const, ownerMemberId: firstMemberId },
        {
          kind: 'quantity' as const,
          mode: 'targeted' as const,
          unit: 'items',
          precision: 0 as const,
          aggregation: 'latest' as const,
          target: '100',
        },
      ],
      [
        'Partner',
        { kind: 'personal' as const, ownerMemberId: secondMemberId },
        { kind: 'boolean' as const },
      ],
      ['Shared', { kind: 'shared' as const }, { kind: 'boolean' as const }],
    ] as const) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: { title, why: `${title} reason`, category: 'R01' },
      })
      definitions.push(definition.aggregateId)
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(definitions.length),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: {
            schemaVersion: 1,
            scope,
            repetition: { kind: 'one_off', dueDate: '2026-04-10' },
            measurement,
            checkpoints: null,
          },
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
        complete: rows.rows[0]!.id,
        partial: rows.rows[1]!.id,
        over: rows.rows[2]!.id,
        partner: rows.rows[3]!.id,
        shared: rows.rows[4]!.id,
      },
    }
  }

  async function record(
    fixture: Fixture,
    snapshot: keyof Fixture['snapshots'],
    value:
      | { readonly kind: 'quantity'; readonly value: string }
      | { readonly kind: 'boolean'; readonly result: 'done' },
    memberId = firstMemberId,
  ): Promise<{ readonly aggregateId: string }> {
    return tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(memberId),
      payload: {
        publicationId: fixture.publicationId,
        planGoalSnapshotId: fixture.snapshots[snapshot],
        localDate: '2026-04-10',
        value,
      },
    })
  }

  it('builds exact personal/shared sections from current fact revisions', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await record(fixture, 'complete', { kind: 'quantity', value: '100' })
    const partial = await record(fixture, 'partial', {
      kind: 'quantity',
      value: '10',
    })
    await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        factRecordId: partial.aggregateId,
        value: { kind: 'quantity', value: '50' },
        reason: 'Уточнено для отчёта',
      },
    })
    await record(fixture, 'over', { kind: 'quantity', value: '130' })
    await record(
      fixture,
      'partner',
      { kind: 'boolean', result: 'done' },
      secondMemberId,
    )
    await record(fixture, 'shared', { kind: 'boolean', result: 'done' })

    const transactionMode = await transaction.run(
      () =>
        provider.withClient(
          (client) =>
            client.$queryRaw<
              {
                readonly isolationLevel: string
                readonly readOnly: string
              }[]
            >`
            SELECT current_setting('transaction_isolation') "isolationLevel",
                   current_setting('transaction_read_only') "readOnly"
          `,
        ),
      { mode: 'repeatable_read_only' },
    )
    expect(transactionMode).toEqual([
      { isolationLevel: 'repeatable read', readOnly: 'on' },
    ])

    const transactionWriteUserId = randomUUID()
    const report = await transaction.run(async () => {
      const value = await reporting.calculatePilotReport.execute({
        spaceId,
        publicationId: fixture.publicationId,
        asOfLocalDate: '2026-04-10',
      })
      await provider.withClient(async (client) => {
        await client.$executeRaw`
          INSERT INTO users (id) VALUES (${transactionWriteUserId}::uuid)
        `
      })
      return value
    })

    expect(report.source).toMatchObject({
      publicationId: fixture.publicationId,
      publicationRevision: 1n,
      factsRevision: 6n,
      formulaVersions: {
        calendar: 'planner.calendar-targets.v1',
        evaluation: 'planner.goal-evaluation.v1',
        scoreCoverage: 'planner.score-coverage.v1',
      },
    })
    expect(report.sections.map((section) => section.ownerMemberId)).toEqual([
      firstMemberId,
      secondMemberId,
      null,
    ])
    expect(
      report.sections[0].goals.map((goal) => goal.progressPercent.basisPoints),
    ).toEqual(['10000', '5000', '13000'])
    expect(report.sections[0].monthScore).toMatchObject({
      exact: { numerator: '5', denominator: '6' },
      basisPoints: '8333',
    })
    expect(report.sections[0].goals[2]).toMatchObject({
      goalScore: { basisPoints: '10000' },
      factTarget: {
        kind: 'fixed',
        units: [
          {
            fact: { kind: 'quantity_latest', value: '130' },
            target: {
              measurement: { kind: 'quantity', target: '100' },
              satisfaction: null,
            },
          },
        ],
      },
      overperformance: { basisPoints: '3000' },
    })
    expect(report.sections[1].monthScore).toMatchObject({
      basisPoints: '10000',
    })
    expect(report.sections[2].monthScore).toMatchObject({
      basisPoints: '10000',
    })
    const revisions = await pool.query<{ value: string }>(
      `SELECT quantity_value value FROM tracking_fact_revisions
        WHERE fact_record_id = $1::uuid ORDER BY revision_number`,
      [partial.aggregateId],
    )
    expect(revisions.rows).toEqual([{ value: '10' }, { value: '50' }])
    await expect(
      pool.query('SELECT id FROM users WHERE id = $1::uuid', [
        transactionWriteUserId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('rejects unsupported stored formula provenance', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await pool.query(`
      BEGIN;
      ALTER TABLE plan_publications DISABLE TRIGGER USER;
      UPDATE plan_publications
         SET score_formula_version = 'planner.score-coverage.future'
       WHERE id = '${fixture.publicationId}'::uuid;
      ALTER TABLE plan_publications ENABLE TRIGGER USER;
      COMMIT;
    `)
    await expect(
      reporting.calculatePilotReport.execute({
        spaceId,
        publicationId: fixture.publicationId,
        asOfLocalDate: '2026-04-10',
      }),
    ).rejects.toBeInstanceOf(PilotReportSourceInvalidError)
  })

  it('rejects a cancelled publication instead of mixing current month provenance', async () => {
    await resetPair()
    const fixture = await publishedFixture()
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
    await expect(
      reporting.calculatePilotReport.execute({
        spaceId,
        publicationId: fixture.publicationId,
        asOfLocalDate: '2026-04-10',
      }),
    ).rejects.toBeInstanceOf(PilotReportSourceNotFoundError)
  })

  it('maps malformed stored goal projection to a typed invalid-source error', async () => {
    await resetPair()
    const fixture = await publishedFixture()
    await pool.query(`
      BEGIN;
      ALTER TABLE plan_goal_snapshots DISABLE TRIGGER USER;
      UPDATE plan_goal_snapshots
         SET config = '{}'::jsonb
       WHERE publication_id = '${fixture.publicationId}'::uuid;
      ALTER TABLE plan_goal_snapshots ENABLE TRIGGER USER;
      COMMIT;
    `)
    await expect(
      reporting.calculatePilotReport.execute({
        spaceId,
        publicationId: fixture.publicationId,
        asOfLocalDate: '2026-04-10',
      }),
    ).rejects.toBeInstanceOf(PilotReportSourceInvalidError)
  })
})
