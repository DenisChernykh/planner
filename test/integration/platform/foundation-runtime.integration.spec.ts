import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const database = 'planner_foundation_test'
const migratorUser = 'planner_migrator'
const migratorPassword = 'migrator-password-for-test-only'
const runtimeUser = 'planner_runtime'
const runtimePassword = 'runtime-password-for-test-only'

function connectionUrl(
  container: StartedPostgreSqlContainer,
  username: string,
  password: string,
): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${database}?schema=public`
}

function deployMigrations(databaseUrl: string): {
  readonly exitCode: number
  readonly output: string
} {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
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

describe('Planner foundation database runtime', () => {
  let container: StartedPostgreSqlContainer
  let migratorPool: Pool
  let runtimePool: Pool

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(database)
      .withUsername(migratorUser)
      .withPassword(migratorPassword)
      .start()
    migratorPool = new Pool({ connectionString: container.getConnectionUri() })
  })

  afterAll(async () => {
    await runtimePool?.end()
    await migratorPool?.end()
    await container?.stop()
  })

  it('deploys the exact accepted migration and production-table inventory through P07', async () => {
    const migration = deployMigrations(container.getConnectionUri())

    expect(migration).toMatchObject({ exitCode: 0 })
    const migrations = await migratorPool.query<{ migration_name: string }>(
      'SELECT migration_name FROM public._prisma_migrations ORDER BY migration_name',
    )
    expect(migrations.rows).toEqual([
      { migration_name: '20260811090000_planner_foundation' },
      { migration_name: '20260811100000_local_user_session' },
      { migration_name: '20260811110000_pair_workspace' },
      { migration_name: '20260811120000_telegram_external_identity' },
      { migration_name: '20260811130000_plan_draft_kernel' },
      { migration_name: '20260811140000_goal_catalog' },
      { migration_name: '20260811150000_typed_draft_goals' },
      { migration_name: '20260811151000_plan_publication' },
    ])
    const productionTables = await migratorPool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name <> '_prisma_migrations'
        ORDER BY table_name`,
    )
    expect(productionTables.rows).toEqual([
      { table_name: 'command_receipts' },
      { table_name: 'fixed_expectations' },
      { table_name: 'flexible_periods' },
      { table_name: 'goal_definition_versions' },
      { table_name: 'goal_definitions' },
      { table_name: 'goal_series' },
      { table_name: 'memberships' },
      { table_name: 'plan_draft_goal_revisions' },
      { table_name: 'plan_draft_goals' },
      { table_name: 'plan_drafts' },
      { table_name: 'plan_goal_snapshots' },
      { table_name: 'plan_months' },
      { table_name: 'plan_publications' },
      { table_name: 'planning_action_groups' },
      { table_name: 'planning_draft_goal_changes' },
      { table_name: 'planning_goal_catalog_changes' },
      { table_name: 'planning_month_focus_changes' },
      { table_name: 'planning_publication_changes' },
      { table_name: 'spaces' },
      { table_name: 'telegram_access_allowlist' },
      { table_name: 'telegram_external_identities' },
      { table_name: 'users' },
    ])
  })

  it('allows runtime DML on a test-owned probe while denying DDL and migration access', async () => {
    await migratorPool.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC;
      CREATE ROLE ${runtimeUser} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${runtimePassword}';
      GRANT CONNECT ON DATABASE ${database} TO ${runtimeUser};
      GRANT USAGE ON SCHEMA public TO ${runtimeUser};
      CREATE TABLE public.foundation_runtime_probe (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        value text NOT NULL
      );
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLE public.foundation_runtime_probe TO ${runtimeUser};
      GRANT USAGE, SELECT
        ON SEQUENCE public.foundation_runtime_probe_id_seq TO ${runtimeUser};
    `)
    runtimePool = new Pool({
      connectionString: connectionUrl(container, runtimeUser, runtimePassword),
    })

    const inserted = await runtimePool.query<{ id: number }>(
      `INSERT INTO public.foundation_runtime_probe (value)
       VALUES ('runtime-insert')
       RETURNING id`,
    )
    expect(inserted.rows).toEqual([{ id: 1 }])
    await expect(
      runtimePool.query(
        `UPDATE public.foundation_runtime_probe
            SET value = 'runtime-update'
          WHERE id = 1`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      runtimePool.query(
        'SELECT id, value FROM public.foundation_runtime_probe ORDER BY id',
      ),
    ).resolves.toMatchObject({
      rows: [{ id: 1, value: 'runtime-update' }],
    })
    await expect(
      runtimePool.query(
        'CREATE TABLE public.runtime_ddl_forbidden (id integer)',
      ),
    ).rejects.toThrow()
    await expect(
      runtimePool.query('SELECT * FROM public._prisma_migrations'),
    ).rejects.toThrow()
  })

  it('exports a framework-free transaction port backed by module-local Prisma context', async () => {
    const config = {
      database: {
        url: connectionUrl(container, runtimeUser, runtimePassword),
        poolMax: 2,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 1_000,
        transactionTimeoutMs: 2_000,
      },
    }
    const context = new PrismaTransactionContext()
    const provider = new PrismaClientProvider(config, context)
    const transaction: DatabaseTransactionPort = new PrismaTransactionAdapter(
      provider,
      context,
      config,
    )
    await provider.connect(AbortSignal.timeout(2_000))

    await expect(
      transaction.run(async () => {
        await provider.withClient((client) =>
          client.$executeRawUnsafe(
            `INSERT INTO public.foundation_runtime_probe (value)
             VALUES ('must-roll-back')`,
          ),
        )
        throw new Error('rollback requested by application')
      }),
    ).rejects.toThrow('rollback requested by application')
    const persisted = await runtimePool.query<{ count: string }>(
      `SELECT count(*)
         FROM public.foundation_runtime_probe
        WHERE value = 'must-roll-back'`,
    )
    expect(persisted.rows).toEqual([{ count: '0' }])

    await provider.close(AbortSignal.timeout(2_000))
  })

  it('survives a genuine idle backend termination and reports a later network outage as down', async () => {
    const disconnectContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(database)
      .withUsername(migratorUser)
      .withPassword(migratorPassword)
      .start()
    const providerUrl = new URL(disconnectContainer.getConnectionUri())
    providerUrl.searchParams.set(
      'application_name',
      'planner-provider-break-test',
    )
    const config = {
      database: {
        url: providerUrl.toString(),
        poolMax: 1,
        connectionTimeoutMs: 500,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 1_000,
        transactionTimeoutMs: 2_000,
      },
    }
    const provider = new PrismaClientProvider(
      config,
      new PrismaTransactionContext(),
    )
    const adminPool = new Pool({
      connectionString: disconnectContainer.getConnectionUri(),
    })

    try {
      await provider.connect(AbortSignal.timeout(2_000))
      const backend = await adminPool.query<{ pid: number }>(
        `SELECT pid
           FROM pg_stat_activity
          WHERE application_name = 'planner-provider-break-test'`,
      )
      expect(backend.rows).toHaveLength(1)
      await adminPool.query('SELECT pg_terminate_backend($1)', [
        backend.rows[0]?.pid,
      ])
      await new Promise((resolve) => setTimeout(resolve, 100))

      await expect(
        provider.checkReadiness(AbortSignal.timeout(1_000), 500),
      ).resolves.toBe('down')
      await expect(
        provider.checkReadiness(AbortSignal.timeout(1_000), 500),
      ).resolves.toBe('up')

      await adminPool.end()
      await disconnectContainer.stop()

      await expect(
        provider.checkReadiness(AbortSignal.timeout(1_000), 500),
      ).resolves.toBe('down')
    } finally {
      await provider.close(AbortSignal.timeout(2_000)).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
      await disconnectContainer.stop().catch(() => undefined)
    }
  })
})
