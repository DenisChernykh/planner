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
import type { DatabaseRuntimeConfig } from '@/platform/config/runtime-config.types'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { DurableCommandResultRef } from '@/shared/application/application-command'

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

function config(url: string): { readonly database: DatabaseRuntimeConfig } {
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

describe('T01 real application composition records seed facts', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_t01_e2e')
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

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('publishes the April seed and stores add/latest authoritative state', async () => {
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
    const clock = new FakeProductClock(new Date('2026-03-30T18:00:00.123Z'))
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
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createDraftFromSeed.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2026-04', actorPersona: 'memberB' },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('seed preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshots = await pool.query<{ id: string; title: string }>(
      `SELECT id::text, title FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid
          AND title IN ('Вода 1200 мл', '7000 шагов')
        ORDER BY title`,
      [publication.aggregateId],
    )
    const byTitle = new Map(snapshots.rows.map((row) => [row.title, row.id]))
    const waterId = byTitle.get('Вода 1200 мл')
    const stepsId = byTitle.get('7000 шагов')
    if (waterId === undefined || stepsId === undefined) {
      throw new Error('seed fact targets missing')
    }
    clock.set(new Date('2026-04-10T07:00:00.123Z'))
    const record = async (
      snapshotId: string,
      value: string,
    ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> =>
      tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          publicationId: publication.aggregateId,
          planGoalSnapshotId: snapshotId,
          localDate: '2026-04-10',
          value: { kind: 'quantity', value },
        },
      })
    await record(waterId, '400')
    await record(waterId, '800')
    const firstSteps = await record(stepsId, '2000')
    await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: firstSteps.aggregateRevision,
      payload: {
        factRecordId: firstSteps.aggregateId,
        value: { kind: 'quantity', value: '7000' },
        reason: 'Уточнено итоговое значение шагов.',
      },
    })

    const [water, steps] = await Promise.all([
      tracking.getFactState.execute({
        trustedActor: { kind: 'member', id: secondMemberId },
        publicationId: publication.aggregateId,
        planGoalSnapshotId: waterId,
        localDate: '2026-04-10',
      }),
      tracking.getFactState.execute({
        trustedActor: actor,
        publicationId: publication.aggregateId,
        planGoalSnapshotId: stepsId,
        localDate: '2026-04-10',
      }),
    ])
    expect(water).toMatchObject({
      factsRevision: 4n,
      fact: {
        kind: 'quantity_add',
        contributions: [{ value: '400' }, { value: '800' }],
      },
    })
    expect(steps).toMatchObject({
      factsRevision: 4n,
      fact: { kind: 'quantity_latest', revision: 2n, value: '7000' },
    })
    const audit = await pool.query<Record<string, string>>(`
      SELECT (SELECT count(*)::text FROM plan_goal_snapshots
               WHERE publication_id = '${publication.aggregateId}'::uuid) snapshots,
             (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM tracking_fact_revisions) revisions,
             (SELECT count(*)::text FROM tracking_action_groups) actions,
             (SELECT facts_revision::text FROM plan_months
               WHERE id = '${draft.aggregateId}'::uuid) facts_revision
    `)
    expect(audit.rows[0]).toEqual({
      snapshots: '41',
      records: '3',
      revisions: '4',
      actions: '4',
      facts_revision: '4',
    })
  })
})
