import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  type DraftGoalConfigV1,
} from '@/modules/planning'
import { createTrackingApplication } from '@/modules/tracking'
import {
  PrismaActionIntentRepository,
  TelegramActionIntentService,
} from '@/modules/telegram-bot'
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
    const firstRender = await service.offerTodayActions(member, today)
    const secondRender = await service.offerTodayActions(member, today)
    expect(secondRender).toEqual(firstRender)
    expect(firstRender.some((button) => button.text.includes('Routine'))).toBe(
      false,
    )

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
