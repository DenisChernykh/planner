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
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
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

function actor(selectedMemberId = memberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: selectedMemberId }
}

describe('P09 application E2E copies a published month without facts', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let application: PlanningApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p09_e2e')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 6,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 15_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    application = createPlanningApplication({
      database: provider,
      transaction: new PrismaTransactionAdapter(provider, context, config),
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: new FakeProductClock(new Date('2035-03-30T18:00:00.000Z')),
    })
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('publishes April, edits copied May and preserves the April snapshot', async () => {
    const april = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2035-04', focus: 'April source focus' },
    })
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        title: 'Weekly outreach',
        why: 'Carry the task to May without results',
        category: 'Outreach',
      },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: april.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: secondMemberId },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '1',
            taskText: 'April outreach text',
          },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'April.docx',
          sourcePage: 6,
          rawValue: 'outreach row',
          rawDenominator: null,
          resolution: 'approved source',
        },
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: userId,
      targetMonth: '2035-04',
    })
    if (preview === null) throw new Error('April preview missing')
    const publication = await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: april.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const aprilBefore = await application.getPublishedSnapshot.execute({
      trustedUserId: userId,
      publicationId: publication.aggregateId,
    })
    if (aprilBefore === null) throw new Error('April snapshot missing')

    const may = await application.createDraftFromPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      payload: {
        sourcePublicationId: publication.aggregateId,
        targetMonth: '2035-05',
      },
    })
    let mayEditor = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2035-05',
    })
    if (mayEditor === null) throw new Error('May editor missing')
    expect(mayEditor).toMatchObject({
      planMonthId: may.aggregateId,
      focus: 'April source focus',
      draftRevision: 1n,
    })
    expect(mayEditor.goals).toHaveLength(1)
    expect(mayEditor.goals[0]?.configRevision).toBe(1n)
    expect(mayEditor.goals[0]?.config.repetition).toEqual({
      kind: 'weekly_planned_task',
      weekOrdinal: '1',
      taskText: 'April outreach text',
    })
    await application.updateMonthFocus.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: { planMonthId: may.aggregateId, focus: 'May edited focus' },
    })
    const copiedGoal = mayEditor.goals[0]!
    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: may.aggregateId,
        planGoalId: copiedGoal.planGoalId,
        goalDefinitionVersionId: copiedGoal.goalDefinitionVersionId,
        config: {
          ...copiedGoal.config,
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '1',
            taskText: 'May changed outreach text',
          },
        },
        sourceProvenance: copiedGoal.sourceProvenance,
      },
    })
    mayEditor = await application.getDraftEditor.execute({
      trustedActor: actor(secondMemberId),
      targetMonth: '2035-05',
    })
    if (mayEditor === null) throw new Error('edited May editor missing')
    expect(mayEditor).toMatchObject({
      focus: 'May edited focus',
      draftRevision: 3n,
    })
    expect(mayEditor.goals).toHaveLength(1)
    expect(mayEditor.goals[0]?.configRevision).toBe(2n)
    expect(mayEditor.goals[0]?.config.repetition).toEqual({
      kind: 'weekly_planned_task',
      weekOrdinal: '1',
      taskText: 'May changed outreach text',
    })
    await expect(
      application.getPublishedSnapshot.execute({
        trustedUserId: secondUserId,
        publicationId: publication.aggregateId,
      }),
    ).resolves.toEqual(aprilBefore)
    const destinationDerived = await pool.query<{
      readonly publications: string
      readonly snapshots: string
      readonly expectations: string
      readonly periods: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM plan_publications
           WHERE plan_month_id = $1::uuid) publications,
         (SELECT count(*)::text FROM plan_goal_snapshots
           WHERE plan_month_id = $1::uuid) snapshots,
         (SELECT count(*)::text FROM fixed_expectations expectation
           JOIN plan_goal_snapshots snapshot
             ON snapshot.id = expectation.plan_goal_snapshot_id
          WHERE snapshot.plan_month_id = $1::uuid) expectations,
         (SELECT count(*)::text FROM flexible_periods period
           JOIN plan_goal_snapshots snapshot
             ON snapshot.id = period.plan_goal_snapshot_id
          WHERE snapshot.plan_month_id = $1::uuid) periods`,
      [may.aggregateId],
    )
    expect(destinationDerived.rows[0]).toEqual({
      publications: '0',
      snapshots: '0',
      expectations: '0',
      periods: '0',
    })
  })
})
