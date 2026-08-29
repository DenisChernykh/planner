import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  PlanMonthNotFoundError,
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
const planMonthId = '66666666-6666-4666-8666-666666666666'
const firstPublicationId = '77777777-7777-4777-8777-777777777777'
const secondPublicationId = '88888888-8888-4888-8888-888888888888'
const firstReportId = '99999999-9999-4999-8999-999999999999'
const secondReportId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

describe('F07 month lifecycle history in a consistent PostgreSQL snapshot', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let planning: PlanningApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_f07_month_history')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 8,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 20_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    const transaction = new PrismaTransactionAdapter(provider, context, config)
    planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock: new FakeProductClock(new Date('2026-08-20T12:00:00.000Z')),
    })
    await seedHistory()
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function seedHistory(): Promise<void> {
    const actions = [
      [
        'b0000000-0000-4000-8000-000000000002',
        'month_published',
        'member',
        'member',
        'planning.publish-month.v1',
        1,
        2,
        '2026-07-01 08:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000003',
        'month_publication_cancelled',
        'member',
        'member',
        'planning.cancel-publication.v1',
        2,
        3,
        '2026-07-01 09:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000004',
        'month_published',
        'member',
        'member',
        'planning.republish-month.v1',
        3,
        4,
        '2026-07-01 10:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000005',
        'month_grace_started',
        'system',
        'system',
        'planning.start-month-grace.v1',
        4,
        5,
        '2026-08-01 00:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000006',
        'month_closed',
        'system',
        'system',
        'planning.close-month.v1',
        5,
        6,
        '2026-08-04 00:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000007',
        'month_reopened',
        'member',
        'member',
        'planning.reopen-month.v1',
        6,
        7,
        '2026-08-05 08:00:00Z',
      ],
      [
        'b0000000-0000-4000-8000-000000000008',
        'month_reclosed',
        'member',
        'member',
        'planning.reclose-month.v1',
        7,
        8,
        '2026-08-06 08:00:00Z',
      ],
    ] as const
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // F07 reads an already-valid append-only timeline; lifecycle command and
      // trigger behavior is covered by the dedicated P08/L01-L03 suites.
      await client.query("SET LOCAL session_replication_role = 'replica'")
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      await client.query(`
        INSERT INTO users (id) VALUES ('${userId}'::uuid), ('${secondUserId}'::uuid);
        INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot) VALUES
          ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
          ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
        INSERT INTO plan_months
          (id, space_id, month_start, status, lifecycle_mode, revision,
           facts_revision, active_publication_id, created_at, updated_at)
        VALUES ('${planMonthId}'::uuid, '${spaceId}'::uuid, DATE '2026-07-01',
          'draft', 'ordinary', 1, 0, NULL, now(), now());
        INSERT INTO plan_drafts
          (plan_month_id, focus, revision, created_at, updated_at)
        VALUES ('${planMonthId}'::uuid, 'F07 lifecycle', 1, now(), now());
        INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
        VALUES
          ('${firstPublicationId}'::uuid, '${spaceId}'::uuid, '${planMonthId}'::uuid,
           1, 1, 1, 'First', 'immediate', DATE '2026-07-01', false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('a', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${memberId}'::uuid,
           TIMESTAMPTZ '2026-07-01 08:00:00Z'),
          ('${secondPublicationId}'::uuid, '${spaceId}'::uuid, '${planMonthId}'::uuid,
           2, 1, 3, 'Second', 'immediate', DATE '2026-07-01', false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('b', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${memberId}'::uuid,
           TIMESTAMPTZ '2026-07-01 10:00:00Z');
      `)
      for (const [
        id,
        kind,
        actorKind,
        scopeKind,
        commandType,
        before,
        after,
        at,
      ] of actions) {
        const commandId = randomUUID()
        const actorScope =
          scopeKind === 'member'
            ? `member:${memberId}`
            : 'system:planner-worker'
        const aggregateId =
          commandType === 'planning.publish-month.v1'
            ? firstPublicationId
            : commandType === 'planning.republish-month.v1'
              ? secondPublicationId
              : commandType === 'planning.close-month.v1'
                ? firstReportId
                : commandType === 'planning.reclose-month.v1'
                  ? secondReportId
                  : planMonthId
        const aggregateRevision =
          commandType === 'planning.publish-month.v1'
            ? 1
            : commandType === 'planning.republish-month.v1' ||
                commandType === 'planning.reclose-month.v1'
              ? 2
              : after
        const resultKind =
          commandType === 'planning.publish-month.v1' ||
          commandType === 'planning.republish-month.v1'
            ? 'planning.plan-publication.v1'
            : commandType === 'planning.close-month.v1' ||
                commandType === 'planning.reclose-month.v1'
              ? 'planning.report-revision.v1'
              : 'planning.plan-month.v1'
        await client.query(
          `INSERT INTO command_receipts
             (actor_scope, command_type, command_id, fingerprint, result_kind,
              aggregate_id, aggregate_revision, completed_at)
           VALUES ($1, $2, $3::uuid, repeat('0', 64), $4, $5::uuid, $6, $7::timestamptz)`,
          [
            actorScope,
            commandType,
            commandId,
            resultKind,
            aggregateId,
            aggregateRevision,
            at,
          ],
        )
        await client.query(
          `INSERT INTO planning_action_groups
             (id, action_kind, actor_kind, actor_scope, member_id,
              system_actor_id, plan_month_id, goal_definition_id,
              command_type, command_id, before_revision, after_revision,
              occurred_at)
           VALUES ($1::uuid, $2, $3::varchar, $4,
             CASE WHEN $3::text = 'member' THEN '${memberId}'::uuid ELSE NULL END,
             CASE WHEN $3::text = 'system' THEN 'planner-worker' ELSE NULL END,
             '${planMonthId}'::uuid, NULL, $5, $6::uuid, $7, $8, $9::timestamptz)`,
          [
            id,
            kind,
            actorKind,
            actorScope,
            commandType,
            commandId,
            before,
            after,
            at,
          ],
        )
      }
      await client.query(`
        INSERT INTO planning_publication_changes
          (action_id, publication_id, change_kind, confirmed_draft_revision,
           confirmed_preview_schema_version, confirmed_preview_hash_version,
           confirmed_preview_hash, before_active_publication_id,
           after_active_publication_id)
        VALUES
          ('${actions[0][0]}'::uuid, '${firstPublicationId}'::uuid, 'published', 1,
           'planner.publication-preview.v1', 'planner.publication-preview-hash.v1', repeat('a', 64), NULL, '${firstPublicationId}'::uuid),
          ('${actions[1][0]}'::uuid, '${firstPublicationId}'::uuid, 'cancelled', NULL,
           NULL, NULL, NULL, '${firstPublicationId}'::uuid, NULL),
          ('${actions[2][0]}'::uuid, '${secondPublicationId}'::uuid, 'published', 1,
           'planner.publication-preview.v1', 'planner.publication-preview-hash.v1', repeat('b', 64), NULL, '${secondPublicationId}'::uuid);
        INSERT INTO planning_month_reopen_changes (action_id, reason)
        VALUES ('${actions[5][0]}'::uuid, 'Сверили закрытый месяц.');
        INSERT INTO report_revisions
          (id, plan_month_id, publication_id, revision,
           publication_snapshot_hash, source_facts_revision, formula_version,
           payload, payload_checksum, status, created_at,
           created_by_system_actor_id, created_by_member_id)
        VALUES
          ('${firstReportId}'::uuid, '${planMonthId}'::uuid, '${secondPublicationId}'::uuid,
           1, repeat('b', 64), 0, 'planner.report.v1', '{}'::jsonb,
           repeat('c', 64), 'original', TIMESTAMPTZ '${actions[4][7]}',
           'planner-worker', NULL),
          ('${secondReportId}'::uuid, '${planMonthId}'::uuid, '${secondPublicationId}'::uuid,
           2, repeat('b', 64), 0, 'planner.report.v1', '{}'::jsonb,
           repeat('d', 64), 'revised', TIMESTAMPTZ '${actions[6][7]}',
           NULL, '${memberId}'::uuid);
        UPDATE plan_months
           SET status = 'closed', lifecycle_mode = 'reopened', revision = 8,
               active_publication_id = '${secondPublicationId}'::uuid,
               updated_at = TIMESTAMPTZ '${actions[6][7]}'
         WHERE id = '${planMonthId}'::uuid;
      `)
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  it('returns typed lifecycle transitions, actors, reason and immutable refs newest-first', async () => {
    const first = await planning.getMonthHistory.execute({
      trustedUserId: secondUserId,
      planMonthId,
      limit: 3,
    })
    expect(first).toMatchObject({
      schemaVersion: 'planning.month-history.v1',
      planMonthId,
      targetMonth: '2026-07',
      current: { status: 'closed', mode: 'reopened', revision: '8' },
      items: [
        {
          kind: 'reclosed',
          actor: { kind: 'member', id: memberId },
          before: { status: 'grace', mode: 'reopened', revision: '7' },
          after: { status: 'closed', mode: 'reopened', revision: '8' },
          report: { reportRevisionId: secondReportId, revision: '2' },
        },
        {
          kind: 'reopened',
          reason: 'Сверили закрытый месяц.',
          before: { status: 'closed', mode: 'ordinary', revision: '6' },
          after: { status: 'grace', mode: 'reopened', revision: '7' },
        },
        {
          kind: 'closed',
          actor: { kind: 'system', id: 'planner-worker' },
          report: { reportRevisionId: firstReportId, revision: '1' },
        },
      ],
      nextCursor: '6',
    })
    const second = await planning.getMonthHistory.execute({
      trustedUserId: userId,
      planMonthId,
      limit: 3,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((item) => item.kind)).toEqual([
      'grace_started',
      'published',
      'publication_cancelled',
    ])
    expect(second.items[1]?.publication).toEqual({
      publicationId: secondPublicationId,
      revision: '2',
    })
    expect(second.items[2]?.publication).toEqual({
      publicationId: firstPublicationId,
      revision: '1',
    })
    expect(second.nextCursor).toBe('3')
    const third = await planning.getMonthHistory.execute({
      trustedUserId: userId,
      planMonthId,
      cursor: second.nextCursor!,
    })
    expect(third.items).toHaveLength(1)
    expect(third.items[0]).toMatchObject({
      kind: 'published',
      before: { status: 'draft', revision: '1' },
      after: { status: 'published', revision: '2' },
      publication: { publicationId: firstPublicationId, revision: '1' },
    })
    expect(third.nextCursor).toBeNull()
    await expect(
      planning.getMonthHistory.execute({
        trustedUserId: userId,
        planMonthId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PlanMonthNotFoundError)
  })
})
