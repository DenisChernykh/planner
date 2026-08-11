import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  GoalDefinitionRevisionConflictError,
  GoalDefinitionStateConflictError,
  PlanningAuthorizationDeniedError,
  createPlanningApplication,
} from '@/modules/planning'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const foreignUserId = '66666666-6666-4666-8666-666666666666'
const foreignMemberId = '77777777-7777-4777-8777-777777777777'
const foreignSpaceId = '88888888-8888-4888-8888-888888888888'

type PlanningApplication = ReturnType<typeof createPlanningApplication>
type DatabaseConfig = {
  readonly database: {
    readonly url: string
    readonly poolMax: number
    readonly connectionTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly healthTimeoutMs: number
    readonly transactionMaxWaitMs: number
    readonly transactionTimeoutMs: number
  }
}
type PlanningActor = ReturnType<typeof actor>
type CreateCommand = {
  readonly commandId: string
  readonly trustedActor: PlanningActor
  readonly payload: {
    readonly title: string
    readonly why: string
    readonly category: string
  }
}
type VersionCommand = {
  readonly commandId: string
  readonly trustedActor: PlanningActor
  readonly expectedRevision: bigint
  readonly payload: {
    readonly goalDefinitionId: string
    readonly title: string
    readonly why: string
    readonly category: string
    readonly seriesDecision: 'continue' | 'new'
  }
}
type StateCommand = {
  readonly commandId: string
  readonly trustedActor: PlanningActor
  readonly expectedRevision: bigint
  readonly payload: { readonly goalDefinitionId: string }
}
type PlanningCounts = {
  readonly definitions: number
  readonly series: number
  readonly versions: number
  readonly actions: number
  readonly changes: number
  readonly receipts: number
}

function databaseConfig(url: string): DatabaseConfig {
  return {
    database: {
      url,
      poolMax: 12,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 15_000,
    },
  }
}

async function applyMigration(pool: Pool, name: string): Promise<void> {
  await pool.query(
    await readFile(
      resolve(process.cwd(), 'prisma', 'migrations', name, 'migration.sql'),
      'utf8',
    ),
  )
}

async function createStack(
  databaseUrl: string,
  clock: FakeProductClock,
): Promise<{
  readonly provider: PrismaClientProvider
  readonly application: PlanningApplication
}> {
  const config = databaseConfig(databaseUrl)
  const context = new PrismaTransactionContext()
  const provider = new PrismaClientProvider(config, context)
  const transaction = new PrismaTransactionAdapter(provider, context, config)
  await provider.connect(AbortSignal.timeout(2_000))
  return {
    provider,
    application: createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock,
    }),
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member' as const, id: memberId }
}

function createCommand(commandId = randomUUID(), title = 'Сон'): CreateCommand {
  return {
    commandId,
    trustedActor: actor(),
    payload: { title, why: 'Восстановление', category: 'Здоровье' },
  }
}

function versionCommand(
  goalDefinitionId: string,
  expectedRevision: bigint,
  seriesDecision: 'continue' | 'new',
  commandId = randomUUID(),
): VersionCommand {
  return {
    commandId,
    trustedActor: actor(),
    expectedRevision,
    payload: {
      goalDefinitionId,
      title: 'Сон',
      why: seriesDecision === 'continue' ? 'Те же метаданные' : 'Новая линия',
      category: 'Здоровье',
      seriesDecision,
    },
  }
}

function stateCommand(
  goalDefinitionId: string,
  expectedRevision: bigint,
  commandId = randomUUID(),
): StateCommand {
  return {
    commandId,
    trustedActor: actor(),
    expectedRevision,
    payload: { goalDefinitionId },
  }
}

async function counts(pool: Pool): Promise<PlanningCounts | undefined> {
  const { rows } = await pool.query<PlanningCounts>(`
    SELECT
      (SELECT count(*)::int FROM goal_definitions) definitions,
      (SELECT count(*)::int FROM goal_series) series,
      (SELECT count(*)::int FROM goal_definition_versions) versions,
      (SELECT count(*)::int FROM planning_action_groups) actions,
      (SELECT count(*)::int FROM planning_goal_catalog_changes) changes,
      (SELECT count(*)::int FROM command_receipts) receipts
  `)
  return rows[0]
}

