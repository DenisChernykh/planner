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

describe('T08 CloseDay through real application composition', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t08_e2e')
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

  it('materializes a verified preview through real composition without an HTTP write endpoint', async () => {
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
    const publicationPreview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (publicationPreview === null) throw new Error('preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor,
      expectedRevision: BigInt(publicationPreview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: publicationPreview.schemaVersion,
        previewHashVersion: publicationPreview.previewHashVersion,
        previewHash: publicationPreview.previewHash,
      },
    })
    clock.set(new Date('2026-04-10T07:00:00.000Z'))

    const preview = await tracking.previewCloseDay.execute({
      trustedActor,
      publicationId: publication.aggregateId,
      localDate: '2026-04-08',
    })
    if (preview.state !== 'ready') throw new Error('ready preview expected')
    const beforeCancel = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text count FROM tracking_fact_records`,
    )
    expect(beforeCancel.rows[0]!.count).toBe('0')

    const close = await tracking.closeDay.execute({
      commandId: randomUUID(),
      trustedActor,
      expectedRevision: preview.factsRevision,
      payload: {
        publicationId: publication.aggregateId,
        localDate: '2026-04-08',
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const month = await tracking.getMonth.execute({
      trustedActor,
      targetMonth: '2026-04',
    })
    if (month.state !== 'published') throw new Error('published month expected')
    const day = month.days.find((item) => item.localDate === '2026-04-08')!
    expect(day.closure).toMatchObject({
      state: 'closed',
      dayCloseId: close.aggregateId,
      revision: close.aggregateRevision,
      closedCount: preview.unresolved.length,
    })
    expect(
      day.goals
        .flatMap((goal) => goal.fixedExpectations)
        .some((expectation) => expectation.state === 'not_done'),
    ).toBe(true)
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })
})
