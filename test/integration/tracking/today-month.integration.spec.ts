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
  GetMonthQuery,
  PrismaTrackingReadPersistence,
  TrackingDependencyUnavailableError,
  type TrackingApplication,
  type TrackingPublishedReadV1,
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

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member' as const, id: memberId }
}

function published(
  value: Awaited<ReturnType<TrackingApplication['getMonth']['execute']>>,
): TrackingPublishedReadV1 & {
  readonly schemaVersion: 'tracking.month.v1'
} {
  if (value.state !== 'published') throw new Error('published state expected')
  return value
}

describe('T07 Today and Month read models on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let aprilPublicationId: string
  let aprilPlanMonthId: string
  let waterId: string
  let sharedTextId: string
  let denisBooleanId: string
  let wakeTimeId: string
  let moodId: string
  let sugarFreeId: string
  let fitnessId: string
  let reelsId: string
  let outreachWeek2Id: string
  let moodCheckpointId: string
  let fitnessVariantId: string
  let reelsItemIds: readonly string[]

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t07_integration')
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
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2026-03-30T18:00:00.000Z'))
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

    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    aprilPlanMonthId = draft.aggregateId
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('April preview missing')
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
    aprilPublicationId = publication.aggregateId
    const snapshots = await pool.query<{
      readonly id: string
      readonly title: string
      readonly config: {
        readonly checkpoints?: {
          readonly items?: readonly { readonly checkpointId: string }[]
        }
        readonly measurement?: {
          readonly variants?: readonly { readonly variantId: string }[]
          readonly items?: readonly { readonly itemId: string }[]
        }
      }
    }>(
      `SELECT id::text, title, config FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
          AND title IN (
            'Вода 1200 мл', 'Важная задача дня',
            'Показатель 054', 'Показатель 103',
            'Показатель 086', 'День без сладкого',
            'Показатель 136',
            'Показатель 111', 'Outreach: неделя 2'
          )`,
      [aprilPublicationId],
    )
    const byTitle = new Map(snapshots.rows.map((row) => [row.title, row.id]))
    waterId = byTitle.get('Вода 1200 мл')!
    sharedTextId = byTitle.get('Важная задача дня')!
    denisBooleanId = byTitle.get('Показатель 054')!
    wakeTimeId = byTitle.get('Показатель 103')!
    moodId = byTitle.get('Показатель 086')!
    sugarFreeId = byTitle.get('День без сладкого')!
    fitnessId = byTitle.get('Показатель 136')!
    reelsId = byTitle.get('Показатель 111')!
    outreachWeek2Id = byTitle.get('Outreach: неделя 2')!
    const configByTitle = new Map(
      snapshots.rows.map((row) => [row.title, row.config]),
    )
    moodCheckpointId = configByTitle.get('Показатель 086')!
      .checkpoints!.items![0]!.checkpointId
    fitnessVariantId = configByTitle.get('Показатель 136')!
      .measurement!.variants![0]!.variantId
    reelsItemIds = configByTitle
      .get('Показатель 111')!
      .measurement!.items!.map((item) => item.itemId)
    if (
      waterId === undefined ||
      sharedTextId === undefined ||
      denisBooleanId === undefined ||
      wakeTimeId === undefined ||
      moodId === undefined ||
      sugarFreeId === undefined ||
      fitnessId === undefined ||
      reelsId === undefined ||
      outreachWeek2Id === undefined ||
      moodCheckpointId === undefined ||
      fitnessVariantId === undefined ||
      reelsItemIds.length !== 4
    ) {
      throw new Error('T07 seed targets missing')
    }
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('returns no-plan, draft, future and late-published states for arbitrary months', async () => {
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    await expect(
      tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-06',
      }),
    ).resolves.toMatchObject({
      schemaVersion: 'tracking.month.v1',
      state: 'no_plan',
      targetMonth: '2026-06',
    })

    const june = await planning.createDraftFromPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        sourcePublicationId: aprilPublicationId,
        targetMonth: '2026-06',
      },
    })
    await expect(
      tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-06',
      }),
    ).resolves.toMatchObject({
      state: 'draft',
      planMonthId: june.aggregateId,
      lifecycleRevision: 1n,
      draftRevision: 1n,
    })

    const may = await planning.createDraftFromPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        sourcePublicationId: aprilPublicationId,
        targetMonth: '2026-05',
      },
    })
    clock.set(new Date('2026-05-10T07:00:00.000Z'))
    const mayPreview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-05',
    })
    if (mayPreview === null) throw new Error('May preview missing')
    await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(mayPreview.draftRevision),
      payload: {
        planMonthId: may.aggregateId,
        previewSchemaVersion: mayPreview.schemaVersion,
        previewHashVersion: mayPreview.previewHashVersion,
        previewHash: mayPreview.previewHash,
      },
    })
    const lateMay = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-05',
      }),
    )
    expect(lateMay).toMatchObject({
      phase: 'active',
      activeLocalDate: '2026-05-10',
      latePublication: true,
    })
    expect(lateMay.days).toHaveLength(31)
    expect(lateMay.days[0]).toMatchObject({
      localDate: '2026-05-01',
      state: 'not_applicable',
      coverage: { filled: '0', applicable: '0' },
    })

    clock.set(new Date('2026-06-30T07:00:00.000Z'))
    const july = await planning.createDraftFromPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        sourcePublicationId: aprilPublicationId,
        targetMonth: '2026-07',
      },
    })
    const julyPreview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-07',
    })
    if (julyPreview === null) throw new Error('July preview missing')
    const julyPublication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(julyPreview.draftRevision),
      payload: {
        planMonthId: july.aggregateId,
        previewSchemaVersion: julyPreview.schemaVersion,
        previewHashVersion: julyPreview.previewHashVersion,
        previewHash: julyPreview.previewHash,
      },
    })
    const future = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-07',
      }),
    )
    expect(future.phase).toBe('future')
    expect(future.days[0]?.state).toBe('future')
    expect(
      future.days.every((day) => day.goals.every((goal) => !goal.writable)),
    ).toBe(true)
    await planning.cancelPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: july.aggregateId,
        publicationId: julyPublication.aggregateId,
      },
    })
    await expect(
      tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-07',
      }),
    ).resolves.toMatchObject({
      state: 'draft',
      planMonthId: july.aggregateId,
      lifecycleRevision: 3n,
    })
    const republishPreview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-07',
    })
    if (republishPreview === null) throw new Error('July republish missing')
    const republished = await planning.republishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(republishPreview.draftRevision),
      payload: {
        planMonthId: july.aggregateId,
        previewSchemaVersion: republishPreview.schemaVersion,
        previewHashVersion: republishPreview.previewHashVersion,
        previewHash: republishPreview.previewHash,
      },
    })
    expect(republished.aggregateId).not.toBe(julyPublication.aggregateId)
    await expect(
      tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-07',
      }),
    ).resolves.toMatchObject({
      state: 'published',
      publicationId: republished.aggregateId,
      publicationRevision: 2n,
      phase: 'future',
    })
  })

  it('projects ordered goals, access, typed facts, P05 progress and tombstones', async () => {
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const before = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(before.goals).toHaveLength(41)
    expect(before.days).toHaveLength(30)
    expect(before.goals.map((goal) => goal.displayOrder)).toEqual(
      Array.from({ length: 41 }, (_, index) => index),
    )
    expect(
      before.goals.find((goal) => goal.planGoalSnapshotId === waterId)
        ?.viewerAccess,
    ).toBe('personal_owner')
    expect(
      before.goals.find((goal) => goal.planGoalSnapshotId === denisBooleanId)
        ?.viewerAccess,
    ).toBe('partner_read_only')
    expect(
      before.goals.find((goal) => goal.planGoalSnapshotId === sharedTextId)
        ?.viewerAccess,
    ).toBe('shared')
    const beforeApril10 = before.days.find(
      (day) => day.localDate === '2026-04-10',
    )!
    expect(
      beforeApril10.goals.find(
        (goal) => goal.planGoalSnapshotId === sugarFreeId,
      ),
    ).toMatchObject({
      applicable: true,
      state: 'no_data',
      coverage: { filled: '0', applicable: '0' },
      flexiblePeriods: [
        {
          expectedProgress: 9,
          actualProgress: { numerator: '0', denominator: '1' },
          state: 'no_data',
        },
      ],
    })

    const water = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: waterId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value: '400' },
      },
    })
    await tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: sharedTextId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Согласовать дату поездки',
        result: 'done',
      },
    })
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(secondMemberId),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: denisBooleanId,
        localDate: '2026-04-10',
        value: { kind: 'boolean', result: 'not_done' },
      },
    })
    const value = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(value.factsRevision).toBe(3n)
    const april10 = value.days.find((day) => day.localDate === '2026-04-10')!
    const waterDay = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === waterId,
    )!
    expect(waterDay).toMatchObject({
      applicable: true,
      writable: true,
      state: 'filled',
      coverage: { filled: '1', applicable: '1' },
      progress: { coverage: { filled: '1', applicable: '10' } },
      fixedExpectations: [
        {
          state: 'partial',
          facts: [
            {
              factRecordId: water.aggregateId,
              revision: 1n,
              factKind: 'quantity_add',
              revisionKind: 'recorded',
              value: { kind: 'quantity', value: '400' },
            },
          ],
        },
      ],
    })
    const sharedDay = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === sharedTextId,
    )!
    expect(sharedDay.fixedExpectations[0]).toMatchObject({
      state: 'done',
      facts: [
        {
          recordedByMemberId: secondMemberId,
          value: {
            kind: 'text',
            text: 'Согласовать дату поездки',
            result: 'done',
          },
        },
      ],
    })
    const denisDay = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === denisBooleanId,
    )!
    expect(denisDay).toMatchObject({
      writable: false,
      fixedExpectations: [{ state: 'not_done' }],
    })

    const partner = published(
      await tracking.getMonth.execute({
        trustedActor: actor(secondMemberId),
        targetMonth: '2026-04',
      }),
    )
    expect(
      partner.goals.find((goal) => goal.planGoalSnapshotId === waterId)
        ?.viewerAccess,
    ).toBe('partner_read_only')
    expect(
      partner.goals.find((goal) => goal.planGoalSnapshotId === denisBooleanId)
        ?.viewerAccess,
    ).toBe('personal_owner')

    await tracking.deleteRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: water.aggregateRevision,
      payload: { factRecordId: water.aggregateId, reason: 'Ошибка ввода воды' },
    })
    const tombstoned = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    const tombstone = tombstoned.days
      .find((day) => day.localDate === '2026-04-10')!
      .goals.find((goal) => goal.planGoalSnapshotId === waterId)!
      .fixedExpectations[0]!
    expect(tombstone).toMatchObject({
      state: 'no_data',
      facts: [
        {
          factRecordId: water.aggregateId,
          revision: 2n,
          revisionKind: 'tombstoned',
          value: null,
        },
      ],
    })
  })

  it('projects current typed revisions, flexible state and expected pace', async () => {
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const wake = await tracking.recordTime.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: wakeTimeId,
        expectationDate: '2026-04-10',
        value: '08:30',
      },
    })
    const correctedWake = await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: wake.aggregateRevision,
      payload: {
        factRecordId: wake.aggregateId,
        value: { kind: 'actual_time', value: '09:00' },
        reason: 'Уточнено время пробуждения',
      },
    })
    await tracking.undoLastOwnAction.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: correctedWake.aggregateRevision,
      payload: { factRecordId: wake.aggregateId },
    })
    await tracking.recordCheckpoint.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: moodId,
        expectationDate: '2026-04-10',
        checkpointId: moodCheckpointId,
        value: { kind: 'rating', value: 8 },
      },
    })
    await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: sugarFreeId,
        localDate: '2026-04-10',
        value: { kind: 'boolean', result: 'done' },
      },
    })
    await tracking.recordCompositeOccurrence.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: fitnessId,
        localDate: '2026-04-10',
        component: {
          kind: 'or_variant',
          variantId: fitnessVariantId,
          value: '1',
        },
      },
    })
    for (const [checklistItemId, state] of [
      [reelsItemIds[0]!, 'done'],
      [reelsItemIds[1]!, 'not_done'],
    ] as const) {
      await tracking.recordCompositeOccurrence.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          publicationId: aprilPublicationId,
          planGoalSnapshotId: reelsId,
          localDate: '2026-04-10',
          component: { kind: 'checklist_item', checklistItemId, state },
        },
      })
    }

    const value = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    const april10 = value.days.find((day) => day.localDate === '2026-04-10')!
    const wakeDay = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === wakeTimeId,
    )!
    expect(wakeDay.fixedExpectations[0]).toMatchObject({
      state: 'done',
      facts: [
        {
          factRecordId: wake.aggregateId,
          revision: 3n,
          revisionKind: 'recorded',
          value: { kind: 'actual_time', value: '08:30' },
        },
      ],
    })
    expect(
      april10.goals.find((goal) => goal.planGoalSnapshotId === moodId)
        ?.fixedExpectations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: moodCheckpointId,
          facts: [
            expect.objectContaining({
              factKind: 'rating',
              value: { kind: 'rating', value: 8 },
            }),
          ],
        }),
      ]),
    )

    const sugar = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === sugarFreeId,
    )!
    expect(sugar).toMatchObject({
      applicable: true,
      state: 'filled',
      coverage: { filled: '0', applicable: '0' },
      flexiblePeriods: [
        {
          expectedProgress: 9,
          actualProgress: { numerator: '1', denominator: '1' },
          state: 'done',
        },
      ],
    })
    const fitness = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === fitnessId,
    )!
    expect(fitness).toMatchObject({
      applicable: true,
      state: 'filled',
      flexiblePeriods: [
        {
          expectedProgress: 1,
          actualProgress: { numerator: '1', denominator: '1' },
          state: 'done',
          facts: [expect.objectContaining({ factKind: 'or_variant' })],
        },
      ],
    })
    const reels = april10.goals.find(
      (goal) => goal.planGoalSnapshotId === reelsId,
    )!
    expect(reels).toMatchObject({
      applicable: true,
      state: 'partial',
      flexiblePeriods: [
        {
          expectedProgress: 1,
          actualProgress: { numerator: '1', denominator: '4' },
          state: 'partial',
          facts: [
            expect.objectContaining({ factKind: 'checklist_item' }),
            expect.objectContaining({ factKind: 'checklist_item' }),
          ],
        },
      ],
    })
    expect(
      april10.goals.find((goal) => goal.planGoalSnapshotId === outreachWeek2Id),
    ).toMatchObject({
      applicable: true,
      writable: false,
      state: 'no_data',
      coverage: { filled: '0', applicable: '0' },
      flexiblePeriods: [
        {
          periodKind: 'weekly_planned_task',
          expectedProgress: null,
          actualProgress: null,
          state: 'no_data',
        },
      ],
    })
    expect(april10.state).toBe('partial')
  })

  it('keeps factsRevision and fact rows from one repeatable read snapshot', async () => {
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    let release!: () => void
    let reached!: () => void
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let paused = false
    const persistence = new PrismaTrackingReadPersistence(
      provider,
      async (phase) => {
        if (phase === 'header' && !paused) {
          paused = true
          reached()
          await gate
        }
      },
    )
    const query = new GetMonthQuery(members, persistence, transaction, clock)
    const read = query.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    await waiting
    const beforeWrite = await pool.query<{ readonly facts_revision: string }>(
      'SELECT facts_revision::text FROM plan_months WHERE id = $1::uuid',
      [aprilPlanMonthId],
    )
    const added = await tracking.recordFact.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        publicationId: aprilPublicationId,
        planGoalSnapshotId: waterId,
        localDate: '2026-04-10',
        value: { kind: 'quantity', value: '800' },
      },
    })
    release()
    const snapshot = published(await read)
    expect(snapshot.factsRevision.toString(10)).toBe(
      beforeWrite.rows[0]!.facts_revision,
    )
    expect(
      JSON.stringify(snapshot, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString(10) : value,
      ),
    ).not.toContain(added.aggregateId)
    const current = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(current.factsRevision).toBe(snapshot.factsRevision + 1n)
    expect(
      JSON.stringify(current, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString(10) : value,
      ),
    ).toContain(added.aggregateId)
  })

  it('accepts exactly 10,000 materialized rows and rejects 10,001 without truncation', async () => {
    clock.set(new Date('2026-04-10T07:00:00.000Z'))
    const baseline = await pool.query<{
      readonly materialized: string
      readonly receipts: string
      readonly actions: string
    }>(
      `SELECT
         ((SELECT count(*) FROM fixed_expectations
            WHERE publication_id = $1::uuid) +
          (SELECT count(*) FROM flexible_periods
            WHERE publication_id = $1::uuid))::text materialized,
         (SELECT count(*)::text FROM command_receipts) receipts,
         (SELECT count(*)::text FROM tracking_action_groups) actions`,
      [aprilPublicationId],
    )
    const extra = 10_000 - Number(baseline.rows[0]!.materialized)
    expect(extra).toBeGreaterThan(0)
    const insert = (count: number): Promise<unknown> =>
      pool.query(
        `INSERT INTO fixed_expectations
          (id, publication_id, plan_goal_snapshot_id, expectation_date,
           component_kind, component_id)
         SELECT md5('t07-bound-row-' || value::text)::uuid,
                $1::uuid, $2::uuid, '2026-04-10'::date, 'checkpoint',
                md5('t07-bound-component-' || value::text)::uuid
           FROM generate_series(1, $3::int) value
         ON CONFLICT (id) DO NOTHING`,
        [aprilPublicationId, waterId, count],
      )
    try {
      await pool.query('ALTER TABLE fixed_expectations DISABLE TRIGGER USER')
      await insert(extra)
      await pool.query('ALTER TABLE fixed_expectations ENABLE TRIGGER USER')
      await expect(
        tracking.getMonth.execute({
          trustedActor: actor(),
          targetMonth: '2026-04',
        }),
      ).resolves.toMatchObject({ state: 'published' })

      await pool.query('ALTER TABLE fixed_expectations DISABLE TRIGGER USER')
      await insert(extra + 1)
      await pool.query('ALTER TABLE fixed_expectations ENABLE TRIGGER USER')
      await expect(
        tracking.getMonth.execute({
          trustedActor: actor(),
          targetMonth: '2026-04',
        }),
      ).rejects.toBeInstanceOf(TrackingDependencyUnavailableError)
    } finally {
      await pool
        .query('ALTER TABLE fixed_expectations DISABLE TRIGGER USER')
        .catch(() => undefined)
      await pool
        .query(
          `DELETE FROM fixed_expectations
            WHERE id IN (
              SELECT md5('t07-bound-row-' || value::text)::uuid
                FROM generate_series(1, $1::int) value
            )`,
          [extra + 1],
        )
        .catch(() => undefined)
      await pool
        .query('ALTER TABLE fixed_expectations ENABLE TRIGGER USER')
        .catch(() => undefined)
    }
    const after = await pool.query<{
      readonly receipts: string
      readonly actions: string
    }>(`
      SELECT (SELECT count(*)::text FROM command_receipts) receipts,
             (SELECT count(*)::text FROM tracking_action_groups) actions
    `)
    expect(after.rows[0]).toEqual({
      receipts: baseline.rows[0]!.receipts,
      actions: baseline.rows[0]!.actions,
    })
  })

  it('reads grace and closed as authoritative read-only phases without writes', async () => {
    const before = await pool.query<{
      readonly receipts: string
      readonly actions: string
    }>(`
      SELECT (SELECT count(*)::text FROM command_receipts) receipts,
             (SELECT count(*)::text FROM tracking_action_groups) actions
    `)
    clock.set(new Date('2026-05-02T07:00:00.000Z'))
    const delayedWorkerGrace = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(delayedWorkerGrace).toMatchObject({
      monthStatus: 'published',
      phase: 'grace',
    })
    expect(
      delayedWorkerGrace.days.some((day) =>
        day.goals.some((goal) => goal.writable),
      ),
    ).toBe(true)
    clock.set(new Date('2026-05-04T07:00:00.000Z'))
    const delayedWorkerExpired = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(delayedWorkerExpired).toMatchObject({
      monthStatus: 'published',
      phase: 'grace',
    })
    expect(
      delayedWorkerExpired.days.every((day) =>
        day.goals.every((goal) => !goal.writable),
      ),
    ).toBe(true)
    await pool.query(`
      ALTER TABLE plan_months DISABLE TRIGGER USER;
      UPDATE plan_months SET status = 'grace'
       WHERE id = '${aprilPlanMonthId}'::uuid;
      ALTER TABLE plan_months ENABLE TRIGGER USER;
    `)
    clock.set(new Date('2026-05-02T07:00:00.000Z'))
    const grace = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(grace.phase).toBe('grace')
    expect(
      grace.days.some((day) => day.goals.some((goal) => goal.writable)),
    ).toBe(true)
    await pool.query(`
      ALTER TABLE plan_months DISABLE TRIGGER USER;
      UPDATE plan_months SET status = 'closed'
       WHERE id = '${aprilPlanMonthId}'::uuid;
      ALTER TABLE plan_months ENABLE TRIGGER USER;
    `)
    const closed = published(
      await tracking.getMonth.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      }),
    )
    expect(closed.phase).toBe('closed')
    expect(
      closed.days.every((day) => day.goals.every((goal) => !goal.writable)),
    ).toBe(true)
    const after = await pool.query<{
      readonly receipts: string
      readonly actions: string
    }>(`
      SELECT (SELECT count(*)::text FROM command_receipts) receipts,
             (SELECT count(*)::text FROM tracking_action_groups) actions
    `)
    expect(after.rows[0]).toEqual(before.rows[0])
  })
})