describe('P02 goal catalog with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let application: PlanningApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p02_test')
      .withUsername('planner')
      .withPassword('planner-test-password')
      .start()
    admin = new Pool({ connectionString: container.getConnectionUri() })
    for (const migration of [
      '20260811100000_local_user_session',
      '20260811110000_pair_workspace',
      '20260811120000_telegram_external_identity',
      '20260811130000_plan_draft_kernel',
      '20260811140000_goal_catalog',
    ]) {
      await applyMigration(admin, migration)
    }
    clock = new FakeProductClock(new Date('2026-03-02T03:04:05.678Z'))
    const stack = await createStack(container.getConnectionUri(), clock)
    provider = stack.provider
    application = stack.application
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE planning_goal_catalog_changes, planning_month_focus_changes,
        planning_action_groups, command_receipts, goal_definition_versions,
        goal_series, goal_definitions, plan_drafts, plan_months,
        telegram_external_identities, telegram_access_allowlist,
        memberships, spaces, users CASCADE;
      INSERT INTO users (id, created_at, updated_at) VALUES
        ('${firstUserId}', '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z'),
        ('${secondUserId}', '2026-01-02T03:04:06Z', '2026-01-02T03:04:06Z'),
        ('${foreignUserId}', '2026-01-02T03:04:07Z', '2026-01-02T03:04:07Z');
      INSERT INTO spaces (id, singleton_key, created_at) VALUES
        ('${spaceId}', 1, '2026-01-02T03:05:00Z');
      INSERT INTO memberships (id, space_id, user_id, slot, created_at) VALUES
        ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, '2026-01-02T03:06:00Z'),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2, '2026-01-02T03:06:01Z');
    `)
    clock.set(new Date('2026-03-02T03:04:05.678Z'))
  })

  it('upgrades accepted P01 rows without changing values, timestamps, xmin or immutable guards and starts P02 empty', async () => {
    const databaseName = 'planner_p02_upgrade'
    await admin.query(`CREATE DATABASE ${databaseName}`)
    const url = new URL(container.getConnectionUri())
    url.pathname = `/${databaseName}`
    const upgrade = new Pool({ connectionString: url.toString() })
    try {
      for (const migration of [
        '20260811100000_local_user_session',
        '20260811110000_pair_workspace',
        '20260811120000_telegram_external_identity',
        '20260811130000_plan_draft_kernel',
      ]) {
        await applyMigration(upgrade, migration)
      }
      await upgrade.query(`
        INSERT INTO users (id, created_at, updated_at)
          VALUES ('${firstUserId}', '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z');
        INSERT INTO spaces (id, singleton_key, created_at)
          VALUES ('${spaceId}', 1, '2026-01-02T03:05:00Z');
        INSERT INTO memberships (id, space_id, user_id, slot, created_at)
          VALUES ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, '2026-01-02T03:06:00Z');
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, created_at, updated_at)
          VALUES ('99999999-9999-4999-8999-999999999999', '${spaceId}',
                  '2026-04-01', 'draft', 1, '2026-03-01Z', '2026-03-01Z');
        INSERT INTO plan_drafts
          (plan_month_id, focus, revision, created_at, updated_at)
          VALUES ('99999999-9999-4999-8999-999999999999', 'P01 row', 1,
                  '2026-03-01Z', '2026-03-01Z');
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
          VALUES ('member:${firstMemberId}', 'planning.create-empty-draft.v1',
                  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('0', 64),
                  'planning.plan-draft.v1',
                  '99999999-9999-4999-8999-999999999999', 1, '2026-03-01Z');
        INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, command_type, command_id,
           before_revision, after_revision, occurred_at)
          VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'draft_created',
                  'member', 'member:${firstMemberId}', '${firstMemberId}', NULL,
                  '99999999-9999-4999-8999-999999999999',
                  'planning.create-empty-draft.v1',
                  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, 1,
                  '2026-03-01Z');
        INSERT INTO planning_month_focus_changes
          (action_id, before_focus, after_focus)
          VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, 'P01 row');
      `)
      const snapshot = async (): Promise<readonly { value: string }[]> =>
        upgrade
          .query<{ value: string }>(
            `
          SELECT value FROM (
            SELECT 'user:' || id || ':' || xmin || ':' || created_at || ':' || updated_at value FROM users
            UNION ALL SELECT 'space:' || id || ':' || xmin || ':' || created_at FROM spaces
            UNION ALL SELECT 'member:' || id || ':' || xmin || ':' || created_at FROM memberships
            UNION ALL SELECT 'month:' || id || ':' || xmin || ':' || month_start || ':' || status || ':' || revision || ':' || created_at || ':' || updated_at FROM plan_months
            UNION ALL SELECT 'draft:' || plan_month_id || ':' || xmin || ':' || focus || ':' || revision || ':' || created_at || ':' || updated_at FROM plan_drafts
            UNION ALL SELECT 'receipt:' || command_id || ':' || xmin || ':' || completed_at FROM command_receipts
            UNION ALL SELECT 'action:' || id || ':' || xmin || ':' || action_kind || ':' || occurred_at FROM planning_action_groups
            UNION ALL SELECT 'focus:' || action_id || ':' || xmin || ':' || after_focus FROM planning_month_focus_changes
          ) rows ORDER BY value
        `,
          )
          .then(({ rows }) => rows)
      const before = await snapshot()
      await applyMigration(upgrade, '20260811140000_goal_catalog')
      await expect(snapshot()).resolves.toEqual(before)
      const empty = await upgrade.query<{ count: string }>(`
        SELECT
          (SELECT count(*) FROM goal_definitions)
          + (SELECT count(*) FROM goal_series)
          + (SELECT count(*) FROM goal_definition_versions)
          + (SELECT count(*) FROM planning_goal_catalog_changes) count
      `)
      expect(empty.rows).toEqual([{ count: '0' }])
      await expect(
        upgrade.query("UPDATE command_receipts SET result_kind = 'changed.v1'"),
      ).rejects.toThrow(/immutable/u)
      await expect(
        upgrade.query('DELETE FROM planning_month_focus_changes'),
      ).rejects.toThrow(/immutable/u)
    } finally {
      await upgrade.end()
    }
  })

  it('creates, versions continue/new, archives, restores and copies exact immutable rows with one timestamp', async () => {
    const created = await application.createGoalDefinition.execute(
      createCommand('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    )
    expect(created.kind).toBe('planning.goal-definition.v1')
    expect(typeof created.aggregateId).toBe('string')
    expect(created.aggregateRevision).toBe(1n)
    const continued = await application.createGoalDefinitionVersion.execute(
      versionCommand(
        created.aggregateId,
        1n,
        'continue',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ),
    )
    const renewed = await application.createGoalDefinitionVersion.execute(
      versionCommand(
        created.aggregateId,
        2n,
        'new',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ),
    )
    expect([continued.aggregateRevision, renewed.aggregateRevision]).toEqual([
      2n,
      3n,
    ])
    await expect(
      application.archiveGoalDefinition.execute(
        stateCommand(
          created.aggregateId,
          3n,
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ),
      ),
    ).resolves.toMatchObject({ aggregateRevision: 4n })
    await expect(
      application.restoreGoalDefinition.execute(
        stateCommand(
          created.aggregateId,
          4n,
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        ),
      ),
    ).resolves.toMatchObject({ aggregateRevision: 5n })
    const sourceSnapshot = async (): Promise<readonly { value: string }[]> =>
      admin
        .query<{ value: string }>(
          `
        SELECT value FROM (
          SELECT 'definition:' || id || ':' || xmin || ':' || state || ':' || revision || ':' || created_at || ':' || updated_at || ':' || coalesce(archived_at::text, 'null') value
            FROM goal_definitions WHERE id = '${created.aggregateId}'
          UNION ALL
          SELECT 'series:' || id || ':' || xmin || ':' || created_at
            FROM goal_series WHERE goal_definition_id = '${created.aggregateId}'
          UNION ALL
          SELECT 'version:' || id || ':' || xmin || ':' || version_number || ':' || goal_series_id || ':' || series_decision || ':' || title || ':' || why || ':' || category || ':' || created_at
            FROM goal_definition_versions WHERE goal_definition_id = '${created.aggregateId}'
        ) rows ORDER BY value
      `,
        )
        .then(({ rows }) => rows)
    const sourceBeforeCopy = await sourceSnapshot()
    const copied = await application.copyGoalDefinition.execute({
      commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      trustedActor: actor(secondMemberId),
      expectedRevision: 5n,
      payload: { sourceGoalDefinitionId: created.aggregateId },
    })
    expect(copied).toMatchObject({
      kind: 'planning.goal-definition.v1',
      aggregateRevision: 1n,
    })
    expect(copied.aggregateId).not.toBe(created.aggregateId)
    await expect(sourceSnapshot()).resolves.toEqual(sourceBeforeCopy)

    const rows = await admin.query<{
      definition_id: string
      version_id: string
      state: string
      revision: string
      version_number: string
      series_id: string
      series_decision: string
      created_at: Date
      updated_at: Date
      archived_at: Date | null
    }>(`
      SELECT d.id::text definition_id, v.id::text version_id,
             d.state, d.revision::text,
             v.version_number::text, v.goal_series_id::text series_id,
             v.series_decision, d.created_at, d.updated_at, d.archived_at
        FROM goal_definitions d
        JOIN goal_definition_versions v ON v.goal_definition_id = d.id
       ORDER BY d.created_at, d.id, v.version_number
    `)
    const sourceRows = rows.rows.filter(
      ({ definition_id }) => definition_id === created.aggregateId,
    )
    const copyRows = rows.rows.filter(
      ({ definition_id }) => definition_id === copied.aggregateId,
    )
    expect(sourceRows.map(({ version_number }) => version_number)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(copyRows.map(({ version_number }) => version_number)).toEqual(['1'])
    expect(sourceRows.map(({ series_decision }) => series_decision)).toEqual([
      'new',
      'continue',
      'new',
    ])
    expect(sourceRows[0]?.series_id).toBe(sourceRows[1]?.series_id)
    expect(sourceRows[2]?.series_id).not.toBe(sourceRows[1]?.series_id)
    expect(copyRows[0]?.series_id).not.toBe(sourceRows[2]?.series_id)
    expect(
      rows.rows.every(({ created_at }) => created_at instanceof Date),
    ).toBe(true)
    const timestamps = await admin.query<{ occurred_at: Date }>(`
      SELECT occurred_at FROM (
        SELECT created_at occurred_at FROM goal_definitions
        UNION ALL SELECT updated_at FROM goal_definitions
        UNION ALL SELECT created_at FROM goal_series
        UNION ALL SELECT created_at FROM goal_definition_versions
        UNION ALL SELECT completed_at FROM command_receipts
        UNION ALL SELECT occurred_at FROM planning_action_groups
      ) moments
    `)
    expect(
      timestamps.rows.every(
        ({ occurred_at }) =>
          occurred_at.getTime() ===
          new Date('2026-03-02T03:04:05.678Z').getTime(),
      ),
    ).toBe(true)
    expect(await counts(admin)).toEqual({
      definitions: 2,
      series: 3,
      versions: 4,
      actions: 6,
      changes: 6,
      receipts: 6,
    })

    const sourceVersionIds = Object.fromEntries(
      sourceRows.map(({ version_number, version_id }) => [
        version_number,
        version_id,
      ]),
    )
    const copyVersionId = copyRows[0]?.version_id
    const history = await admin.query<{
      command_id: string
      action_kind: string
      target_id: string
      before_revision: string | null
      after_revision: string
      before_state: string | null
      after_state: string
      before_version_id: string | null
      after_version_id: string
      copy_source_definition_id: string | null
      copy_source_version_id: string | null
      series_decision: string | null
    }>(`
      SELECT a.command_id::text, a.action_kind,
             c.goal_definition_id::text target_id,
             a.before_revision::text, a.after_revision::text,
             c.before_state, c.after_state,
             c.before_version_id::text, c.after_version_id::text,
             c.copy_source_definition_id::text,
             c.copy_source_version_id::text, c.series_decision
        FROM planning_action_groups a
        JOIN planning_goal_catalog_changes c ON c.action_id = a.id
       ORDER BY a.command_id
    `)
    expect(history.rows).toEqual([
      {
        command_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        action_kind: 'goal_definition_created',
        target_id: created.aggregateId,
        before_revision: null,
        after_revision: '1',
        before_state: null,
        after_state: 'active',
        before_version_id: null,
        after_version_id: sourceVersionIds['1'],
        copy_source_definition_id: null,
        copy_source_version_id: null,
        series_decision: 'new',
      },
      {
        command_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        action_kind: 'goal_definition_versioned',
        target_id: created.aggregateId,
        before_revision: '1',
        after_revision: '2',
        before_state: 'active',
        after_state: 'active',
        before_version_id: sourceVersionIds['1'],
        after_version_id: sourceVersionIds['2'],
        copy_source_definition_id: null,
        copy_source_version_id: null,
        series_decision: 'continue',
      },
      {
        command_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        action_kind: 'goal_definition_versioned',
        target_id: created.aggregateId,
        before_revision: '2',
        after_revision: '3',
        before_state: 'active',
        after_state: 'active',
        before_version_id: sourceVersionIds['2'],
        after_version_id: sourceVersionIds['3'],
        copy_source_definition_id: null,
        copy_source_version_id: null,
        series_decision: 'new',
      },
      {
        command_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        action_kind: 'goal_definition_archived',
        target_id: created.aggregateId,
        before_revision: '3',
        after_revision: '4',
        before_state: 'active',
        after_state: 'archived',
        before_version_id: sourceVersionIds['3'],
        after_version_id: sourceVersionIds['3'],
        copy_source_definition_id: null,
        copy_source_version_id: null,
        series_decision: null,
      },
      {
        command_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        action_kind: 'goal_definition_restored',
        target_id: created.aggregateId,
        before_revision: '4',
        after_revision: '5',
        before_state: 'archived',
        after_state: 'active',
        before_version_id: sourceVersionIds['3'],
        after_version_id: sourceVersionIds['3'],
        copy_source_definition_id: null,
        copy_source_version_id: null,
        series_decision: null,
      },
      {
        command_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        action_kind: 'goal_definition_copied',
        target_id: copied.aggregateId,
        before_revision: null,
        after_revision: '1',
        before_state: null,
        after_state: 'active',
        before_version_id: null,
        after_version_id: copyVersionId,
        copy_source_definition_id: created.aggregateId,
        copy_source_version_id: sourceVersionIds['3'],
        series_decision: 'new',
      },
    ])

    const detail = await application.getGoalDefinition.execute({
      trustedActor: actor(secondMemberId),
      goalDefinitionId: created.aggregateId,
    })
    expect(detail).toMatchObject({
      goalDefinitionId: created.aggregateId,
      state: 'active',
      revision: 5n,
      currentVersion: { versionNumber: 3n, seriesDecision: 'new' },
      versions: [
        { versionNumber: 3n },
        { versionNumber: 2n },
        { versionNumber: 1n },
      ],
    })
    const copiedDetail = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: copied.aggregateId,
    })
    const expectedCopiedMetadata = {
      title: 'Сон',
      why: 'Новая линия',
      category: 'Здоровье',
    }
    expect({
      title: detail?.currentVersion.title,
      why: detail?.currentVersion.why,
      category: detail?.currentVersion.category,
    }).toEqual(expectedCopiedMetadata)
    expect({
      title: copiedDetail?.currentVersion.title,
      why: copiedDetail?.currentVersion.why,
      category: copiedDetail?.currentVersion.category,
    }).toEqual(expectedCopiedMetadata)
    const listed = await application.listGoalDefinitions.execute({
      trustedActor: actor(),
      state: 'all',
    })
    expect(listed.map(({ goalDefinitionId }) => goalDefinitionId)).toEqual(
      [created.aggregateId, copied.aggregateId].sort(),
    )
  })

  it('allows same names and same metadata as real definitions and versions', async () => {
    const first =
      await application.createGoalDefinition.execute(createCommand())
    await application.createGoalDefinition.execute(createCommand())
    await application.createGoalDefinitionVersion.execute({
      ...versionCommand(first.aggregateId, 1n, 'continue'),
      payload: {
        goalDefinitionId: first.aggregateId,
        title: 'Сон',
        why: 'Восстановление',
        category: 'Здоровье',
        seriesDecision: 'continue' as const,
      },
    })
    expect(await counts(admin)).toMatchObject({ definitions: 2, versions: 3 })
  })

  it('replays before later state checks, detects fingerprint first and permits corrected stale retry', async () => {
    const command = createCommand('12121212-1212-4212-8212-121212121212')
    const created = await application.createGoalDefinition.execute(command)
    await application.archiveGoalDefinition.execute(
      stateCommand(created.aggregateId, 1n),
    )
    const before = await counts(admin)
    await expect(
      application.createGoalDefinition.execute(command),
    ).resolves.toEqual(created)
    await expect(
      application.createGoalDefinition.execute({
        ...command,
        payload: { ...command.payload, title: 'Другой fingerprint' },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)

    const retryId = '13131313-1313-4313-8313-131313131313'
    await expect(
      application.restoreGoalDefinition.execute(
        stateCommand(created.aggregateId, 1n, retryId),
      ),
    ).rejects.toBeInstanceOf(GoalDefinitionRevisionConflictError)
    await expect(
      application.restoreGoalDefinition.execute(
        stateCommand(created.aggregateId, 2n, retryId),
      ),
    ).resolves.toMatchObject({ aggregateRevision: 3n })
    expect(await counts(admin)).toMatchObject({
      receipts: (before?.receipts ?? 0) + 1,
    })
  })

  it('serializes independent stacks and competing version/archive effects without orphans', async () => {
    const initialCommand = createCommand()
    const created =
      await application.createGoalDefinition.execute(initialCommand)
    const other = await createStack(container.getConnectionUri(), clock)
    try {
      await expect(
        other.application.createGoalDefinition.execute(initialCommand),
      ).resolves.toEqual(created)
      await expect(
        other.application.createGoalDefinition.execute({
          ...initialCommand,
          payload: { ...initialCommand.payload, title: 'conflicting title' },
        }),
      ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
      const race = await Promise.allSettled([
        application.createGoalDefinitionVersion.execute(
          versionCommand(created.aggregateId, 1n, 'new'),
        ),
        other.application.archiveGoalDefinition.execute(
          stateCommand(created.aggregateId, 1n),
        ),
      ])
      expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(
        1,
      )
      expect(race.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      const orphan = await admin.query<{ count: string }>(`
        SELECT count(*) FROM goal_series s
         WHERE NOT EXISTS (
           SELECT 1 FROM goal_definition_versions v
            WHERE v.goal_series_id = s.id
         )
      `)
      expect(orphan.rows).toEqual([{ count: '0' }])
    } finally {
      await other.provider.close(AbortSignal.timeout(2_000))
    }
  })

  it('allows both members and rejects system/unknown/foreign actors with zero writes', async () => {
    await expect(
      application.createGoalDefinition.execute({
        ...createCommand(),
        trustedActor: actor(secondMemberId),
      }),
    ).resolves.toMatchObject({ aggregateRevision: 1n })
    const before = await counts(admin)
    for (const trustedActor of [
      { kind: 'system' as const, id: 'planner-worker' as const },
      actor(foreignMemberId),
    ]) {
      await expect(
        application.createGoalDefinition.execute({
          ...createCommand(),
          trustedActor,
        }),
      ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    }
    expect(await counts(admin)).toEqual(before)

    await expect(
      application.getGoalDefinition.execute({
        trustedActor: actor(),
        goalDefinitionId: foreignSpaceId,
      }),
    ).resolves.toBeNull()
  })

  it('keeps list/get read-only down to row xmin while returning recursively frozen views', async () => {
    const created =
      await application.createGoalDefinition.execute(createCommand())
    await application.createGoalDefinitionVersion.execute(
      versionCommand(created.aggregateId, 1n, 'continue'),
    )
    const snapshot = async (): Promise<readonly { value: string }[]> =>
      admin
        .query<{ value: string }>(
          `
          SELECT value FROM (
            SELECT 'definition:' || id || ':' || xmin value FROM goal_definitions
            UNION ALL SELECT 'series:' || id || ':' || xmin FROM goal_series
            UNION ALL SELECT 'version:' || id || ':' || xmin FROM goal_definition_versions
            UNION ALL SELECT 'receipt:' || command_id || ':' || xmin FROM command_receipts
            UNION ALL SELECT 'action:' || id || ':' || xmin FROM planning_action_groups
            UNION ALL SELECT 'catalog:' || action_id || ':' || xmin FROM planning_goal_catalog_changes
          ) rows ORDER BY value
        `,
        )
        .then(({ rows }) => rows)
    const beforeRows = await snapshot()
    const beforeCounts = await counts(admin)

    const listed = await application.listGoalDefinitions.execute({
      trustedActor: actor(),
      state: 'all',
    })
    const detail = await application.getGoalDefinition.execute({
      trustedActor: actor(secondMemberId),
      goalDefinitionId: created.aggregateId,
    })

    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.currentVersion)).toBe(true)
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(detail?.versions)).toBe(true)
    expect(detail?.currentVersion).toBe(detail?.versions[0])
    await expect(snapshot()).resolves.toEqual(beforeRows)
    expect(await counts(admin)).toEqual(beforeCounts)
  })

  it('rolls back effect/history/receipt failures and permits the same command retry', async () => {
    const command = createCommand('14141414-1414-4414-8414-141414141414')
    await admin.query(`
      CREATE FUNCTION reject_catalog_change_for_test() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'catalog detail unavailable' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_catalog_change_for_test
      BEFORE INSERT ON planning_goal_catalog_changes
      FOR EACH ROW EXECUTE FUNCTION reject_catalog_change_for_test();
    `)
    await expect(
      application.createGoalDefinition.execute(command),
    ).rejects.toThrow()
    expect(await counts(admin)).toEqual({
      definitions: 0,
      series: 0,
      versions: 0,
      actions: 0,
      changes: 0,
      receipts: 0,
    })
    await admin.query(`
      DROP TRIGGER reject_catalog_change_for_test ON planning_goal_catalog_changes;
    `)
    await expect(
      application.createGoalDefinition.execute(command),
    ).resolves.toMatchObject({ aggregateRevision: 1n })
    const created = await application.listGoalDefinitions.execute({
      trustedActor: actor(),
    })
    const definitionId = created[0]?.goalDefinitionId
    expect(definitionId).toBeDefined()

    const version = versionCommand(
      definitionId!,
      1n,
      'new',
      '15151515-1515-4515-8515-151515151515',
    )
    const beforeVersion = await counts(admin)
    await admin.query(`
      CREATE TRIGGER reject_catalog_change_for_test
      BEFORE INSERT ON planning_goal_catalog_changes
      FOR EACH ROW EXECUTE FUNCTION reject_catalog_change_for_test();
    `)
    await expect(
      application.createGoalDefinitionVersion.execute(version),
    ).rejects.toThrow()
    expect(await counts(admin)).toEqual(beforeVersion)
    await admin.query(
      'DROP TRIGGER reject_catalog_change_for_test ON planning_goal_catalog_changes',
    )
    await expect(
      application.createGoalDefinitionVersion.execute(version),
    ).resolves.toMatchObject({ aggregateRevision: 2n })

    const archive = stateCommand(
      definitionId!,
      2n,
      '16161616-1616-4616-8616-161616161616',
    )
    const beforeArchive = await counts(admin)
    await admin.query(`
      CREATE TRIGGER reject_catalog_change_for_test
      BEFORE INSERT ON planning_goal_catalog_changes
      FOR EACH ROW EXECUTE FUNCTION reject_catalog_change_for_test();
    `)
    await expect(
      application.archiveGoalDefinition.execute(archive),
    ).rejects.toThrow()
    expect(await counts(admin)).toEqual(beforeArchive)
    await admin.query(`
      DROP TRIGGER reject_catalog_change_for_test ON planning_goal_catalog_changes;
      DROP FUNCTION reject_catalog_change_for_test();
    `)
    await expect(
      application.archiveGoalDefinition.execute(archive),
    ).resolves.toMatchObject({ aggregateRevision: 3n })
  })

  it('rejects every nullable and malformed direct history shape without SQL three-valued escape', async () => {
    const target =
      await application.createGoalDefinition.execute(createCommand())
    await application.createGoalDefinitionVersion.execute(
      versionCommand(target.aggregateId, 1n, 'continue'),
    )
    const source =
      await application.createGoalDefinition.execute(createCommand())
    const targetDetail = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: target.aggregateId,
    })
    const sourceDetail = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: source.aggregateId,
    })
    const targetVersionIds = Object.fromEntries(
      (targetDetail?.versions ?? []).map(
        ({ versionNumber, goalDefinitionVersionId }) => [
          versionNumber.toString(),
          goalDefinitionVersionId,
        ],
      ),
    )
    const sourceVersionId = sourceDetail?.currentVersion.goalDefinitionVersionId
    expect(sourceVersionId).toBeDefined()

    type HistoryShape = {
      readonly name: string
      readonly actionKind:
        | 'goal_definition_created'
        | 'goal_definition_versioned'
        | 'goal_definition_archived'
        | 'goal_definition_restored'
        | 'goal_definition_copied'
      readonly beforeRevision: bigint | null
      readonly afterRevision: bigint
      readonly beforeState: 'active' | 'archived' | null
      readonly afterState: 'active' | 'archived'
      readonly beforeVersionId: string | null
      readonly afterVersionId: string | null
      readonly copySourceDefinitionId: string | null
      readonly copySourceVersionId: string | null
      readonly seriesDecision: 'continue' | 'new' | null
    }
    const attempt = async (shape: HistoryShape): Promise<boolean> => {
      const client = await admin.connect()
      try {
        await client.query('BEGIN')
        const actionId = randomUUID()
        await client.query(
          `INSERT INTO planning_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id,
             system_actor_id, plan_month_id, goal_definition_id, command_type,
             command_id, before_revision, after_revision, occurred_at)
           VALUES ($1, $2, 'member', $3, $4, NULL, NULL, $5,
                   'planning.review-null-shape.v1', $6, $7, $8, now())`,
          [
            actionId,
            shape.actionKind,
            `member:${firstMemberId}`,
            firstMemberId,
            target.aggregateId,
            randomUUID(),
            shape.beforeRevision,
            shape.afterRevision,
          ],
        )
        try {
          await client.query(
            `INSERT INTO planning_goal_catalog_changes
              (action_id, goal_definition_id, before_state, after_state,
               before_version_id, after_version_id,
               copy_source_definition_id, copy_source_version_id,
               series_decision)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              actionId,
              target.aggregateId,
              shape.beforeState,
              shape.afterState,
              shape.beforeVersionId,
              shape.afterVersionId,
              shape.copySourceDefinitionId,
              shape.copySourceVersionId,
              shape.seriesDecision,
            ],
          )
          return true
        } catch (error: unknown) {
          if (
            error instanceof Error &&
            error.message.includes('planning_goal_catalog_changes_shape') &&
            (error as Error & { readonly code?: string }).code === '23514'
          ) {
            return false
          }
          throw error
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }

    const shapes: readonly HistoryShape[] = [
      {
        name: 'created-null-series-decision',
        actionKind: 'goal_definition_created',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: null,
      },
      {
        name: 'versioned-null-series-decision',
        actionKind: 'goal_definition_versioned',
        beforeRevision: 1n,
        afterRevision: 2n,
        beforeState: 'active',
        afterState: 'active',
        beforeVersionId: targetVersionIds['1']!,
        afterVersionId: targetVersionIds['2']!,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: null,
      },
      {
        name: 'archived-null-after-version',
        actionKind: 'goal_definition_archived',
        beforeRevision: 2n,
        afterRevision: 3n,
        beforeState: 'active',
        afterState: 'archived',
        beforeVersionId: targetVersionIds['2']!,
        afterVersionId: null,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: null,
      },
      {
        name: 'restored-null-after-version',
        actionKind: 'goal_definition_restored',
        beforeRevision: 2n,
        afterRevision: 3n,
        beforeState: 'archived',
        afterState: 'active',
        beforeVersionId: targetVersionIds['2']!,
        afterVersionId: null,
        copySourceDefinitionId: null,
        copySourceVersionId: null,
        seriesDecision: null,
      },
      {
        name: 'copied-null-series-decision',
        actionKind: 'goal_definition_copied',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: source.aggregateId,
        copySourceVersionId: sourceVersionId!,
        seriesDecision: null,
      },
      {
        name: 'created-with-copy-source',
        actionKind: 'goal_definition_created',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: source.aggregateId,
        copySourceVersionId: sourceVersionId!,
        seriesDecision: 'new',
      },
      {
        name: 'copied-self-source',
        actionKind: 'goal_definition_copied',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: target.aggregateId,
        copySourceVersionId: targetVersionIds['1']!,
        seriesDecision: 'new',
      },
      {
        name: 'copied-with-before-state',
        actionKind: 'goal_definition_copied',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: 'active',
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: source.aggregateId,
        copySourceVersionId: sourceVersionId!,
        seriesDecision: 'new',
      },
      {
        name: 'copied-null-source-version',
        actionKind: 'goal_definition_copied',
        beforeRevision: null,
        afterRevision: 1n,
        beforeState: null,
        afterState: 'active',
        beforeVersionId: null,
        afterVersionId: targetVersionIds['1']!,
        copySourceDefinitionId: source.aggregateId,
        copySourceVersionId: null,
        seriesDecision: 'new',
      },
    ]
    const accepted: string[] = []
    for (const shape of shapes) {
      if (await attempt(shape)) accepted.push(shape.name)
    }
    expect(accepted).toEqual([])
  })

  it('enforces named metadata, revision, continuity, ownership and immutable-row constraints directly', async () => {
    const created =
      await application.createGoalDefinition.execute(createCommand())
    await application.createGoalDefinitionVersion.execute(
      versionCommand(created.aggregateId, 1n, 'continue'),
    )
    await application.createGoalDefinitionVersion.execute(
      versionCommand(created.aggregateId, 2n, 'new'),
    )
    const definition = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: created.aggregateId,
    })
    const current = definition?.currentVersion
    expect(current).toBeDefined()
    const versionIds = Object.fromEntries(
      (definition?.versions ?? []).map(
        ({ versionNumber, goalDefinitionVersionId }) => [
          versionNumber.toString(),
          goalDefinitionVersionId,
        ],
      ),
    )

    const expectCatalogDetailRejected = async (input: {
      readonly actionKind:
        | 'goal_definition_versioned'
        | 'goal_definition_archived'
        | 'goal_definition_restored'
      readonly beforeRevision: bigint
      readonly afterRevision: bigint
      readonly beforeState: 'active' | 'archived'
      readonly afterState: 'active' | 'archived'
      readonly beforeVersionId: string
      readonly afterVersionId: string
      readonly seriesDecision: 'continue' | 'new' | null
    }): Promise<void> => {
      const client = await admin.connect()
      try {
        await client.query('BEGIN')
        const actionId = randomUUID()
        await client.query(
          `INSERT INTO planning_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id,
             system_actor_id, plan_month_id, goal_definition_id, command_type,
             command_id, before_revision, after_revision, occurred_at)
           VALUES ($1, $2, 'member', $3, $4, NULL, NULL, $5,
                   'planning.review-invalid.v1', $6, $7, $8, now())`,
          [
            actionId,
            input.actionKind,
            `member:${firstMemberId}`,
            firstMemberId,
            created.aggregateId,
            randomUUID(),
            input.beforeRevision,
            input.afterRevision,
          ],
        )
        await expect(
          client.query(
            `INSERT INTO planning_goal_catalog_changes
              (action_id, goal_definition_id, before_state, after_state,
               before_version_id, after_version_id,
               copy_source_definition_id, copy_source_version_id,
               series_decision)
             VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)`,
            [
              actionId,
              created.aggregateId,
              input.beforeState,
              input.afterState,
              input.beforeVersionId,
              input.afterVersionId,
              input.seriesDecision,
            ],
          ),
        ).rejects.toThrow(/planning_goal_catalog_changes_shape/u)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }

    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_archived',
      beforeRevision: 3n,
      afterRevision: 4n,
      beforeState: 'archived',
      afterState: 'active',
      beforeVersionId: versionIds['3']!,
      afterVersionId: versionIds['3']!,
      seriesDecision: null,
    })
    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_restored',
      beforeRevision: 3n,
      afterRevision: 4n,
      beforeState: 'active',
      afterState: 'archived',
      beforeVersionId: versionIds['3']!,
      afterVersionId: versionIds['3']!,
      seriesDecision: null,
    })
    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_versioned',
      beforeRevision: 3n,
      afterRevision: 4n,
      beforeState: 'active',
      afterState: 'active',
      beforeVersionId: versionIds['2']!,
      afterVersionId: versionIds['2']!,
      seriesDecision: 'continue',
    })
    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_versioned',
      beforeRevision: 3n,
      afterRevision: 4n,
      beforeState: 'active',
      afterState: 'active',
      beforeVersionId: versionIds['1']!,
      afterVersionId: versionIds['3']!,
      seriesDecision: 'new',
    })
    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_versioned',
      beforeRevision: 3n,
      afterRevision: 4n,
      beforeState: 'active',
      afterState: 'active',
      beforeVersionId: versionIds['2']!,
      afterVersionId: versionIds['3']!,
      seriesDecision: 'continue',
    })
    await expectCatalogDetailRejected({
      actionKind: 'goal_definition_versioned',
      beforeRevision: 1n,
      afterRevision: 3n,
      beforeState: 'active',
      afterState: 'active',
      beforeVersionId: versionIds['1']!,
      afterVersionId: versionIds['2']!,
      seriesDecision: 'continue',
    })

    const hybridClient = await admin.connect()
    try {
      await hybridClient.query('BEGIN')
      const actionId = randomUUID()
      await hybridClient.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id, command_type,
           command_id, before_revision, after_revision, occurred_at)
         VALUES ($1, 'goal_definition_archived', 'member', $2, $3, NULL,
                 NULL, $4, 'planning.review-hybrid.v1', $5, 3, 4, now())`,
        [
          actionId,
          `member:${firstMemberId}`,
          firstMemberId,
          created.aggregateId,
          randomUUID(),
        ],
      )
      await expect(
        hybridClient.query(
          `INSERT INTO planning_month_focus_changes
            (action_id, before_focus, after_focus)
           VALUES ($1, NULL, 'hybrid')`,
          [actionId],
        ),
      ).rejects.toThrow(/planning_month_focus_changes_parent_kind/u)
    } finally {
      await hybridClient.query('ROLLBACK').catch(() => undefined)
      hybridClient.release()
    }

    const directDefinitionId = randomUUID()
    const directSeriesId = randomUUID()
    await admin.query(
      `INSERT INTO goal_definitions
        (id, space_id, state, revision, created_at, updated_at, archived_at)
       VALUES ($1, $2, 'active', 1, now(), now(), NULL)`,
      [directDefinitionId, spaceId],
    )
    await admin.query(
      `INSERT INTO goal_series (id, goal_definition_id, created_at)
       VALUES ($1, $2, now())`,
      [directSeriesId, directDefinitionId],
    )
    await expect(
      admin.query(
        `INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
         VALUES ($1, $2, 1, $3, 'new', E'\t\n', 'why', 'category', now())`,
        [randomUUID(), directDefinitionId, directSeriesId],
      ),
    ).rejects.toThrow(/goal_definition_versions_title_check/u)

    await expect(
      admin.query(
        `INSERT INTO goal_definitions
          (id, space_id, state, revision, created_at, updated_at, archived_at)
         VALUES ($1, $2, 'deleted', 1, now(), now(), NULL)`,
        [randomUUID(), spaceId],
      ),
    ).rejects.toThrow(/goal_definitions_state_archived_at_check/u)
    await expect(
      admin.query(
        `INSERT INTO goal_definitions
          (id, space_id, state, revision, created_at, updated_at, archived_at)
         VALUES ($1, $2, 'active', 0, now(), now(), NULL)`,
        [randomUUID(), spaceId],
      ),
    ).rejects.toThrow(/goal_definitions_revision_check/u)
    await expect(
      admin.query(
        `INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
         VALUES ($1, $2, 4, $3, 'new', 'cross', 'why', 'category', now())`,
        [randomUUID(), created.aggregateId, directSeriesId],
      ),
    ).rejects.toThrow(/goal_definition_versions_definition_series_fkey/u)

    await expect(
      admin.query(`UPDATE goal_definitions SET revision = 9 WHERE id = $1`, [
        created.aggregateId,
      ]),
    ).rejects.toThrow(/goal_definitions_revision_consecutive/u)
    await expect(
      admin.query(`UPDATE goal_definition_versions SET title = 'changed'`),
    ).rejects.toThrow(/immutable/u)
    await expect(admin.query(`DELETE FROM goal_series`)).rejects.toThrow(
      /immutable/u,
    )
    await expect(
      admin.query(`UPDATE planning_action_groups SET after_revision = 99`),
    ).rejects.toThrow(/immutable/u)
    await expect(
      admin.query(`DELETE FROM planning_goal_catalog_changes`),
    ).rejects.toThrow(/immutable/u)
    await expect(admin.query(`DELETE FROM goal_definitions`)).rejects.toThrow(
      /cannot be physically deleted/u,
    )
    await expect(
      admin.query(
        `INSERT INTO goal_definition_versions
          (id, goal_definition_id, version_number, goal_series_id,
           series_decision, title, why, category, created_at)
         VALUES ($1, $2, 9, $3, 'continue', 'x', 'y', 'z', now())`,
        [randomUUID(), created.aggregateId, current?.goalSeriesId],
      ),
    ).rejects.toThrow(/goal_definition_versions_continuity/u)

    const orphanActionId = randomUUID()
    const orphanCommandId = randomUUID()
    const currentVersionId = current!.goalDefinitionVersionId
    const orphanClient = await admin.connect()
    try {
      await orphanClient.query('BEGIN')
      await orphanClient.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id, command_type,
           command_id, before_revision, after_revision, occurred_at)
         VALUES ($1, 'goal_definition_archived', 'member', $2, $3, NULL,
                 NULL, $4, 'planning.archive-goal-definition.v1', $5,
                 1, 2, now())`,
        [
          orphanActionId,
          `member:${firstMemberId}`,
          firstMemberId,
          created.aggregateId,
          orphanCommandId,
        ],
      )
      await orphanClient.query(
        `INSERT INTO planning_goal_catalog_changes
          (action_id, goal_definition_id, before_state, after_state,
           before_version_id, after_version_id, copy_source_definition_id,
           copy_source_version_id, series_decision)
         VALUES ($1, $2, 'active', 'archived', $3, $3, NULL, NULL, NULL)`,
        [orphanActionId, created.aggregateId, currentVersionId],
      )
      await expect(orphanClient.query('COMMIT')).rejects.toThrow(
        /planning_action_groups_receipt_fkey/u,
      )
    } finally {
      await orphanClient.query('ROLLBACK').catch(() => undefined)
      orphanClient.release()
    }

    const missingDetailClient = await admin.connect()
    try {
      const missingDetailActionId = randomUUID()
      const missingDetailCommandId = randomUUID()
      await missingDetailClient.query('BEGIN')
      await missingDetailClient.query(
        `INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'planning.archive-goal-definition.v1', $2,
                 repeat('1', 64), 'planning.goal-definition.v1', $3, 2, now())`,
        [
          `member:${firstMemberId}`,
          missingDetailCommandId,
          created.aggregateId,
        ],
      )
      await missingDetailClient.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id,
           system_actor_id, plan_month_id, goal_definition_id, command_type,
           command_id, before_revision, after_revision, occurred_at)
         VALUES ($1, 'goal_definition_archived', 'member', $2, $3, NULL,
                 NULL, $4, 'planning.archive-goal-definition.v1', $5,
                 1, 2, now())`,
        [
          missingDetailActionId,
          `member:${firstMemberId}`,
          firstMemberId,
          created.aggregateId,
          missingDetailCommandId,
        ],
      )
      await expect(missingDetailClient.query('COMMIT')).rejects.toThrow(
        /planning_goal_catalog_change_required/u,
      )
    } finally {
      await missingDetailClient.query('ROLLBACK').catch(() => undefined)
      missingDetailClient.release()
    }

    await application.archiveGoalDefinition.execute(
      stateCommand(created.aggregateId, 3n),
    )
    await expect(
      application.archiveGoalDefinition.execute(
        stateCommand(created.aggregateId, 4n),
      ),
    ).rejects.toBeInstanceOf(GoalDefinitionStateConflictError)
    await expect(
      application.createGoalDefinitionVersion.execute(
        versionCommand(created.aggregateId, 4n, 'continue'),
      ),
    ).rejects.toBeInstanceOf(GoalDefinitionStateConflictError)
  })
})
