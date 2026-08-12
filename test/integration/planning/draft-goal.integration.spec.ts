import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  DraftGoalNotFoundError,
  DraftRevisionConflictError,
  GoalDefinitionVersionNotFoundError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
  createPlanningApplication,
} from '@/modules/planning'
import { PrismaDraftGoalPersistence } from '@/modules/planning/infrastructure/prisma-draft-goal.persistence'
import type { DraftGoalConfigV1 } from '@/modules/planning/domain/goal-config'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

type Application = ReturnType<typeof createPlanningApplication>
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

function config(url: string): DatabaseConfig {
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

function deployMigrations(
  databaseUrl: string,
  configPath = 'prisma.config.ts',
): { readonly exitCode: number; readonly output: string } {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', configPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  }
}

async function p02MigrationConfig(): Promise<{
  readonly configPath: string
  cleanup(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'planner-p03-upgrade-'))
  const migrations = join(directory, 'migrations')
  for (const name of [
    '20260811090000_planner_foundation',
    '20260811100000_local_user_session',
    '20260811110000_pair_workspace',
    '20260811120000_telegram_external_identity',
    '20260811130000_plan_draft_kernel',
    '20260811140000_goal_catalog',
  ]) {
    await cp(
      resolve(process.cwd(), 'prisma', 'migrations', name),
      join(migrations, name),
      { recursive: true },
    )
  }
  const configPath = join(directory, 'prisma.config.ts')
  await writeFile(
    configPath,
    `import { defineConfig } from '${resolve(process.cwd(), 'node_modules/prisma/config')}'\n` +
      `export default defineConfig({ schema: '${resolve(process.cwd(), 'prisma/schema.prisma')}', migrations: { path: '${migrations}' }, datasource: { url: process.env.DATABASE_URL } })\n`,
    'utf8',
  )
  return {
    configPath,
    cleanup: () => rm(directory, { force: true, recursive: true }),
  }
}

async function stack(
  databaseUrl: string,
  clock: FakeProductClock,
): Promise<{
  readonly provider: PrismaClientProvider
  readonly application: Application
}> {
  const runtimeConfig = config(databaseUrl)
  const context = new PrismaTransactionContext()
  const provider = new PrismaClientProvider(runtimeConfig, context)
  const transaction = new PrismaTransactionAdapter(
    provider,
    context,
    runtimeConfig,
  )
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
  return { kind: 'member', id: memberId }
}

function goalConfig(ownerMemberId = firstMemberId): DraftGoalConfigV1 {
  return {
    schemaVersion: 1,
    scope: { kind: 'personal', ownerMemberId },
    repetition: { kind: 'daily' },
    measurement: {
      kind: 'checklist',
      items: [
        { itemId: null, label: 'Вода' },
        { itemId: null, label: 'Сон' },
      ],
    },
    checkpoints: null,
  }
}

async function seedDraftAndDefinitions(
  application: Application,
  count = 1,
): Promise<{
  readonly planMonthId: string
  readonly definitionIds: readonly string[]
}> {
  const draft = await application.createEmptyDraft.execute({
    commandId: randomUUID(),
    trustedActor: actor(),
    payload: { targetMonth: '2026-04', focus: 'P03' },
  })
  const definitionIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        title: `Goal ${index}`,
        why: 'P03 integration',
        category: 'Test',
      },
    })
    definitionIds.push(definition.aggregateId)
  }
  return { planMonthId: draft.aggregateId, definitionIds }
}

async function seedActiveGoalLimit(
  pool: Pool,
  planMonthId: string,
  count = 200,
): Promise<string> {
  const configJson = JSON.stringify(goalConfig())
  await pool.query(`
    BEGIN;
    CREATE TEMP TABLE p03_goal_limit_fixture (
      ordinal INTEGER PRIMARY KEY,
      definition_id UUID NOT NULL,
      series_id UUID NOT NULL,
      version_id UUID NOT NULL,
      root_id UUID NOT NULL,
      revision_id UUID NOT NULL
    ) ON COMMIT DROP;
    INSERT INTO p03_goal_limit_fixture
      (ordinal, definition_id, series_id, version_id, root_id, revision_id)
    SELECT ordinal, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
           gen_random_uuid(), gen_random_uuid()
      FROM generate_series(1, ${count + 1}) ordinal;
    INSERT INTO goal_definitions
      (id, space_id, state, revision, created_at, updated_at, archived_at)
    SELECT definition_id, '${spaceId}', 'active', 1, now(), now(), NULL
      FROM p03_goal_limit_fixture;
    INSERT INTO goal_series (id, goal_definition_id, created_at)
    SELECT series_id, definition_id, now() FROM p03_goal_limit_fixture;
    INSERT INTO goal_definition_versions
      (id, goal_definition_id, version_number, goal_series_id,
       series_decision, title, why, category, created_at)
    SELECT version_id, definition_id, 1, series_id, 'new',
           'Limit ' || ordinal, 'P03 active limit', 'Test', now()
      FROM p03_goal_limit_fixture;
    INSERT INTO plan_draft_goals
      (id, space_id, plan_month_id, goal_definition_id, display_order,
       current_revision_id, attached_at, detached_at, created_at, updated_at)
    SELECT root_id, '${spaceId}', '${planMonthId}', definition_id, ordinal - 1,
           NULL, now(), NULL, now(), now()
      FROM p03_goal_limit_fixture WHERE ordinal <= ${count};
    INSERT INTO plan_draft_goal_revisions
      (id, plan_goal_id, space_id, goal_definition_id, revision_number,
       goal_definition_version_id, goal_series_id, scope_kind,
       owner_member_id, config, source_provenance, created_at)
    SELECT revision_id, root_id, '${spaceId}', definition_id, 1, version_id,
           series_id, 'personal', '${firstMemberId}', '${configJson}'::jsonb,
           NULL, now()
      FROM p03_goal_limit_fixture WHERE ordinal <= ${count};
    UPDATE plan_draft_goals root SET current_revision_id = fixture.revision_id
      FROM p03_goal_limit_fixture fixture WHERE root.id = fixture.root_id;
    COMMIT;
  `)
  const candidate = await pool.query<{ id: string }>(`
    SELECT definition.id::text id
      FROM goal_definitions definition
      JOIN goal_definition_versions version
        ON version.goal_definition_id = definition.id
     WHERE version.title = 'Limit ${count + 1}'
  `)
  return candidate.rows[0]!.id
}

