import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { ReopenMonthCommand } from '@/modules/planning/application/reopen-month.command'
import {
  PlanDraftNotEditableError,
  PlanMonthReopenConflictError,
  PlanMonthRevisionConflictError,
  PlanningAuthorizationDeniedError,
} from '@/modules/planning/application/planning-errors'
import {
  createPlanningApplication,
  type PlanningApplication,
} from '@/modules/planning'
import { PrismaDueLifecycleRepository } from '@/modules/planning/infrastructure/due-lifecycle.repository'
import { PrismaReopenMonthPersistence } from '@/modules/planning/infrastructure/prisma-reopen-month.persistence'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { DatabaseRuntimeConfig } from '@/platform/config/runtime-config.types'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const spaceId = '22222222-2222-4222-8222-222222222222'
const memberId = '33333333-3333-4333-8333-333333333333'
const planMonthId = '44444444-4444-4444-8444-444444444444'
const publicationId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'
const publishCommandId = '77777777-7777-4777-8777-777777777777'
const graceCommandId = '88888888-8888-4888-8888-888888888888'
const closeCommandId = '99999999-9999-4999-8999-999999999999'
const reportId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const concurrentCommandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const outsiderMemberId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

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
  readonly database: DatabaseRuntimeConfig
} {
  return {
    database: {
      url,
      poolMax: 8,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 20_000,
    },
  }
}

