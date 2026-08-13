import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { createPlanningApplication } from '@/modules/planning'
import { createTrackingApplication } from '@/modules/tracking'
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

describe('T09 weekly result through real application composition', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t09_e2e')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
  })

  it('publishes the seed, records and corrects one week-level result without daily rows', async () => {
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
    const transaction = new PrismaTransactionAdapter(
      provider,
      context,
      runtimeConfig,
    )
    const members = new PrismaWorkspaceMemberResolver(provider)
    const clock = new FakeProductClock(new Date('2026-03-30T07:00:00.000Z'))
    const planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const trustedActor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor,
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('publication preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor,
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const period = await pool.query<{
      readonly snapshot_id: string
      readonly period_id: string
    }>(
      `SELECT snapshot.id::text snapshot_id, period.id::text period_id
         FROM flexible_periods period
         JOIN plan_goal_snapshots snapshot
           ON snapshot.id = period.plan_goal_snapshot_id
        WHERE period.publication_id = $1::uuid
          AND period.period_kind = 'weekly_planned_task'
          AND snapshot.title = 'Outreach: неделя 3'`,
      [publication.aggregateId],
    )
    clock.set(new Date('2026-04-15T07:00:00.000Z'))
    const result = await tracking.recordWeeklyTaskResult.execute({
      commandId: randomUUID(),
      trustedActor,
      payload: {
        publicationId: publication.aggregateId,
        flexiblePeriodId: period.rows[0]!.period_id,
        result: 'done',
      },
    })

    const today = await tracking.getToday.execute({ trustedActor })
    if (today.state !== 'published') throw new Error('published today expected')
    const todayGoal = today.day.goals.find(
      (goal) => goal.planGoalSnapshotId === period.rows[0]!.snapshot_id,
    )!
    expect(todayGoal).toMatchObject({
      state: 'filled',
      progress: { progress: { basisPoints: '10000' } },
      flexiblePeriods: [
        expect.objectContaining({
          flexiblePeriodId: period.rows[0]!.period_id,
          state: 'done',
          facts: [
            expect.objectContaining({
              factRecordId: result.aggregateId,
              factKind: 'weekly_task_result',
              recordedByMemberId: firstMemberId,
            }),
          ],
        }),
      ],
    })
    expect(todayGoal.fixedExpectations).toEqual([])

    const corrected = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor,
      expectedRevision: result.aggregateRevision,
      payload: {
        factRecordId: result.aggregateId,
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'Неделя завершилась без результата',
      },
    })
    const month = await tracking.getMonth.execute({
      trustedActor,
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published month expected')
    const current = month.days
      .find((day) => day.localDate === '2026-04-15')!
      .goals.find(
        (goal) => goal.planGoalSnapshotId === period.rows[0]!.snapshot_id,
      )!.flexiblePeriods[0]!
    expect(current).toMatchObject({
      state: 'not_done',
      facts: [
        expect.objectContaining({
          factRecordId: result.aggregateId,
          revision: corrected.aggregateRevision,
          value: { kind: 'boolean', result: 'not_done' },
        }),
      ],
    })
    const dailyRows = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count FROM tracking_fact_records
        WHERE plan_goal_snapshot_id = $1::uuid
          AND fixed_expectation_id IS NOT NULL`,
      [period.rows[0]!.snapshot_id],
    )
    expect(dailyRows.rows[0]!.count).toBe('0')
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })
})