describe('P03 typed draft goals with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let application: Application
  let clock: FakeProductClock

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p03_test')
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
      '20260811150000_typed_draft_goals',
    ]) {
      await applyMigration(admin, migration)
    }
    clock = new FakeProductClock(new Date('2026-03-02T03:04:05.678Z'))
    const created = await stack(container.getConnectionUri(), clock)
    provider = created.provider
    application = created.application
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE planning_draft_goal_changes, planning_goal_catalog_changes,
        planning_month_focus_changes, planning_action_groups, command_receipts,
        plan_draft_goal_revisions, plan_draft_goals, goal_definition_versions,
        goal_series, goal_definitions, plan_drafts, plan_months,
        telegram_external_identities, telegram_access_allowlist,
        memberships, spaces, users CASCADE;
      INSERT INTO users (id, created_at, updated_at) VALUES
        ('${firstUserId}', now(), now()), ('${secondUserId}', now(), now());
      INSERT INTO spaces (id, singleton_key, created_at)
        VALUES ('${spaceId}', 1, now());
      INSERT INTO memberships (id, space_id, user_id, slot, created_at) VALUES
        ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, now()),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2, now());
    `)
    clock.set(new Date('2026-03-02T03:04:05.678Z'))
  })

  it('deploys the exact P02 to P03 migration upgrade without rewriting accepted rows or weakening guards', async () => {
    const databaseName = 'planner_p03_upgrade'
    await admin.query(`CREATE DATABASE ${databaseName}`)
    const url = new URL(container.getConnectionUri())
    url.pathname = `/${databaseName}`
    const databaseUrl = url.toString()
    const accepted = await p02MigrationConfig()
    const upgrade = new Pool({ connectionString: databaseUrl })
    let upgradeProvider: PrismaClientProvider | undefined
    try {
      const p02 = deployMigrations(databaseUrl, accepted.configPath)
      expect(p02).toMatchObject({ exitCode: 0 })
      await upgrade.query(`
        INSERT INTO users (id, created_at, updated_at) VALUES
          ('${firstUserId}', '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z'),
          ('${secondUserId}', '2026-01-02T03:04:06Z', '2026-01-02T03:04:06Z');
        INSERT INTO spaces (id, singleton_key, created_at)
          VALUES ('${spaceId}', 1, '2026-01-02T03:05:00Z');
        INSERT INTO memberships (id, space_id, user_id, slot, created_at) VALUES
          ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, '2026-01-02T03:06:00Z'),
          ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2, '2026-01-02T03:06:01Z');
      `)
      const acceptedStack = await stack(
        databaseUrl,
        new FakeProductClock(new Date('2026-03-02T03:04:05.678Z')),
      )
      upgradeProvider = acceptedStack.provider
      await acceptedStack.application.createEmptyDraft.execute({
        commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        trustedActor: actor(),
        payload: { targetMonth: '2026-04', focus: 'Accepted P02 draft' },
      })
      await acceptedStack.application.createGoalDefinition.execute({
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        trustedActor: actor(secondMemberId),
        payload: {
          title: 'Accepted P02 goal',
          why: 'Upgrade evidence',
          category: 'Test',
        },
      })
      await upgradeProvider.close(AbortSignal.timeout(2_000))
      upgradeProvider = undefined

      const snapshot = (): Promise<readonly { value: string }[]> =>
        upgrade
          .query<{ value: string }>(
            `
            SELECT value FROM (
              SELECT 'users:' || xmin || ':' || to_jsonb(row)::text value FROM users row
              UNION ALL SELECT 'spaces:' || xmin || ':' || to_jsonb(row)::text FROM spaces row
              UNION ALL SELECT 'memberships:' || xmin || ':' || to_jsonb(row)::text FROM memberships row
              UNION ALL SELECT 'plan_months:' || xmin || ':' || to_jsonb(row)::text FROM plan_months row
              UNION ALL SELECT 'plan_drafts:' || xmin || ':' || to_jsonb(row)::text FROM plan_drafts row
              UNION ALL SELECT 'command_receipts:' || xmin || ':' || to_jsonb(row)::text FROM command_receipts row
              UNION ALL SELECT 'planning_action_groups:' || xmin || ':' || to_jsonb(row)::text FROM planning_action_groups row
              UNION ALL SELECT 'planning_month_focus_changes:' || xmin || ':' || to_jsonb(row)::text FROM planning_month_focus_changes row
              UNION ALL SELECT 'goal_definitions:' || xmin || ':' || to_jsonb(row)::text FROM goal_definitions row
              UNION ALL SELECT 'goal_series:' || xmin || ':' || to_jsonb(row)::text FROM goal_series row
              UNION ALL SELECT 'goal_definition_versions:' || xmin || ':' || to_jsonb(row)::text FROM goal_definition_versions row
              UNION ALL SELECT 'planning_goal_catalog_changes:' || xmin || ':' || to_jsonb(row)::text FROM planning_goal_catalog_changes row
            ) accepted_rows ORDER BY value
          `,
          )
          .then(({ rows }) => rows)
      const before = await snapshot()
      const p03 = deployMigrations(databaseUrl)
      expect(p03).toMatchObject({ exitCode: 0 })
      await expect(snapshot()).resolves.toEqual(before)

      const migrations = await upgrade.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name',
      )
      expect(migrations.rows.map((row) => row.migration_name)).toEqual([
        '20260811090000_planner_foundation',
        '20260811100000_local_user_session',
        '20260811110000_pair_workspace',
        '20260811120000_telegram_external_identity',
        '20260811130000_plan_draft_kernel',
        '20260811140000_goal_catalog',
        '20260811150000_typed_draft_goals',
      ])
      const tables = await upgrade.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
         ORDER BY table_name
      `)
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'command_receipts',
        'goal_definition_versions',
        'goal_definitions',
        'goal_series',
        'memberships',
        'plan_draft_goal_revisions',
        'plan_draft_goals',
        'plan_drafts',
        'plan_months',
        'planning_action_groups',
        'planning_draft_goal_changes',
        'planning_goal_catalog_changes',
        'planning_month_focus_changes',
        'spaces',
        'telegram_access_allowlist',
        'telegram_external_identities',
        'users',
      ])
      await expect(
        upgrade.query(`
          SELECT (SELECT count(*) FROM plan_draft_goals)
               + (SELECT count(*) FROM plan_draft_goal_revisions)
               + (SELECT count(*) FROM planning_draft_goal_changes) count
        `),
      ).resolves.toMatchObject({ rows: [{ count: '0' }] })
      await expect(
        upgrade.query('UPDATE command_receipts SET result_kind = result_kind'),
      ).rejects.toThrow(/immutable/u)
      await expect(
        upgrade.query('UPDATE goal_definition_versions SET title = title'),
      ).rejects.toThrow(/immutable/u)
    } finally {
      await upgradeProvider
        ?.close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
      await upgrade.end()
      await accepted.cleanup()
    }
  })

  it('keeps the Prisma relation model aligned with the exact physical P03 foreign keys and partial indexes', async () => {
    const foreignKeys = await admin.query<{
      readonly table_name: string
      readonly constraint_name: string
      readonly source_columns: string[]
      readonly target_table: string
      readonly target_columns: string[]
      readonly update_action: string
      readonly delete_action: string
      readonly deferrable: boolean
      readonly deferred: boolean
    }>(`
      SELECT source.relname table_name, constraint_row.conname constraint_name,
             ARRAY(
               SELECT attribute.attname
                 FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum, ordinal)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = constraint_row.conrelid
                  AND attribute.attnum = key.attnum
                ORDER BY key.ordinal
             )::text[] source_columns,
             target.relname target_table,
             ARRAY(
               SELECT attribute.attname
                 FROM unnest(constraint_row.confkey) WITH ORDINALITY key(attnum, ordinal)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = constraint_row.confrelid
                  AND attribute.attnum = key.attnum
                ORDER BY key.ordinal
             )::text[] target_columns,
             constraint_row.confupdtype::text update_action,
             constraint_row.confdeltype::text delete_action,
             constraint_row.condeferrable deferrable,
             constraint_row.condeferred deferred
        FROM pg_constraint constraint_row
        JOIN pg_class source ON source.oid = constraint_row.conrelid
        JOIN pg_class target ON target.oid = constraint_row.confrelid
       WHERE constraint_row.contype = 'f'
         AND source.relname IN ('plan_draft_goals', 'plan_draft_goal_revisions')
       ORDER BY source.relname, constraint_row.conname
    `)
    expect(foreignKeys.rows).toEqual([
      {
        table_name: 'plan_draft_goal_revisions',
        constraint_name: 'plan_draft_goal_revisions_definition_series_fkey',
        source_columns: ['goal_definition_id', 'goal_series_id'],
        target_table: 'goal_series',
        target_columns: ['goal_definition_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
      {
        table_name: 'plan_draft_goal_revisions',
        constraint_name: 'plan_draft_goal_revisions_definition_version_fkey',
        source_columns: ['goal_definition_id', 'goal_definition_version_id'],
        target_table: 'goal_definition_versions',
        target_columns: ['goal_definition_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
      {
        table_name: 'plan_draft_goal_revisions',
        constraint_name: 'plan_draft_goal_revisions_goal_identity_fkey',
        source_columns: ['plan_goal_id', 'space_id', 'goal_definition_id'],
        target_table: 'plan_draft_goals',
        target_columns: ['id', 'space_id', 'goal_definition_id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
      {
        table_name: 'plan_draft_goal_revisions',
        constraint_name: 'plan_draft_goal_revisions_owner_fkey',
        source_columns: ['space_id', 'owner_member_id'],
        target_table: 'memberships',
        target_columns: ['space_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
      {
        table_name: 'plan_draft_goals',
        constraint_name: 'plan_draft_goals_current_revision_fkey',
        source_columns: ['id', 'current_revision_id'],
        target_table: 'plan_draft_goal_revisions',
        target_columns: ['plan_goal_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: true,
        deferred: true,
      },
      {
        table_name: 'plan_draft_goals',
        constraint_name: 'plan_draft_goals_definition_space_fkey',
        source_columns: ['space_id', 'goal_definition_id'],
        target_table: 'goal_definitions',
        target_columns: ['space_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
      {
        table_name: 'plan_draft_goals',
        constraint_name: 'plan_draft_goals_month_space_fkey',
        source_columns: ['space_id', 'plan_month_id'],
        target_table: 'plan_months',
        target_columns: ['space_id', 'id'],
        update_action: 'r',
        delete_action: 'r',
        deferrable: false,
        deferred: false,
      },
    ])

    const indexes = await admin.query<{
      readonly index_name: string
      readonly unique: boolean
      readonly columns: string[]
      readonly predicate: string | null
    }>(`
      SELECT index_class.relname index_name, index_row.indisunique unique,
             ARRAY(
               SELECT attribute.attname
                 FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY key(attnum, ordinal)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = index_row.indrelid
                  AND attribute.attnum = key.attnum
                ORDER BY key.ordinal
             )::text[] columns,
             pg_get_expr(index_row.indpred, index_row.indrelid) predicate
        FROM pg_index index_row
        JOIN pg_class table_class ON table_class.oid = index_row.indrelid
        JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
       WHERE table_class.relname = 'plan_draft_goals'
         AND (index_class.relname LIKE 'plan_draft_goals_active_%'
           OR index_class.relname = 'plan_draft_goals_editor_idx')
       ORDER BY index_class.relname
    `)
    expect(indexes.rows).toEqual([
      {
        index_name: 'plan_draft_goals_active_definition_key',
        unique: true,
        columns: ['plan_month_id', 'goal_definition_id'],
        predicate: '(detached_at IS NULL)',
      },
      {
        index_name: 'plan_draft_goals_active_order_key',
        unique: true,
        columns: ['plan_month_id', 'display_order'],
        predicate: '(detached_at IS NULL)',
      },
      {
        index_name: 'plan_draft_goals_editor_idx',
        unique: false,
        columns: ['plan_month_id', 'display_order', 'id'],
        predicate: '(detached_at IS NULL)',
      },
    ])

    const transitionIndexes = await admin.query<{
      readonly table_name: string
      readonly index_name: string
      readonly unique: boolean
      readonly columns: string[]
      readonly predicate: string | null
    }>(`
      SELECT table_class.relname table_name,
             index_class.relname index_name,
             index_row.indisunique unique,
             ARRAY(
               SELECT attribute.attname
                 FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY key(attnum, ordinal)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = index_row.indrelid
                  AND attribute.attnum = key.attnum
                ORDER BY key.ordinal
             )::text[] columns,
             pg_get_expr(index_row.indpred, index_row.indrelid) predicate
        FROM pg_index index_row
        JOIN pg_class table_class ON table_class.oid = index_row.indrelid
        JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
       WHERE index_class.relname IN (
         'planning_action_groups_month_after_revision_key',
         'planning_draft_goal_changes_after_revision_key'
       )
       ORDER BY table_class.relname, index_class.relname
    `)
    expect(transitionIndexes.rows).toEqual([
      {
        table_name: 'planning_action_groups',
        index_name: 'planning_action_groups_month_after_revision_key',
        unique: true,
        columns: ['plan_month_id', 'after_revision'],
        predicate: '(plan_month_id IS NOT NULL)',
      },
      {
        table_name: 'planning_draft_goal_changes',
        index_name: 'planning_draft_goal_changes_after_revision_key',
        unique: true,
        columns: ['after_revision_id'],
        predicate: '(after_revision_id IS NOT NULL)',
      },
    ])

    const schema = await readFile(
      resolve(process.cwd(), 'prisma', 'schema.prisma'),
      'utf8',
    )
    const model = (name: string): string => {
      const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, 'u').exec(
        schema,
      )
      if (match?.[1] === undefined) throw new Error(`missing model ${name}`)
      return match[1]
    }
    expect(model('Space')).not.toContain('planDraftGoals  PlanDraftGoal[]')
    expect(model('PlanDraftGoal')).not.toContain(
      'space           Space          @relation',
    )
    expect(model('PlanDraftGoal')).not.toContain(
      '@@index([planMonthId, displayOrder, id])',
    )
    expect(model('GoalDefinition')).not.toContain(
      'draftGoalRevisions PlanDraftGoalRevision[]',
    )
    expect(model('PlanDraftGoalRevision')).not.toContain(
      'goalDefinition      GoalDefinition @relation',
    )
  })

  it('adds, reads, updates, reorders and tombstones goals with stable revisions and series', async () => {
    const { planMonthId, definitionIds } = await seedDraftAndDefinitions(
      application,
      3,
    )
    let revision = 1n
    const planGoalIds: string[] = []
    for (const goalDefinitionId of definitionIds) {
      const result = await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        expectedRevision: revision,
        payload: {
          planMonthId,
          goalDefinitionId,
          config: goalConfig(),
          sourceProvenance: null,
        },
      })
      revision = result.aggregateRevision
      expect(result).toEqual({
        kind: 'planning.plan-draft.v1',
        aggregateId: planMonthId,
        aggregateRevision: revision,
      })
      const view = await application.getDraftEditor.execute({
        trustedActor: actor(),
        targetMonth: '2026-04',
      })
      planGoalIds.push(view!.goals.at(-1)!.planGoalId)
    }

    const before = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(before?.draftRevision).toBe(4n)
    expect(before?.goals.map((goal) => goal.displayOrder)).toEqual([0, 1, 2])
    expect(before?.blockers).toEqual([])
    const stableIds = (
      before?.goals[0]?.config.measurement.kind === 'checklist'
        ? before.goals[0].config.measurement.items
        : []
    ).map((item) => item.itemId)

    const update = await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 4n,
      payload: {
        planMonthId,
        planGoalId: planGoalIds[0]!,
        goalDefinitionVersionId: before!.goals[0]!.goalDefinitionVersionId,
        config: {
          ...before!.goals[0]!.config,
          repetition: { kind: 'weekly', n: '3' },
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: stableIds[0]!, label: 'Вода renamed' },
              { itemId: stableIds[1]!, label: 'Сон' },
            ],
          },
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'monthly-plan-template',
          sourcePage: 1,
          rawValue: '2–3',
          rawDenominator: null,
          resolution: 'N=3',
        },
      },
    })
    expect(update.aggregateRevision).toBe(5n)
    const compatible = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(compatible!.goals[0]!.goalSeriesId).toBe(
      before!.goals[0]!.goalSeriesId,
    )
    expect(
      compatible!.goals[0]!.config.measurement.kind === 'checklist'
        ? compatible!.goals[0]!.config.measurement.items.map(
            (item) => item.itemId,
          )
        : [],
    ).toEqual(stableIds)

    await application.reorderDraftGoals.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 5n,
      payload: {
        planMonthId,
        orderedPlanGoalIds: [planGoalIds[2]!, planGoalIds[0]!, planGoalIds[1]!],
      },
    })
    const reordered = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(reordered?.goals.map((goal) => goal.planGoalId)).toEqual([
      planGoalIds[2],
      planGoalIds[0],
      planGoalIds[1],
    ])

    await application.removeDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 6n,
      payload: { planMonthId, planGoalId: planGoalIds[0]! },
    })
    const removed = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(removed?.draftRevision).toBe(7n)
    expect(removed?.goals.map((goal) => goal.planGoalId)).toEqual([
      planGoalIds[2],
      planGoalIds[1],
    ])

    const { rows } = await admin.query<{
      action_kind: string
      detail_count: number
      before_order: string[]
      after_order: string[]
    }>(`
      SELECT action.action_kind, count(detail.action_id)::int AS detail_count,
             detail.before_order, detail.after_order
        FROM planning_action_groups action
        LEFT JOIN planning_draft_goal_changes detail ON detail.action_id = action.id
       WHERE action.action_kind LIKE 'draft_goal%'
       GROUP BY action.id, action.action_kind, action.after_revision,
                detail.before_order, detail.after_order
       ORDER BY action.after_revision
    `)
    expect(rows.map((row) => [row.action_kind, row.detail_count])).toEqual([
      ['draft_goal_added', 1],
      ['draft_goal_added', 1],
      ['draft_goal_added', 1],
      ['draft_goal_updated', 1],
      ['draft_goals_reordered', 1],
      ['draft_goal_removed', 1],
    ])
    expect(rows[4]).toMatchObject({
      action_kind: 'draft_goals_reordered',
      before_order: planGoalIds,
      after_order: [planGoalIds[2], planGoalIds[0], planGoalIds[1]],
    })
    expect(rows[5]).toMatchObject({
      action_kind: 'draft_goal_removed',
      before_order: [planGoalIds[2], planGoalIds[0], planGoalIds[1]],
      after_order: [planGoalIds[2], planGoalIds[1]],
    })
  })

  it('keeps an effective typed series across compatible source versions and only lets a new catalog series override it', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    let view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const initial = view!.goals[0]!

    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId,
        planGoalId: initial.planGoalId,
        goalDefinitionVersionId: initial.goalDefinitionVersionId,
        config: { ...initial.config, scope: { kind: 'shared' } },
        sourceProvenance: null,
      },
    })
    view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const secondSeriesId = view!.goals[0]!.goalSeriesId
    expect(secondSeriesId).not.toBe(initial.goalSeriesId)

    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 3n,
      payload: {
        planMonthId,
        planGoalId: initial.planGoalId,
        goalDefinitionVersionId: initial.goalDefinitionVersionId,
        config: {
          ...view!.goals[0]!.config,
          repetition: { kind: 'weekly', n: '2' },
        },
        sourceProvenance: null,
      },
    })
    view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(view!.goals[0]!.goalSeriesId).toBe(secondSeriesId)

    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 4n,
      payload: {
        planMonthId,
        planGoalId: initial.planGoalId,
        goalDefinitionVersionId: initial.goalDefinitionVersionId,
        config: {
          ...view!.goals[0]!.config,
          measurement: { kind: 'boolean' },
        },
        sourceProvenance: null,
      },
    })
    view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const thirdSeriesId = view!.goals[0]!.goalSeriesId
    expect(thirdSeriesId).not.toBe(secondSeriesId)

    await application.createGoalDefinitionVersion.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        goalDefinitionId: definitionIds[0]!,
        title: 'Compatible metadata',
        why: 'Explicit P02 continued series',
        category: 'Test',
        seriesDecision: 'continue',
      },
    })
    let definition = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: definitionIds[0]!,
    })
    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 5n,
      payload: {
        planMonthId,
        planGoalId: initial.planGoalId,
        goalDefinitionVersionId:
          definition!.currentVersion.goalDefinitionVersionId,
        config: view!.goals[0]!.config,
        sourceProvenance: null,
      },
    })
    view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(view!.goals[0]!.goalSeriesId).toBe(thirdSeriesId)

    await application.createGoalDefinitionVersion.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        goalDefinitionId: definitionIds[0]!,
        title: 'New metadata meaning',
        why: 'Explicit P02 new series',
        category: 'Test',
        seriesDecision: 'new',
      },
    })
    definition = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: definitionIds[0]!,
    })
    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 6n,
      payload: {
        planMonthId,
        planGoalId: initial.planGoalId,
        goalDefinitionVersionId:
          definition!.currentVersion.goalDefinitionVersionId,
        config: view!.goals[0]!.config,
        sourceProvenance: null,
      },
    })
    const afterNewVersion = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(afterNewVersion!.goals[0]!.goalSeriesId).toBe(
      definition!.currentVersion.goalSeriesId,
    )
  })

  it('replays exactly, rejects fingerprint reuse and leaves stale/invalid commands at zero writes', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    const commandId = randomUUID()
    const command = {
      commandId,
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    } as const
    const first = await application.addDraftGoal.execute(command)
    const secondStack = await stack(
      container.getConnectionUri(),
      new FakeProductClock(new Date('2030-01-01T00:00:00Z')),
    )
    try {
      await expect(
        secondStack.application.addDraftGoal.execute(command),
      ).resolves.toEqual(first)
      await expect(
        secondStack.application.addDraftGoal.execute({
          ...command,
          payload: {
            ...command.payload,
            sourceProvenance: {
              schemaVersion: 1,
              sourceDocument: 'x',
              sourcePage: 1,
              rawValue: null,
              rawDenominator: null,
              resolution: 'different fingerprint',
            },
          },
        }),
      ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
      await expect(
        application.removeDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId,
            planGoalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
      ).rejects.toBeInstanceOf(DraftRevisionConflictError)
    } finally {
      await secondStack.provider.close(AbortSignal.timeout(2_000))
    }
    const { rows } = await admin.query<{
      goals: number
      revisions: number
      changes: number
      receipts: number
    }>(`
      SELECT (SELECT count(*)::int FROM plan_draft_goals) goals,
             (SELECT count(*)::int FROM plan_draft_goal_revisions) revisions,
             (SELECT count(*)::int FROM planning_draft_goal_changes) changes,
             (SELECT count(*)::int FROM command_receipts
               WHERE command_type LIKE 'planning.%draft-goal%') receipts
    `)
    expect(rows[0]).toEqual({ goals: 1, revisions: 1, changes: 1, receipts: 1 })
  })

  it('rejects checkpoint targets beyond the parent quantity precision before any write', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    const before = await admin.query<{ readonly value: string }>(`
      SELECT concat_ws(':', draft.revision,
        (SELECT count(*) FROM plan_draft_goals),
        (SELECT count(*) FROM plan_draft_goal_revisions),
        (SELECT count(*) FROM planning_action_groups),
        (SELECT count(*) FROM command_receipts)) value
        FROM plan_drafts draft WHERE draft.plan_month_id = '${planMonthId}'
    `)

    await expect(
      Promise.resolve().then(() =>
        application.addDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId,
            goalDefinitionId: definitionIds[0]!,
            config: {
              schemaVersion: 1,
              scope: { kind: 'shared' },
              repetition: { kind: 'daily' },
              measurement: {
                kind: 'quantity',
                mode: 'targeted',
                unit: 'л',
                precision: 0,
                aggregation: 'add',
                target: '2',
              },
              checkpoints: {
                aggregation: 'independent',
                items: [
                  {
                    checkpointId: null,
                    name: 'Утро',
                    deadline: '12:00',
                    satisfaction: { kind: 'quantity', target: '1.5' },
                  },
                ],
              },
            },
            sourceProvenance: null,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(CommandValidationError)

    await expect(
      admin.query<{ readonly value: string }>(`
        SELECT concat_ws(':', draft.revision,
          (SELECT count(*) FROM plan_draft_goals),
          (SELECT count(*) FROM plan_draft_goal_revisions),
          (SELECT count(*) FROM planning_action_groups),
          (SELECT count(*) FROM command_receipts)) value
          FROM plan_drafts draft WHERE draft.plan_month_id = '${planMonthId}'
      `),
    ).resolves.toEqual(before)
  })

  it('maps duplicate active goal definitions to finite validation with zero writes', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const before = await admin.query<{ readonly value: string }>(`
      SELECT concat_ws(':', draft.revision,
        (SELECT count(*) FROM plan_draft_goals),
        (SELECT count(*) FROM plan_draft_goal_revisions),
        (SELECT count(*) FROM planning_action_groups),
        (SELECT count(*) FROM command_receipts)) value
        FROM plan_drafts draft WHERE draft.plan_month_id = '${planMonthId}'
    `)

    await expect(
      application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: {
          planMonthId,
          goalDefinitionId: definitionIds[0]!,
          config: goalConfig(),
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeInstanceOf(CommandValidationError)

    await expect(
      admin.query<{ readonly value: string }>(`
        SELECT concat_ws(':', draft.revision,
          (SELECT count(*) FROM plan_draft_goals),
          (SELECT count(*) FROM plan_draft_goal_revisions),
          (SELECT count(*) FROM planning_action_groups),
          (SELECT count(*) FROM command_receipts)) value
          FROM plan_drafts draft WHERE draft.plan_month_id = '${planMonthId}'
      `),
    ).resolves.toEqual(before)
  })

  it('rolls back root pointer, revision, new series, history and draft revision when receipt insertion fails, then retries', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const goal = view!.goals[0]!
    const state = (): Promise<readonly { value: string }[]> =>
      admin
        .query<{ value: string }>(
          `
          SELECT value FROM (
            SELECT 'draft:' || revision || ':' || xmin value FROM plan_drafts
             WHERE plan_month_id = '${planMonthId}'
            UNION ALL SELECT 'root:' || id || ':' || current_revision_id || ':' || xmin
              FROM plan_draft_goals WHERE plan_month_id = '${planMonthId}'
            UNION ALL SELECT 'revision:' || id || ':' || revision_number || ':' || goal_series_id || ':' || xmin
              FROM plan_draft_goal_revisions
            UNION ALL SELECT 'series:' || id || ':' || xmin FROM goal_series
            UNION ALL SELECT 'action:' || id || ':' || action_kind || ':' || xmin
              FROM planning_action_groups
            UNION ALL SELECT 'change:' || action_id || ':' || xmin
              FROM planning_draft_goal_changes
            UNION ALL SELECT 'receipt:' || command_type || ':' || command_id || ':' || xmin
              FROM command_receipts
          ) transaction_state ORDER BY value
        `,
        )
        .then(({ rows }) => rows)
    const before = await state()
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await admin.query(`
      CREATE FUNCTION p03_fail_selected_receipt() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.command_id = '${commandId}'::uuid THEN
          RAISE EXCEPTION 'p03 injected receipt failure' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER p03_fail_selected_receipt
        BEFORE INSERT ON command_receipts
        FOR EACH ROW EXECUTE FUNCTION p03_fail_selected_receipt();
    `)
    const command = {
      commandId,
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId,
        planGoalId: goal.planGoalId,
        goalDefinitionVersionId: goal.goalDefinitionVersionId,
        config: { ...goal.config, scope: { kind: 'shared' as const } },
        sourceProvenance: null,
      },
    } as const
    try {
      await expect(
        application.updateDraftGoal.execute(command),
      ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
      await expect(state()).resolves.toEqual(before)
    } finally {
      await admin.query(`
        DROP TRIGGER IF EXISTS p03_fail_selected_receipt ON command_receipts;
        DROP FUNCTION IF EXISTS p03_fail_selected_receipt();
      `)
    }
    await expect(application.updateDraftGoal.execute(command)).resolves.toEqual(
      {
        kind: 'planning.plan-draft.v1',
        aggregateId: planMonthId,
        aggregateRevision: 3n,
      },
    )
    const after = await admin.query<{
      draft_revision: string
      roots: number
      revisions: number
      series: number
      changes: number
      receipts: number
    }>(`
      SELECT (SELECT revision::text FROM plan_drafts
               WHERE plan_month_id = '${planMonthId}') draft_revision,
             (SELECT count(*)::int FROM plan_draft_goals) roots,
             (SELECT count(*)::int FROM plan_draft_goal_revisions) revisions,
             (SELECT count(*)::int FROM goal_series) series,
             (SELECT count(*)::int FROM planning_draft_goal_changes) changes,
             (SELECT count(*)::int FROM command_receipts) receipts
    `)
    expect(after.rows[0]).toEqual({
      draft_revision: '3',
      roots: 1,
      revisions: 2,
      series: 2,
      changes: 2,
      receipts: 4,
    })
  })

  it('serializes independent CAS races and rejects non-permutation reorder atomically', async () => {
    const { planMonthId, definitionIds } = await seedDraftAndDefinitions(
      application,
      2,
    )
    const [first, second] = await Promise.allSettled(
      definitionIds.map((goalDefinitionId) =>
        application.addDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId,
            goalDefinitionId,
            config: goalConfig(),
            sourceProvenance: null,
          },
        }),
      ),
    )
    expect([first!.status, second!.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    const view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    await expect(
      application.reorderDraftGoals.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: {
          planMonthId,
          orderedPlanGoalIds: [
            view!.goals[0]!.planGoalId,
            view!.goals[0]!.planGoalId,
          ],
        },
      }),
    ).rejects.toBeInstanceOf(DraftGoalNotFoundError)
    const unchanged = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(unchanged?.draftRevision).toBe(2n)
  })

  it('gives both pair members equal rights while every untrusted, foreign and non-draft path stays read/write inert', async () => {
    const { planMonthId, definitionIds } = await seedDraftAndDefinitions(
      application,
      2,
    )
    await expect(
      application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(secondMemberId),
        expectedRevision: 1n,
        payload: {
          planMonthId,
          goalDefinitionId: definitionIds[0]!,
          config: goalConfig(secondMemberId),
          sourceProvenance: null,
        },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 2n })
    const firstView = await application.getDraftEditor.execute({
      trustedActor: actor(firstMemberId),
      targetMonth: '2026-04',
    })
    const secondView = await application.getDraftEditor.execute({
      trustedActor: actor(secondMemberId),
      targetMonth: '2026-04',
    })
    expect(secondView).toEqual(firstView)
    const goal = firstView!.goals[0]!
    const otherDefinition = await application.getGoalDefinition.execute({
      trustedActor: actor(),
      goalDefinitionId: definitionIds[1]!,
    })
    const state = (): Promise<readonly { value: string }[]> =>
      admin
        .query<{ value: string }>(
          `
          SELECT value FROM (
            SELECT 'draft:' || xmin || ':' || to_jsonb(row)::text value
              FROM plan_drafts row
            UNION ALL SELECT 'root:' || xmin || ':' || to_jsonb(row)::text
              FROM plan_draft_goals row
            UNION ALL SELECT 'revision:' || xmin || ':' || to_jsonb(row)::text
              FROM plan_draft_goal_revisions row
            UNION ALL SELECT 'series:' || xmin || ':' || to_jsonb(row)::text
              FROM goal_series row
            UNION ALL SELECT 'action:' || xmin || ':' || to_jsonb(row)::text
              FROM planning_action_groups row
            UNION ALL SELECT 'change:' || xmin || ':' || to_jsonb(row)::text
              FROM planning_draft_goal_changes row
            UNION ALL SELECT 'receipt:' || xmin || ':' || to_jsonb(row)::text
              FROM command_receipts row
          ) protected_state ORDER BY value
        `,
        )
        .then(({ rows }) => rows)
    const before = await state()
    for (const trustedActor of [
      { kind: 'system' as const, id: 'planner-worker' as const },
      actor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ]) {
      await expect(
        application.removeDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor,
          expectedRevision: 2n,
          payload: { planMonthId, planGoalId: goal.planGoalId },
        }),
      ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
      await expect(
        application.getDraftEditor.execute({
          trustedActor,
          targetMonth: '2026-04',
        }),
      ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    }
    await expect(
      application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: {
          planMonthId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          goalDefinitionId: definitionIds[1]!,
          config: goalConfig(),
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeInstanceOf(PlanDraftNotFoundError)
    await expect(
      application.updateDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: {
          planMonthId,
          planGoalId: goal.planGoalId,
          goalDefinitionVersionId:
            otherDefinition!.currentVersion.goalDefinitionVersionId,
          config: goal.config,
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeInstanceOf(GoalDefinitionVersionNotFoundError)
    await expect(state()).resolves.toEqual(before)

    for (const status of ['published', 'grace', 'closed'] as const) {
      await admin.query(
        `UPDATE plan_months SET status = $1 WHERE id = $2::uuid`,
        [status, planMonthId],
      )
      const statusBefore = await state()
      await expect(
        application.removeDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(secondMemberId),
          expectedRevision: 2n,
          payload: { planMonthId, planGoalId: goal.planGoalId },
        }),
      ).rejects.toBeInstanceOf(PlanDraftNotEditableError)
      await expect(
        application.getDraftEditor.execute({
          trustedActor: actor(),
          targetMonth: '2026-04',
        }),
      ).rejects.toBeInstanceOf(PlanDraftNotEditableError)
      await expect(state()).resolves.toEqual(statusBefore)
    }
  })

  it('accepts exactly 200 active goals and rejects the 201st as structural validation with zero writes', async () => {
    const { planMonthId } = await seedDraftAndDefinitions(application, 0)
    const candidateDefinitionId = await seedActiveGoalLimit(admin, planMonthId)
    const before = await admin.query<{
      draft_revision: string
      roots: number
      revisions: number
      changes: number
      receipts: number
    }>(`
      SELECT (SELECT revision::text FROM plan_drafts
               WHERE plan_month_id = '${planMonthId}') draft_revision,
             (SELECT count(*)::int FROM plan_draft_goals
               WHERE detached_at IS NULL) roots,
             (SELECT count(*)::int FROM plan_draft_goal_revisions) revisions,
             (SELECT count(*)::int FROM planning_draft_goal_changes) changes,
             (SELECT count(*)::int FROM command_receipts) receipts
    `)
    expect(before.rows[0]).toMatchObject({
      draft_revision: '1',
      roots: 200,
      revisions: 200,
    })
    await expect(
      application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: {
          planMonthId,
          goalDefinitionId: candidateDefinitionId,
          config: goalConfig(),
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeInstanceOf(CommandValidationError)
    await expect(
      admin.query(`
        SELECT (SELECT revision::text FROM plan_drafts
                 WHERE plan_month_id = '${planMonthId}') draft_revision,
               (SELECT count(*)::int FROM plan_draft_goals
                 WHERE detached_at IS NULL) roots,
               (SELECT count(*)::int FROM plan_draft_goal_revisions) revisions,
               (SELECT count(*)::int FROM planning_draft_goal_changes) changes,
               (SELECT count(*)::int FROM command_receipts) receipts
      `),
    ).resolves.toMatchObject({ rows: [before.rows[0]] })
  })

  it('rejects direct committed active-order gaps and a 201st root with SQLSTATE 23514', async () => {
    const { planMonthId } = await seedDraftAndDefinitions(application, 0)
    const candidateDefinitionId = await seedActiveGoalLimit(admin, planMonthId)
    const gap = await admin.connect()
    try {
      await gap.query('BEGIN')
      await gap.query(`
        UPDATE plan_draft_goals SET display_order = 399
         WHERE plan_month_id = '${planMonthId}'
           AND display_order = 199 AND detached_at IS NULL
      `)
      await expect(gap.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await gap.query('ROLLBACK').catch(() => undefined)
      gap.release()
    }

    const candidate = (
      await admin.query<{ version_id: string; series_id: string }>(`
        SELECT version.id::text version_id,
               version.goal_series_id::text series_id
          FROM goal_definition_versions version
         WHERE version.goal_definition_id = '${candidateDefinitionId}'
      `)
    ).rows[0]!
    const rootId = randomUUID()
    const revisionId = randomUUID()
    const overflow = await admin.connect()
    try {
      await overflow.query('BEGIN')
      await overflow.query(
        `INSERT INTO plan_draft_goals
          (id, space_id, plan_month_id, goal_definition_id, display_order,
           current_revision_id, attached_at, detached_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 200, NULL,
                 now(), NULL, now(), now())`,
        [rootId, spaceId, planMonthId, candidateDefinitionId],
      )
      await overflow.query(
        `INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config, source_provenance, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::uuid,
                 $6::uuid, 'personal', $7::uuid, $8::jsonb, NULL, now())`,
        [
          revisionId,
          rootId,
          spaceId,
          candidateDefinitionId,
          candidate.version_id,
          candidate.series_id,
          firstMemberId,
          JSON.stringify(goalConfig()),
        ],
      )
      await overflow.query(
        'UPDATE plan_draft_goals SET current_revision_id = $1::uuid WHERE id = $2::uuid',
        [revisionId, rootId],
      )
      await expect(overflow.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await overflow.query('ROLLBACK').catch(() => undefined)
      overflow.release()
    }
    await expect(
      admin.query(
        `SELECT count(*)::int count FROM plan_draft_goals
          WHERE plan_month_id = $1::uuid AND detached_at IS NULL`,
        [planMonthId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 200 }] })
  })

  it('projects the editor revision and ordered goals in exactly one database statement', async () => {
    let clientScopes = 0
    let queryCount = 0
    const fakeClient = {
      $queryRaw: (): Promise<readonly object[]> => {
        queryCount += 1
        if (queryCount !== 1) throw new Error('mixed snapshot query attempted')
        return Promise.resolve([
          {
            plan_month_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            space_id: spaceId,
            target_month: '2026-04',
            status: 'draft',
            focus: 'Single statement snapshot',
            plan_month_revision: 7n,
            draft_revision: 11n,
            goals: [],
          },
        ])
      },
    }
    const fakeDatabase = {
      withClient: async (
        operation: (client: typeof fakeClient) => Promise<unknown>,
      ): Promise<unknown> => {
        clientScopes += 1
        return operation(fakeClient)
      },
    } as unknown as PrismaClientProvider
    const persistence = new PrismaDraftGoalPersistence(fakeDatabase)

    await expect(
      persistence.findEditor(spaceId, '2026-04'),
    ).resolves.toMatchObject({
      planMonthRevision: 7n,
      draftRevision: 11n,
      goals: [],
      blockers: [],
    })
    expect({ clientScopes, queryCount }).toEqual({
      clientScopes: 1,
      queryCount: 1,
    })
  })

  it('enforces immutable revisions/history, no delete, active uniqueness and re-add identity', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const before = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    await expect(
      application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: 2n,
        payload: {
          planMonthId,
          goalDefinitionId: definitionIds[0]!,
          config: goalConfig(),
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeDefined()
    await application.removeDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: { planMonthId, planGoalId: before!.goals[0]!.planGoalId },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 3n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const after = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    expect(after!.goals[0]!.planGoalId).not.toBe(before!.goals[0]!.planGoalId)
    expect(
      after!.goals[0]!.config.measurement.kind === 'checklist'
        ? after!.goals[0]!.config.measurement.items.map((item) => item.itemId)
        : [],
    ).not.toEqual(
      before!.goals[0]!.config.measurement.kind === 'checklist'
        ? before!.goals[0]!.config.measurement.items.map((item) => item.itemId)
        : [],
    )

    const revisionId = (
      await admin.query<{ id: string }>(
        'SELECT id::text FROM plan_draft_goal_revisions LIMIT 1',
      )
    ).rows[0]!.id
    await expect(
      admin.query(
        `UPDATE plan_draft_goal_revisions SET config = config WHERE id = '${revisionId}'`,
      ),
    ).rejects.toBeDefined()
    await expect(
      admin.query(
        `DELETE FROM plan_draft_goals WHERE id = '${before!.goals[0]!.planGoalId}'`,
      ),
    ).rejects.toBeDefined()
  })

  it('rejects forged, cross-family and removed child IDs under the locked transaction with zero writes', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    const addCommandId = randomUUID()
    await application.addDraftGoal.execute({
      commandId: addCommandId,
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    let view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const goal = view!.goals[0]!
    if (goal.config.measurement.kind !== 'checklist') throw new Error('fixture')
    const [firstId, removedId] = goal.config.measurement.items.map(
      (item) => item.itemId!,
    )
    if (firstId === undefined || removedId === undefined)
      throw new Error('fixture')
    const counts = (): Promise<
      { readonly revisions: number; readonly receipts: number } | undefined
    > =>
      admin
        .query<{ revisions: number; receipts: number }>(
          `
          SELECT (SELECT count(*)::int FROM plan_draft_goal_revisions) revisions,
                 (SELECT count(*)::int FROM command_receipts
                   WHERE command_type = 'planning.update-draft-goal.v1') receipts
        `,
        )
        .then(({ rows }) => rows[0])
    const before = await counts()
    for (const measurement of [
      {
        kind: 'checklist',
        items: [
          {
            itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            label: 'forged',
          },
        ],
      },
      {
        kind: 'any_of',
        variants: [
          {
            variantId: firstId,
            label: 'cross-family',
            unit: 'раз',
            precision: 0,
            target: '1',
          },
        ],
      },
    ] as const) {
      await expect(
        application.updateDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 2n,
          payload: {
            planMonthId,
            planGoalId: goal.planGoalId,
            goalDefinitionVersionId: goal.goalDefinitionVersionId,
            config: { ...goal.config, measurement },
            sourceProvenance: null,
          },
        }),
      ).rejects.toBeInstanceOf(CommandValidationError)
    }
    expect(await counts()).toEqual(before)

    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId,
        planGoalId: goal.planGoalId,
        goalDefinitionVersionId: goal.goalDefinitionVersionId,
        config: {
          ...goal.config,
          measurement: {
            kind: 'checklist',
            items: [{ itemId: firstId, label: 'only survivor' }],
          },
        },
        sourceProvenance: null,
      },
    })
    view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const current = view!.goals[0]!
    const afterRemoval = await counts()
    await expect(
      application.updateDraftGoal.execute({
        // Command IDs are scoped by command type, so reusing the add UUID here
        // proves a tombstoned generated child ID cannot be resurrected.
        commandId: addCommandId,
        trustedActor: actor(),
        expectedRevision: 3n,
        payload: {
          planMonthId,
          planGoalId: current.planGoalId,
          goalDefinitionVersionId: current.goalDefinitionVersionId,
          config: {
            ...current.config,
            measurement: {
              kind: 'checklist',
              items: [
                { itemId: firstId, label: 'survivor' },
                { itemId: removedId, label: 'reused removed ID' },
              ],
            },
          },
          sourceProvenance: null,
        },
      }),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect(await counts()).toEqual(afterRemoval)
  })

  it('database closes JSON scope/FK, required-current, dense revisions and pointer rollback escapes', async () => {
    const { planMonthId, definitionIds } =
      await seedDraftAndDefinitions(application)
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const view = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const goal = view!.goals[0]!
    const row = (
      await admin.query<{
        space_id: string
        definition_id: string
        version_id: string
        series_id: string
        current_revision_id: string
      }>(`
        SELECT root.space_id::text, root.goal_definition_id::text definition_id,
               revision.goal_definition_version_id::text version_id,
               revision.goal_series_id::text series_id,
               root.current_revision_id::text
          FROM plan_draft_goals root
          JOIN plan_draft_goal_revisions revision
            ON revision.id = root.current_revision_id
         WHERE root.id = '${goal.planGoalId}'
      `)
    ).rows[0]!

    const missingCurrent = await admin.connect()
    try {
      await missingCurrent.query('BEGIN')
      await missingCurrent.query(`
        INSERT INTO plan_draft_goals
          (id, space_id, plan_month_id, goal_definition_id, display_order,
           current_revision_id, attached_at, detached_at, created_at, updated_at)
        VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${spaceId}',
                '${planMonthId}', '${definitionIds[0]}', 20, NULL, now(), now(),
                now(), now())
      `)
      await expect(missingCurrent.query('COMMIT')).rejects.toThrow(
        /current_revision_required/u,
      )
    } finally {
      await missingCurrent.query('ROLLBACK').catch(() => undefined)
      missingCurrent.release()
    }

    for (const badConfig of [
      '{}',
      JSON.stringify({
        ...goal.config,
        scope: {
          kind: 'personal',
          ownerMemberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      }),
    ]) {
      await expect(
        admin.query(`
          INSERT INTO plan_draft_goal_revisions
            (id, plan_goal_id, space_id, goal_definition_id, revision_number,
             goal_definition_version_id, goal_series_id, scope_kind,
             owner_member_id, config, source_provenance, created_at)
          VALUES (gen_random_uuid(), '${goal.planGoalId}', '${row.space_id}',
                  '${row.definition_id}', 9, '${row.version_id}',
                  '${row.series_id}', 'personal',
                  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  '${badConfig}'::jsonb, NULL, now())
        `),
      ).rejects.toBeDefined()
    }

    const gap = await admin.connect()
    try {
      await gap.query('BEGIN')
      await gap.query(`
        INSERT INTO plan_draft_goal_revisions
          (id, plan_goal_id, space_id, goal_definition_id, revision_number,
           goal_definition_version_id, goal_series_id, scope_kind,
           owner_member_id, config, source_provenance, created_at)
        VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${goal.planGoalId}',
                '${row.space_id}', '${row.definition_id}', 3,
                '${row.version_id}', '${row.series_id}', 'personal',
                '${firstMemberId}', '${JSON.stringify(goal.config)}'::jsonb,
                NULL, now())
      `)
      await expect(gap.query('COMMIT')).rejects.toThrow(
        /current_revision_mismatch/u,
      )
    } finally {
      await gap.query('ROLLBACK').catch(() => undefined)
      gap.release()
    }

    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId,
        planGoalId: goal.planGoalId,
        goalDefinitionVersionId: goal.goalDefinitionVersionId,
        config: goal.config,
        sourceProvenance: null,
      },
    })
    const rollbackPointer = await admin.connect()
    try {
      await rollbackPointer.query('BEGIN')
      await rollbackPointer.query(`
        UPDATE plan_draft_goals
           SET current_revision_id = '${row.current_revision_id}'
         WHERE id = '${goal.planGoalId}'
      `)
      await expect(rollbackPointer.query('COMMIT')).rejects.toThrow(
        /current_revision_mismatch/u,
      )
    } finally {
      await rollbackPointer.query('ROLLBACK').catch(() => undefined)
      rollbackPointer.release()
    }
  })

  it('rejects missing JSON shapes and nullable, arbitrary, subset or wrong-month history arrays with SQLSTATE 23514', async () => {
    const { planMonthId, definitionIds } = await seedDraftAndDefinitions(
      application,
      2,
    )
    let revision = 1n
    for (const goalDefinitionId of definitionIds) {
      const result = await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: revision,
        payload: {
          planMonthId,
          goalDefinitionId,
          config: goalConfig(),
          sourceProvenance: null,
        },
      })
      revision = result.aggregateRevision
    }
    const april = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const firstGoal = april!.goals[0]!
    const revisionError = async (
      configValue: object,
      provenanceValue: object | null,
    ): Promise<unknown> => {
      const client = await admin.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query(
            `INSERT INTO plan_draft_goal_revisions
              (id, plan_goal_id, space_id, goal_definition_id, revision_number,
               goal_definition_version_id, goal_series_id, scope_kind,
               owner_member_id, config, source_provenance, created_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, $5::uuid,
                     $6::uuid, 'shared', NULL, $7::jsonb, $8::jsonb, now())`,
            [
              randomUUID(),
              firstGoal.planGoalId,
              spaceId,
              firstGoal.goalDefinitionId,
              firstGoal.goalDefinitionVersionId,
              firstGoal.goalSeriesId,
              JSON.stringify(configValue),
              provenanceValue === null ? null : JSON.stringify(provenanceValue),
            ],
          )
          return null
        } catch (error: unknown) {
          return error
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }
    await expect(
      revisionError({ schemaVersion: 1, scope: { kind: 'shared' } }, null),
    ).resolves.toMatchObject({
      code: '23514',
      constraint: 'plan_draft_goal_revisions_config_object_check',
    })
    await expect(
      revisionError(
        { ...firstGoal.config, scope: { kind: 'shared' } },
        { schemaVersion: 1 },
      ),
    ).resolves.toMatchObject({
      code: '23514',
      constraint: 'plan_draft_goal_revisions_provenance_object_check',
    })

    const may = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-05', focus: 'Wrong-month history probe' },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: may.aggregateId,
        goalDefinitionId: definitionIds[0]!,
        config: goalConfig(),
        sourceProvenance: null,
      },
    })
    const mayView = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-05',
    })
    const activeOrder = april!.goals.map((goal) => goal.planGoalId)
    const historyError = async (
      beforeOrder: readonly string[] | null,
      afterOrder: readonly string[] | null,
    ): Promise<unknown> => {
      const client = await admin.connect()
      const actionId = randomUUID()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO planning_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id,
             system_actor_id, plan_month_id, goal_definition_id, command_type,
             command_id, before_revision, after_revision, occurred_at)
           VALUES ($1::uuid, 'draft_goals_reordered', 'member', $2, $3::uuid,
                   NULL, $4::uuid, NULL, 'planning.reorder-draft-goals.v1',
                   $5::uuid, 3, 4, now())`,
          [
            actionId,
            `member:${firstMemberId}`,
            firstMemberId,
            planMonthId,
            randomUUID(),
          ],
        )
        try {
          await client.query(
            `INSERT INTO planning_draft_goal_changes
              (action_id, plan_goal_id, before_revision_id, after_revision_id,
               reordered_goal_count, before_order, after_order)
             VALUES ($1::uuid, NULL, NULL, NULL, $2, $3::uuid[], $4::uuid[])`,
            [
              actionId,
              beforeOrder?.length ?? afterOrder?.length ?? 0,
              beforeOrder,
              afterOrder,
            ],
          )
          return null
        } catch (error: unknown) {
          return error
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }
    const malformedOrders: readonly [
      readonly string[] | null,
      readonly string[] | null,
    ][] = [
      [null, activeOrder],
      [[activeOrder[0]!], [activeOrder[0]!]],
      [[activeOrder[0]!, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], activeOrder],
      [
        [activeOrder[0]!, mayView!.goals[0]!.planGoalId],
        [activeOrder[0]!, mayView!.goals[0]!.planGoalId],
      ],
    ]
    for (const [beforeOrder, afterOrder] of malformedOrders) {
      await expect(
        historyError(beforeOrder, afterOrder),
      ).resolves.toMatchObject({ code: '23514' })
    }
  })

  it('rejects old, backward and nonconsecutive typed history plus unrelated aggregates and false before-order evidence', async () => {
    const { planMonthId, definitionIds } = await seedDraftAndDefinitions(
      application,
      2,
    )
    let draftRevision = 1n
    for (const goalDefinitionId of definitionIds) {
      const added = await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: draftRevision,
        payload: {
          planMonthId,
          goalDefinitionId,
          config: goalConfig(),
          sourceProvenance: null,
        },
      })
      draftRevision = added.aggregateRevision
    }
    let editor = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const firstGoal = editor!.goals[0]!
    for (const label of ['revision two', 'revision three']) {
      const updated = await application.updateDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: draftRevision,
        payload: {
          planMonthId,
          planGoalId: firstGoal.planGoalId,
          goalDefinitionVersionId: firstGoal.goalDefinitionVersionId,
          config: {
            ...firstGoal.config,
            repetition: { kind: 'weekly', n: label.length.toString() },
          },
          sourceProvenance: null,
        },
      })
      draftRevision = updated.aggregateRevision
    }
    expect(draftRevision).toBe(5n)
    editor = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2026-04',
    })
    const activeOrder = editor!.goals.map((goal) => goal.planGoalId)
    const revisionIds = await admin.query<{
      readonly id: string
      readonly revision_number: string
    }>(
      `SELECT id::text, revision_number::text
         FROM plan_draft_goal_revisions
        WHERE plan_goal_id = $1::uuid ORDER BY revision_number`,
      [firstGoal.planGoalId],
    )
    const [revisionOne, revisionTwo, revisionThree] = revisionIds.rows.map(
      (row) => row.id,
    )
    if (
      revisionOne === undefined ||
      revisionTwo === undefined ||
      revisionThree === undefined
    ) {
      throw new Error('missing revision fixture')
    }

    type HistoryProbe = {
      readonly actionKind:
        'draft_goal_updated' | 'draft_goal_removed' | 'draft_goals_reordered'
      readonly beforeRevisionId: string | null
      readonly afterRevisionId: string | null
      readonly beforeOrder?: readonly string[]
      readonly afterOrder?: readonly string[]
      readonly parentBefore?: bigint
      readonly parentAfter?: bigint
      readonly receiptAggregateId?: string
      readonly receiptAggregateRevision?: bigint
      readonly detachBeforeHistory?: boolean
      readonly advancePointerAfterHistory?: boolean
    }
    const historyError = async (probe: HistoryProbe): Promise<unknown> => {
      const client = await admin.connect()
      const commandId = randomUUID()
      const actionId = randomUUID()
      const parentBefore = probe.parentBefore ?? 4n
      const parentAfter = probe.parentAfter ?? 5n
      const beforeOrder = probe.beforeOrder ?? []
      const afterOrder = probe.afterOrder ?? []
      const commandType = {
        draft_goal_updated: 'planning.update-draft-goal.v1',
        draft_goal_removed: 'planning.remove-draft-goal.v1',
        draft_goals_reordered: 'planning.reorder-draft-goals.v1',
      }[probe.actionKind]
      try {
        await client.query('BEGIN')
        if (probe.detachBeforeHistory === true) {
          await client.query(
            `UPDATE plan_draft_goals
                SET detached_at = now(), updated_at = now()
              WHERE id = $1::uuid`,
            [firstGoal.planGoalId],
          )
          await client.query(
            `UPDATE plan_draft_goals SET display_order = 0, updated_at = now()
              WHERE plan_month_id = $1::uuid AND detached_at IS NULL`,
            [planMonthId],
          )
        }
        await client.query(
          `INSERT INTO command_receipts
            (actor_scope, command_type, command_id, fingerprint, result_kind,
             aggregate_id, aggregate_revision, completed_at)
           VALUES ($1, $2, $3::uuid, repeat('0', 64),
                   'planning.plan-draft.v1', $4::uuid, $5, now())`,
          [
            `member:${firstMemberId}`,
            commandType,
            commandId,
            probe.receiptAggregateId ?? planMonthId,
            (probe.receiptAggregateRevision ?? parentAfter).toString(),
          ],
        )
        await client.query(
          `INSERT INTO planning_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id,
             system_actor_id, plan_month_id, goal_definition_id, command_type,
             command_id, before_revision, after_revision, occurred_at)
           VALUES ($1::uuid, $2, 'member', $3, $4::uuid, NULL, $5::uuid,
                   NULL, $6, $7::uuid, $8, $9, now())`,
          [
            actionId,
            probe.actionKind,
            `member:${firstMemberId}`,
            firstMemberId,
            planMonthId,
            commandType,
            commandId,
            parentBefore.toString(),
            parentAfter.toString(),
          ],
        )
        try {
          await client.query(
            `INSERT INTO planning_draft_goal_changes
              (action_id, plan_goal_id, before_revision_id, after_revision_id,
               reordered_goal_count, before_order, after_order)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                     $6::uuid[], $7::uuid[])`,
            [
              actionId,
              probe.actionKind === 'draft_goals_reordered'
                ? null
                : firstGoal.planGoalId,
              probe.beforeRevisionId,
              probe.afterRevisionId,
              probe.actionKind === 'draft_goals_reordered'
                ? beforeOrder.length
                : null,
              beforeOrder,
              afterOrder,
            ],
          )
          if (probe.advancePointerAfterHistory === true) {
            const revisionFour = randomUUID()
            await client.query(
              `INSERT INTO plan_draft_goal_revisions
                (id, plan_goal_id, space_id, goal_definition_id,
                 revision_number, goal_definition_version_id, goal_series_id,
                 scope_kind, owner_member_id, config, source_provenance,
                 created_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 4, $5::uuid,
                       $6::uuid, 'personal', $7::uuid, $8::jsonb, NULL, now())`,
              [
                revisionFour,
                firstGoal.planGoalId,
                spaceId,
                firstGoal.goalDefinitionId,
                firstGoal.goalDefinitionVersionId,
                firstGoal.goalSeriesId,
                firstMemberId,
                JSON.stringify(firstGoal.config),
              ],
            )
            await client.query(
              `UPDATE plan_draft_goals SET current_revision_id = $1::uuid
                WHERE id = $2::uuid`,
              [revisionFour, firstGoal.planGoalId],
            )
          }
          await client.query('SET CONSTRAINTS ALL IMMEDIATE')
          return null
        } catch (error: unknown) {
          return error
        }
      } catch (error: unknown) {
        return error
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }

    for (const probe of [
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionOne,
        afterRevisionId: revisionTwo,
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionThree,
        afterRevisionId: revisionTwo,
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionOne,
        afterRevisionId: revisionThree,
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionTwo,
        afterRevisionId: revisionThree,
        parentBefore: 3n,
        parentAfter: 4n,
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionTwo,
        afterRevisionId: revisionThree,
        receiptAggregateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionTwo,
        afterRevisionId: revisionThree,
        receiptAggregateRevision: 4n,
      },
      {
        actionKind: 'draft_goal_updated',
        beforeRevisionId: revisionTwo,
        afterRevisionId: revisionThree,
        advancePointerAfterHistory: true,
      },
      {
        actionKind: 'draft_goal_removed',
        beforeRevisionId: revisionOne,
        afterRevisionId: null,
        beforeOrder: activeOrder,
        afterOrder: activeOrder.filter((id) => id !== firstGoal.planGoalId),
      },
      {
        actionKind: 'draft_goals_reordered',
        beforeRevisionId: null,
        afterRevisionId: null,
        beforeOrder: [activeOrder[1]!, activeOrder[0]!],
        afterOrder: activeOrder,
      },
      {
        actionKind: 'draft_goal_removed',
        beforeRevisionId: revisionThree,
        afterRevisionId: null,
        beforeOrder: [activeOrder[1]!, activeOrder[0]!],
        afterOrder: [activeOrder[1]!],
        detachBeforeHistory: true,
      },
    ] satisfies readonly HistoryProbe[]) {
      await expect(historyError(probe)).resolves.toMatchObject({
        code: '23514',
      })
    }

    const duplicateTransitionError = async (): Promise<unknown> => {
      const client = await admin.connect()
      const commandId = randomUUID()
      const actionId = randomUUID()
      let committed = false
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO command_receipts
            (actor_scope, command_type, command_id, fingerprint, result_kind,
             aggregate_id, aggregate_revision, completed_at)
           VALUES ($1, 'planning.update-draft-goal.v1', $2::uuid,
                   repeat('0', 64), 'planning.plan-draft.v1', $3::uuid, 5,
                   now())`,
          [`member:${firstMemberId}`, commandId, planMonthId],
        )
        await client.query(
          `INSERT INTO planning_action_groups
            (id, action_kind, actor_kind, actor_scope, member_id,
             system_actor_id, plan_month_id, goal_definition_id, command_type,
             command_id, before_revision, after_revision, occurred_at)
           VALUES ($1::uuid, 'draft_goal_updated', 'member', $2, $3::uuid,
                   NULL, $4::uuid, NULL, 'planning.update-draft-goal.v1',
                   $5::uuid, 4, 5, now())`,
          [
            actionId,
            `member:${firstMemberId}`,
            firstMemberId,
            planMonthId,
            commandId,
          ],
        )
        await client.query(
          `INSERT INTO planning_draft_goal_changes
            (action_id, plan_goal_id, before_revision_id, after_revision_id,
             reordered_goal_count, before_order, after_order)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL,
                   ARRAY[]::uuid[], ARRAY[]::uuid[])`,
          [actionId, firstGoal.planGoalId, revisionTwo, revisionThree],
        )
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        await client.query('COMMIT')
        committed = true
        return null
      } catch (error: unknown) {
        return error
      } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }
    await expect(duplicateTransitionError()).resolves.toMatchObject({
      code: '23514',
    })
  })
})