describe('L02 ReopenMonth on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let command: ReopenMonthCommand
  let planning: PlanningApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_l02_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const databaseUrl = postgres.getConnectionUri()
    deployMigrations(databaseUrl)
    pool = new Pool({ connectionString: databaseUrl })
    const config = runtimeConfig(databaseUrl)
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(10_000))
    const transaction = new PrismaTransactionAdapter(provider, context, config)
    const workspaceMembers = new PrismaWorkspaceMemberResolver(provider)
    const clock = new FakeProductClock(new Date('2026-08-22T10:00:00.000Z'))
    command = new ReopenMonthCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      workspaceMembers,
      new PrismaReopenMonthPersistence(provider),
    )
    planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers,
      clock,
    })
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO users (id) VALUES ('${userId}'::uuid);
        INSERT INTO spaces (id, singleton_key)
        VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot)
        VALUES ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1);
        INSERT INTO plan_months
          (id, space_id, month_start, status, lifecycle_mode, revision,
           facts_revision, active_publication_id, created_at, updated_at)
        VALUES
          ('${planMonthId}'::uuid, '${spaceId}'::uuid, DATE '2026-07-01',
           'draft', 'ordinary', 1, 0, NULL,
           TIMESTAMPTZ '2026-07-01 00:00:00Z',
           TIMESTAMPTZ '2026-07-01 00:00:00Z');
        INSERT INTO plan_drafts
          (plan_month_id, focus, revision, created_at, updated_at)
        VALUES
          ('${planMonthId}'::uuid, 'L02 fixture', 1,
           TIMESTAMPTZ '2026-07-01 00:00:00Z',
           TIMESTAMPTZ '2026-07-01 00:00:00Z');
        INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
        VALUES
          ('${publicationId}'::uuid, '${spaceId}'::uuid, '${planMonthId}'::uuid,
           1, 1, 1, 'L02 fixture', 'immediate', DATE '2026-07-01', false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', '${'ab'.repeat(32)}',
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${memberId}'::uuid,
           TIMESTAMPTZ '2026-07-01 00:00:00Z');
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'month_published',
           'member', 'member:${memberId}', '${memberId}'::uuid, NULL,
           '${planMonthId}'::uuid, NULL, 'planning.publish-month.v1',
           '${publishCommandId}'::uuid, 1, 2,
           TIMESTAMPTZ '2026-07-01 00:00:00Z');
        INSERT INTO planning_publication_changes
          (action_id, publication_id, change_kind, confirmed_draft_revision,
           confirmed_preview_schema_version, confirmed_preview_hash_version,
           confirmed_preview_hash, before_active_publication_id,
           after_active_publication_id)
        VALUES
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
           '${publicationId}'::uuid, 'published', 1,
           'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', '${'ab'.repeat(32)}', NULL,
           '${publicationId}'::uuid);
        UPDATE plan_months
           SET status = 'published', active_publication_id = '${publicationId}'::uuid,
               revision = 2,
               updated_at = TIMESTAMPTZ '2026-07-01 00:00:00Z'
         WHERE id = '${planMonthId}'::uuid;
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('member:${memberId}', 'planning.publish-month.v1',
           '${publishCommandId}'::uuid, repeat('0', 64),
           'planning.plan-publication.v1', '${publicationId}'::uuid, 1,
           TIMESTAMPTZ '2026-07-01 00:00:00Z');
        SET CONSTRAINTS ALL IMMEDIATE;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
           'month_grace_started', 'system', 'system:planner-worker', NULL,
           'planner-worker', '${planMonthId}'::uuid, NULL,
           'planning.start-month-grace.v1', '${graceCommandId}'::uuid, 2, 3,
           TIMESTAMPTZ '2026-08-01 00:00:00Z');
        UPDATE plan_months
           SET status = 'grace', revision = 3,
               updated_at = TIMESTAMPTZ '2026-08-01 00:00:00Z'
         WHERE id = '${planMonthId}'::uuid;
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('system:planner-worker', 'planning.start-month-grace.v1',
           '${graceCommandId}'::uuid, repeat('1', 64),
           'planning.plan-month.v1', '${planMonthId}'::uuid, 3,
           TIMESTAMPTZ '2026-08-01 00:00:00Z');
        SET CONSTRAINTS ALL IMMEDIATE;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id,
           command_type, command_id, before_revision, after_revision,
           occurred_at)
        VALUES
          ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid, 'month_closed',
           'system', 'system:planner-worker', NULL, 'planner-worker',
           '${planMonthId}'::uuid, NULL, 'planning.close-month.v1',
           '${closeCommandId}'::uuid, 3, 4,
           TIMESTAMPTZ '2026-08-04 06:00:00Z');
        INSERT INTO report_revisions
          (id, plan_month_id, publication_id, revision,
           publication_snapshot_hash, source_facts_revision, formula_version,
           payload, payload_checksum, status, created_at,
           created_by_system_actor_id)
        VALUES
          ('${reportId}'::uuid, '${planMonthId}'::uuid, '${publicationId}'::uuid,
           1, '${'ab'.repeat(32)}', 0, 'planner.report.v1', '{}'::jsonb,
           '${'cd'.repeat(32)}', 'original',
           TIMESTAMPTZ '2026-08-04 06:00:00Z', 'planner-worker');
        UPDATE plan_months
           SET status = 'closed', revision = 4,
               updated_at = TIMESTAMPTZ '2026-08-04 06:00:00Z'
         WHERE id = '${planMonthId}'::uuid;
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('system:planner-worker', 'planning.close-month.v1',
           '${closeCommandId}'::uuid, repeat('2', 64),
           'planning.report-revision.v1', '${reportId}'::uuid, 1,
           TIMESTAMPTZ '2026-08-04 06:00:00Z');
      `)
      await client.query('COMMIT')
    } catch (error: unknown) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  it('reopens once, records immutable reason, and replays the receipt', async () => {
    const input = {
      commandId,
      trustedActor: { kind: 'member' as const, id: memberId },
      expectedRevision: 4n,
      payload: { planMonthId, reason: 'Сверили записи с бумажным журналом.' },
    }
    await expect(command.execute(input)).resolves.toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: planMonthId,
      aggregateRevision: 5n,
    })
    await expect(command.execute(input)).resolves.toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: planMonthId,
      aggregateRevision: 5n,
    })

    const month = await pool.query(
      `SELECT status, lifecycle_mode, revision, facts_revision
         FROM plan_months WHERE id = $1::uuid`,
      [planMonthId],
    )
    expect(month.rows).toEqual([
      {
        status: 'grace',
        lifecycle_mode: 'reopened',
        revision: '5',
        facts_revision: '0',
      },
    ])
    const audit = await pool.query(
      `SELECT action.action_kind, action.actor_kind, action.before_revision,
              action.after_revision, detail.reason
         FROM planning_action_groups action
         JOIN planning_month_reopen_changes detail ON detail.action_id = action.id
        WHERE action.plan_month_id = $1::uuid`,
      [planMonthId],
    )
    expect(audit.rows).toEqual([
      {
        action_kind: 'month_reopened',
        actor_kind: 'member',
        before_revision: '4',
        after_revision: '5',
        reason: 'Сверили записи с бумажным журналом.',
      },
    ])
    const reports = await pool.query(
      'SELECT count(*)::int AS count FROM report_revisions WHERE plan_month_id = $1::uuid',
      [planMonthId],
    )
    expect(reports.rows[0]).toEqual({ count: 1 })
    await expect(
      new PrismaDueLifecycleRepository(provider).findDueMonthClosures({
        currentLocalDate: '2026-08-10',
        limit: 10,
      }),
    ).resolves.toEqual([])
    await expect(
      planning.updateMonthFocus.execute({
        commandId: '12121212-1212-4212-8212-121212121212',
        trustedActor: { kind: 'member', id: memberId },
        expectedRevision: 1n,
        payload: { planMonthId, focus: 'Нельзя менять конфигурацию.' },
      }),
    ).rejects.toBeInstanceOf(PlanDraftNotEditableError)
  })

  it('serializes concurrent reopen attempts and preserves stale/actor errors', async () => {
    const base = {
      trustedActor: { kind: 'member' as const, id: memberId },
      expectedRevision: 4n,
      payload: { planMonthId, reason: 'Повторная сверка.' },
    }
    const outcomes = await Promise.allSettled([
      command.execute({ ...base, commandId }),
      command.execute({ ...base, commandId: concurrentCommandId }),
    ])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    const rejected = outcomes.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    )
    expect(rejected?.reason).toBeInstanceOf(PlanMonthRevisionConflictError)

    await expect(
      command.execute({
        ...base,
        commandId: 'abababab-abab-4aba-8aba-abababababab',
        expectedRevision: 5n,
      }),
    ).rejects.toBeInstanceOf(PlanMonthReopenConflictError)

    await expect(
      command.execute({
        ...base,
        commandId: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
        trustedActor: { kind: 'member' as const, id: outsiderMemberId },
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
  })
})
