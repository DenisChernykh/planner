import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool, type PoolClient } from 'pg'

import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import {
  PlanDraftNotEditableError,
  PlanMonthAlreadyExistsError,
  PlanningAuthorizationDeniedError,
  createPlanningApplication,
} from '@/modules/planning'
import type { CreateEmptyDraftApplicationCommand } from '@/modules/planning'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { ActorRef } from '@/shared/application/application-command'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const unknownMemberId = '66666666-6666-4666-8666-666666666666'

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
type PlanningCounts = {
  readonly actions: number
  readonly drafts: number
  readonly focusChanges: number
  readonly months: number
  readonly receipts: number
}
type CreatedDraftRow = {
  readonly action_kind: string
  readonly actor_kind: string
  readonly after_focus: string
  readonly after_revision: string
  readonly aggregate_revision: string
  readonly before_focus: string | null
  readonly before_revision: string | null
  readonly completed_at: Date
  readonly created_at: Date
  readonly draft_created_at: Date
  readonly draft_revision: string
  readonly draft_updated_at: Date
  readonly focus: string
  readonly member_id: string
  readonly month_start: string
  readonly occurred_at: Date
  readonly plan_month_revision: string
  readonly result_kind: string
  readonly space_id: string
  readonly status: string
  readonly updated_at: Date
}
type FocusHistoryRow = {
  readonly action_kind: string
  readonly after_focus: string
  readonly after_revision: string
  readonly before_focus: string | null
  readonly before_revision: string | null
  readonly occurred_at: Date
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
  const sql = await readFile(
    resolve(process.cwd(), 'prisma', 'migrations', name, 'migration.sql'),
    'utf8',
  )
  await pool.query(sql)
}

function deployMigrations(
  configPath: string,
  databaseUrl: string,
): SpawnSyncReturns<string> {
  return spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', configPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
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

function memberActor(
  memberId = firstMemberId,
): Extract<ActorRef, { readonly kind: 'member' }> {
  return { kind: 'member' as const, id: memberId }
}

function createCommand(
  commandId: string,
  targetMonth = '2026-04',
  focus = 'Прожить апрель',
): CreateEmptyDraftApplicationCommand {
  return {
    commandId,
    trustedActor: memberActor(),
    payload: { targetMonth, focus },
  }
}

async function planningSnapshot(pool: Pool): Promise<readonly string[]> {
  const snapshot = await pool.query<{ value: string }>(`
    SELECT value FROM (
      SELECT 'month:' || id::text || ':' || xmin::text || ':' || space_id::text || ':' || month_start::text || ':' || status || ':' || revision::text || ':' || created_at::text || ':' || updated_at::text AS value FROM plan_months
      UNION ALL SELECT 'draft:' || plan_month_id::text || ':' || xmin::text || ':' || focus || ':' || revision::text || ':' || created_at::text || ':' || updated_at::text FROM plan_drafts
      UNION ALL SELECT 'receipt:' || actor_scope || ':' || command_type || ':' || command_id::text || ':' || xmin::text || ':' || fingerprint || ':' || result_kind || ':' || aggregate_id::text || ':' || aggregate_revision::text || ':' || completed_at::text FROM command_receipts
      UNION ALL SELECT 'action:' || id::text || ':' || xmin::text || ':' || action_kind || ':' || actor_scope || ':' || command_type || ':' || command_id::text || ':' || coalesce(before_revision::text, 'null') || ':' || after_revision::text || ':' || occurred_at::text FROM planning_action_groups
      UNION ALL SELECT 'focus:' || action_id::text || ':' || xmin::text || ':' || coalesce(before_focus, '<null>') || ':' || after_focus FROM planning_month_focus_changes
    ) values ORDER BY value
  `)
  return snapshot.rows.map(({ value }) => value)
}

async function counts(pool: Pool): Promise<PlanningCounts | undefined> {
  const result = await pool.query<PlanningCounts>(`
    SELECT
      (SELECT count(*)::int FROM plan_months) AS months,
      (SELECT count(*)::int FROM plan_drafts) AS drafts,
      (SELECT count(*)::int FROM command_receipts) AS receipts,
      (SELECT count(*)::int FROM planning_action_groups) AS actions,
      (SELECT count(*)::int FROM planning_month_focus_changes) AS "focusChanges"
  `)
  return result.rows[0]
}

async function holdReceiptLock(
  pool: Pool,
  key: {
    readonly actorScope: string
    readonly commandId: string
    readonly commandType: string
  },
): Promise<PoolClient> {
  const client = await pool.connect()
  await client.query('BEGIN')
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 8503113703)
     )`,
    [
      JSON.stringify({
        actorScope: key.actorScope,
        commandId: key.commandId,
        commandType: key.commandType,
      }),
    ],
  )
  return client
}

async function releaseReceiptLock(client: PoolClient): Promise<void> {
  try {
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

describe('P01 draft commands with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let application: PlanningApplication
  let clock: FakeProductClock

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p01_test')
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
      TRUNCATE planning_month_focus_changes, planning_action_groups,
        command_receipts, plan_drafts, plan_months,
        telegram_external_identities, telegram_access_allowlist,
        memberships, spaces, users CASCADE;
      INSERT INTO users (id, created_at, updated_at) VALUES
        ('${firstUserId}', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
        ('${secondUserId}', '2026-01-02T03:04:06.000Z', '2026-01-02T03:04:06.000Z');
      INSERT INTO spaces (id, singleton_key, created_at)
        VALUES ('${spaceId}', 1, '2026-01-02T03:05:00.000Z');
      INSERT INTO memberships (id, space_id, user_id, slot, created_at) VALUES
        ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, '2026-01-02T03:06:00.000Z'),
        ('${secondMemberId}', '${spaceId}', '${secondUserId}', 2, '2026-01-02T03:06:01.000Z');
      INSERT INTO telegram_access_allowlist (space_id, user_id, telegram_id) VALUES
        ('${spaceId}', '${firstUserId}', 4000000000000001),
        ('${spaceId}', '${secondUserId}', 4000000000000002);
      INSERT INTO telegram_external_identities
        (issuer, subject, provider_user_id, user_id, created_at)
      VALUES
        ('https://oauth.telegram.org', 'p01-first', 4000000000000001, '${firstUserId}', '2026-01-02T03:07:00.000Z');
    `)
    clock.set(new Date('2026-03-02T03:04:05.678Z'))
  })

  it('upgrades the accepted A03 ledger additively without mutating identity/workspace rows or its immutable trigger', async () => {
    const databaseName = 'planner_p01_upgrade'
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`)
    await admin.query(`CREATE DATABASE ${databaseName}`)
    const url = new URL(container.getConnectionUri())
    url.pathname = `/${databaseName}`
    const upgrade = new Pool({ connectionString: url.toString() })
    const temporaryProject = await mkdtemp(
      join(tmpdir(), 'planner-p01-upgrade-'),
    )
    const temporaryMigrations = join(temporaryProject, 'migrations')
    const temporarySchema = join(temporaryProject, 'schema.prisma')
    const temporaryConfig = join(temporaryProject, 'prisma.config.ts')
    try {
      await mkdir(temporaryMigrations)
      await cp(
        resolve(process.cwd(), 'prisma', 'schema.prisma'),
        temporarySchema,
      )
      for (const migration of [
        '20260811090000_planner_foundation',
        '20260811100000_local_user_session',
        '20260811110000_pair_workspace',
        '20260811120000_telegram_external_identity',
      ]) {
        await cp(
          resolve(process.cwd(), 'prisma', 'migrations', migration),
          join(temporaryMigrations, migration),
          { recursive: true },
        )
      }
      const prismaConfigModule = resolve(
        process.cwd(),
        'node_modules',
        'prisma',
        'config.js',
      )
      await writeFile(
        temporaryConfig,
        `import { defineConfig } from ${JSON.stringify(prismaConfigModule)}\n\nexport default defineConfig({\n  schema: ${JSON.stringify(temporarySchema)},\n  migrations: { path: ${JSON.stringify(temporaryMigrations)} },\n  datasource: { url: process.env['DATABASE_URL'] as string },\n})\n`,
      )
      const a03Deploy = deployMigrations(temporaryConfig, url.toString())
      expect(a03Deploy.status).toBe(0)
      await upgrade.query(`
        INSERT INTO users (id, created_at, updated_at) VALUES ('${firstUserId}', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
        INSERT INTO spaces (id, singleton_key, created_at) VALUES ('${spaceId}', 1, '2026-01-02T03:05:00.000Z');
        INSERT INTO memberships (id, space_id, user_id, slot, created_at) VALUES ('${firstMemberId}', '${spaceId}', '${firstUserId}', 1, '2026-01-02T03:06:00.000Z');
        INSERT INTO telegram_access_allowlist (space_id, user_id, telegram_id) VALUES ('${spaceId}', '${firstUserId}', 4000000000000001);
        INSERT INTO telegram_external_identities (issuer, subject, provider_user_id, user_id, created_at) VALUES ('https://oauth.telegram.org', 'upgrade', 4000000000000001, '${firstUserId}', '2026-01-02T03:07:00.000Z');
      `)
      const before = await upgrade.query<{ value: string }>(`
        SELECT value FROM (
          SELECT 'user:' || id || ':' || xmin || ':' || created_at || ':' || updated_at AS value FROM users
          UNION ALL SELECT 'space:' || id || ':' || xmin || ':' || created_at FROM spaces
          UNION ALL SELECT 'member:' || id || ':' || xmin || ':' || created_at FROM memberships
          UNION ALL SELECT 'allow:' || user_id || ':' || xmin FROM telegram_access_allowlist
          UNION ALL SELECT 'identity:' || subject || ':' || xmin || ':' || created_at FROM telegram_external_identities
        ) rows ORDER BY value
      `)
      await cp(
        resolve(
          process.cwd(),
          'prisma',
          'migrations',
          '20260811130000_plan_draft_kernel',
        ),
        join(temporaryMigrations, '20260811130000_plan_draft_kernel'),
        { recursive: true },
      )
      const p01Deploy = deployMigrations(temporaryConfig, url.toString())
      expect(p01Deploy.status).toBe(0)
      const after = await upgrade.query<{ value: string }>(`
        SELECT value FROM (
          SELECT 'user:' || id || ':' || xmin || ':' || created_at || ':' || updated_at AS value FROM users
          UNION ALL SELECT 'space:' || id || ':' || xmin || ':' || created_at FROM spaces
          UNION ALL SELECT 'member:' || id || ':' || xmin || ':' || created_at FROM memberships
          UNION ALL SELECT 'allow:' || user_id || ':' || xmin FROM telegram_access_allowlist
          UNION ALL SELECT 'identity:' || subject || ':' || xmin || ':' || created_at FROM telegram_external_identities
        ) rows ORDER BY value
      `)
      expect(after.rows).toEqual(before.rows)
      await expect(
        upgrade.query(
          "UPDATE telegram_external_identities SET subject = 'changed'",
        ),
      ).rejects.toThrow('immutable')
      await expect(
        upgrade.query<{ migration_name: string }>(
          'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name',
        ),
      ).resolves.toMatchObject({
        rows: [
          { migration_name: '20260811090000_planner_foundation' },
          { migration_name: '20260811100000_local_user_session' },
          { migration_name: '20260811110000_pair_workspace' },
          { migration_name: '20260811120000_telegram_external_identity' },
          { migration_name: '20260811130000_plan_draft_kernel' },
        ],
      })
    } finally {
      await upgrade.end()
      await rm(temporaryProject, { recursive: true, force: true })
    }
  })

  it('creates exact draft, typed receipt/history and one timestamp, then allows both members to query it', async () => {
    const result = await application.createEmptyDraft.execute(
      createCommand('77777777-7777-4777-8777-777777777777'),
    )
    expect(result).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: 1n,
    })
    expect(result.aggregateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const rows = await admin.query<CreatedDraftRow>(`
      SELECT pm.space_id::text, pm.month_start::text, pm.status,
             pm.revision AS plan_month_revision, pd.focus,
             pd.revision AS draft_revision, pm.created_at, pm.updated_at,
             pd.created_at AS draft_created_at, pd.updated_at AS draft_updated_at,
             r.result_kind, r.aggregate_revision, r.completed_at,
             a.action_kind, a.actor_kind, a.member_id::text, a.before_revision,
             a.after_revision, a.occurred_at, f.before_focus, f.after_focus
        FROM plan_months pm
        JOIN plan_drafts pd ON pd.plan_month_id = pm.id
        JOIN command_receipts r ON r.aggregate_id = pm.id
        JOIN planning_action_groups a ON a.plan_month_id = pm.id
        JOIN planning_month_focus_changes f ON f.action_id = a.id
    `)
    expect(rows.rows).toEqual([
      expect.objectContaining({
        space_id: spaceId,
        month_start: '2026-04-01',
        status: 'draft',
        plan_month_revision: '1',
        focus: 'Прожить апрель',
        draft_revision: '1',
        result_kind: 'planning.plan-draft.v1',
        aggregate_revision: '1',
        action_kind: 'draft_created',
        actor_kind: 'member',
        member_id: firstMemberId,
        before_revision: null,
        after_revision: '1',
        before_focus: null,
        after_focus: 'Прожить апрель',
      }),
    ])
    const timestampKeys = [
      'created_at',
      'updated_at',
      'draft_created_at',
      'draft_updated_at',
      'completed_at',
      'occurred_at',
    ] as const
    for (const key of timestampKeys) {
      expect(rows.rows[0]?.[key]).toEqual(new Date('2026-03-02T03:04:05.678Z'))
    }
    const expected = {
      planMonthId: result.aggregateId,
      spaceId,
      targetMonth: '2026-04',
      status: 'draft',
      focus: 'Прожить апрель',
      planMonthRevision: 1n,
      draftRevision: 1n,
    }
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(),
        targetMonth: '2026-04',
      }),
    ).resolves.toEqual(expected)
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(secondMemberId),
        targetMonth: '2026-04',
      }),
    ).resolves.toEqual(expected)
  })

  it('replays after an independent provider/executor restart without row, xmin or timestamp mutation', async () => {
    const command = createCommand('88888888-8888-4888-8888-888888888888')
    const first = await application.createEmptyDraft.execute(command)
    const before = await planningSnapshot(admin)
    clock.set(new Date('2030-01-01T00:00:00.000Z'))
    const restarted = await createStack(container.getConnectionUri(), clock)
    try {
      await expect(
        restarted.application.createEmptyDraft.execute(command),
      ).resolves.toEqual(first)
      await expect(planningSnapshot(admin)).resolves.toEqual(before)
    } finally {
      await restarted.provider.close(AbortSignal.timeout(2_000))
    }
  })

  it('snapshots create and update primitives once before a delayed receipt lock', async () => {
    const createId = '81234567-1234-4234-8234-123456789abc'
    const createLock = await holdReceiptLock(admin, {
      actorScope: `member:${firstMemberId}`,
      commandId: createId,
      commandType: 'planning.create-empty-draft.v1',
    })
    const createPayload = {
      targetMonth: '2026-07',
      focus: 'Snapshot create focus',
    }
    const createReads = { actor: 0, commandId: 0, payload: 0 }
    const mutableCreate = Object.defineProperties(
      {},
      {
        commandId: {
          enumerable: true,
          get: () => {
            createReads.commandId += 1
            return createId
          },
        },
        trustedActor: {
          enumerable: true,
          get: () => {
            createReads.actor += 1
            return memberActor()
          },
        },
        payload: {
          enumerable: true,
          get: () => {
            createReads.payload += 1
            return createPayload
          },
        },
      },
    ) as CreateEmptyDraftApplicationCommand
    const pendingCreate = application.createEmptyDraft.execute(mutableCreate)
    await new Promise((resolve) => setTimeout(resolve, 25))
    createPayload.targetMonth = '2026-08'
    createPayload.focus = 'Mutated after fingerprint'
    await releaseReceiptLock(createLock)
    const created = await pendingCreate

    expect(createReads).toEqual({ actor: 1, commandId: 1, payload: 1 })
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(),
        targetMonth: '2026-07',
      }),
    ).resolves.toMatchObject({
      planMonthId: created.aggregateId,
      focus: 'Snapshot create focus',
    })
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(),
        targetMonth: '2026-08',
      }),
    ).resolves.toBeNull()

    const updateId = '82345678-1234-4234-8234-123456789abc'
    const updateLock = await holdReceiptLock(admin, {
      actorScope: `member:${firstMemberId}`,
      commandId: updateId,
      commandType: 'planning.update-month-focus.v1',
    })
    const updatePayload = {
      planMonthId: created.aggregateId,
      focus: 'Snapshot update focus',
    }
    let expectedRevision: unknown = 1n
    const updateReads = {
      actor: 0,
      commandId: 0,
      expectedRevision: 0,
      payload: 0,
    }
    const mutableUpdate = Object.defineProperties(
      {},
      {
        commandId: {
          enumerable: true,
          get: () => {
            updateReads.commandId += 1
            return updateId
          },
        },
        trustedActor: {
          enumerable: true,
          get: () => {
            updateReads.actor += 1
            return memberActor()
          },
        },
        expectedRevision: {
          enumerable: true,
          get: () => {
            updateReads.expectedRevision += 1
            return expectedRevision
          },
        },
        payload: {
          enumerable: true,
          get: () => {
            updateReads.payload += 1
            return updatePayload
          },
        },
      },
    ) as Parameters<PlanningApplication['updateMonthFocus']['execute']>[0]
    const pendingUpdate = application.updateMonthFocus.execute(mutableUpdate)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expectedRevision = 99n
    updatePayload.focus = 'Mutated update after fingerprint'
    await releaseReceiptLock(updateLock)

    await expect(pendingUpdate).resolves.toMatchObject({
      aggregateRevision: 2n,
    })
    expect(updateReads).toEqual({
      actor: 1,
      commandId: 1,
      expectedRevision: 1,
      payload: 1,
    })
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(),
        targetMonth: '2026-07',
      }),
    ).resolves.toMatchObject({ focus: 'Snapshot update focus' })
  })

  it('preserves PlanDraftNotEditableError from the named query', async () => {
    const created = await application.createEmptyDraft.execute(
      createCommand('83456789-1234-4234-8234-123456789abc'),
    )
    await admin.query(
      "UPDATE plan_months SET status = 'published' WHERE id = $1",
      [created.aggregateId],
    )
    await expect(
      application.getDraft.execute({
        trustedActor: memberActor(),
        targetMonth: '2026-04',
      }),
    ).rejects.toBeInstanceOf(PlanDraftNotEditableError)
  })

  it('prioritizes same-key fingerprint conflicts and supports update, same-focus update, stale retry with the same failed command ID', async () => {
    const created = await application.createEmptyDraft.execute(
      createCommand('99999999-9999-4999-8999-999999999999'),
    )
    await expect(
      application.createEmptyDraft.execute(
        createCommand(
          '99999999-9999-4999-8999-999999999999',
          '2026-05',
          'Другой payload',
        ),
      ),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)

    const updateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    clock.set(new Date('2026-03-02T04:00:00.001Z'))
    await expect(
      application.updateMonthFocus.execute({
        commandId: updateId,
        trustedActor: memberActor(secondMemberId),
        expectedRevision: 1n,
        payload: { planMonthId: created.aggregateId, focus: 'Новый фокус' },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 2n })
    await expect(
      application.updateMonthFocus.execute({
        commandId: updateId,
        trustedActor: memberActor(secondMemberId),
        expectedRevision: 99n,
        payload: { planMonthId: created.aggregateId, focus: 'Новый фокус' },
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    clock.set(new Date('2026-03-02T05:00:00.002Z'))
    await expect(
      application.updateMonthFocus.execute({
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        trustedActor: memberActor(),
        expectedRevision: 2n,
        payload: { planMonthId: created.aggregateId, focus: 'Новый фокус' },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 3n })

    const staleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    clock.set(new Date('2026-03-02T06:00:00.003Z'))
    await expect(
      application.updateMonthFocus.execute({
        commandId: staleId,
        trustedActor: memberActor(),
        expectedRevision: 1n,
        payload: { planMonthId: created.aggregateId, focus: 'Retry focus' },
      }),
    ).rejects.toMatchObject({
      expectedRevision: 1n,
      currentRevision: 3n,
    })
    clock.set(new Date('2026-03-02T07:00:00.004Z'))
    await expect(
      application.updateMonthFocus.execute({
        commandId: staleId,
        trustedActor: memberActor(),
        expectedRevision: 3n,
        payload: { planMonthId: created.aggregateId, focus: 'Retry focus' },
      }),
    ).resolves.toMatchObject({ aggregateRevision: 4n })
    await expect(counts(admin)).resolves.toEqual({
      months: 1,
      drafts: 1,
      receipts: 4,
      actions: 4,
      focusChanges: 4,
    })
    const history = await admin.query<FocusHistoryRow>(`
      SELECT action.action_kind,
             action.before_revision::text,
             action.after_revision::text,
             action.occurred_at,
             focus.before_focus,
             focus.after_focus
        FROM planning_action_groups AS action
        JOIN planning_month_focus_changes AS focus
          ON focus.action_id = action.id
       ORDER BY action.after_revision
    `)
    expect(history.rows).toEqual([
      {
        action_kind: 'draft_created',
        before_revision: null,
        after_revision: '1',
        occurred_at: new Date('2026-03-02T03:04:05.678Z'),
        before_focus: null,
        after_focus: 'Прожить апрель',
      },
      {
        action_kind: 'month_focus_updated',
        before_revision: '1',
        after_revision: '2',
        occurred_at: new Date('2026-03-02T04:00:00.001Z'),
        before_focus: 'Прожить апрель',
        after_focus: 'Новый фокус',
      },
      {
        action_kind: 'month_focus_updated',
        before_revision: '2',
        after_revision: '3',
        occurred_at: new Date('2026-03-02T05:00:00.002Z'),
        before_focus: 'Новый фокус',
        after_focus: 'Новый фокус',
      },
      {
        action_kind: 'month_focus_updated',
        before_revision: '3',
        after_revision: '4',
        occurred_at: new Date('2026-03-02T07:00:00.004Z'),
        before_focus: 'Новый фокус',
        after_focus: 'Retry focus',
      },
    ])
    await expect(
      admin.query('SELECT revision::text FROM plan_months'),
    ).resolves.toMatchObject({ rows: [{ revision: '1' }] })
  })

  it('serializes two independent stacks for exact same key, fingerprint races and different-command same-month creation', async () => {
    const independent = await createStack(container.getConnectionUri(), clock)
    try {
      const exact = createCommand('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
      const sameKey = await Promise.all([
        application.createEmptyDraft.execute(exact),
        independent.application.createEmptyDraft.execute(exact),
      ])
      expect(sameKey[0]).toEqual(sameKey[1])
      await expect(counts(admin)).resolves.toMatchObject({
        months: 1,
        receipts: 1,
      })

      const exactUpdate = {
        commandId: '11111111-aaaa-4aaa-8aaa-111111111111',
        trustedActor: memberActor(),
        expectedRevision: 1n,
        payload: {
          planMonthId: sameKey[0].aggregateId,
          focus: 'Concurrent exact update',
        },
      }
      const sameUpdateKey = await Promise.all([
        application.updateMonthFocus.execute(exactUpdate),
        independent.application.updateMonthFocus.execute(exactUpdate),
      ])
      expect(sameUpdateKey).toEqual([
        expect.objectContaining({ aggregateRevision: 2n }),
        expect.objectContaining({ aggregateRevision: 2n }),
      ])
      await expect(counts(admin)).resolves.toMatchObject({
        months: 1,
        drafts: 1,
        receipts: 2,
        actions: 2,
        focusChanges: 2,
      })

      await admin.query(
        'TRUNCATE planning_month_focus_changes, planning_action_groups, command_receipts, plan_drafts, plan_months CASCADE',
      )
      const race = await Promise.allSettled([
        application.createEmptyDraft.execute(
          createCommand('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '2026-05', 'A'),
        ),
        independent.application.createEmptyDraft.execute(
          createCommand('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '2026-05', 'B'),
        ),
      ])
      expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(
        1,
      )
      expect(
        (
          race.find(
            ({ status }) => status === 'rejected',
          ) as PromiseRejectedResult
        ).reason,
      ).toBeInstanceOf(CommandFingerprintConflictError)

      await admin.query(
        'TRUNCATE planning_month_focus_changes, planning_action_groups, command_receipts, plan_drafts, plan_months CASCADE',
      )
      const monthRace = await Promise.allSettled([
        application.createEmptyDraft.execute(
          createCommand('ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-06', 'A'),
        ),
        independent.application.createEmptyDraft.execute(
          createCommand('12345678-1234-4234-8234-123456789abc', '2026-06', 'B'),
        ),
      ])
      expect(
        monthRace.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        (
          monthRace.find(
            ({ status }) => status === 'rejected',
          ) as PromiseRejectedResult
        ).reason,
      ).toBeInstanceOf(PlanMonthAlreadyExistsError)
      await expect(counts(admin)).resolves.toMatchObject({
        months: 1,
        receipts: 1,
      })
    } finally {
      await independent.provider.close(AbortSignal.timeout(2_000))
    }
  })

  it('separates actor scopes, rejects unknown/system actors and exact-shape payload extras without writes', async () => {
    await expect(
      application.createEmptyDraft.execute({
        ...createCommand('23456789-1234-4234-8234-123456789abc'),
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    await expect(
      application.createEmptyDraft.execute({
        ...createCommand('3456789a-1234-4234-8234-123456789abc'),
        trustedActor: memberActor(unknownMemberId),
      }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)
    await expect(
      application.createEmptyDraft.execute({
        ...createCommand('456789ab-1234-4234-8234-123456789abc'),
        payload: {
          targetMonth: '2026-04',
          focus: 'Focus',
          spaceId,
        } as unknown as {
          readonly targetMonth: string
          readonly focus: string
        },
      }),
    ).rejects.toBeInstanceOf(CommandValidationError)
    await expect(counts(admin)).resolves.toEqual({
      months: 0,
      drafts: 0,
      receipts: 0,
      actions: 0,
      focusChanges: 0,
    })

    const memberResult = await application.createEmptyDraft.execute(
      createCommand('56789abc-1234-4234-8234-123456789abc'),
    )
    await admin.query(
      `INSERT INTO command_receipts
        (actor_scope, command_type, command_id, fingerprint, result_kind,
         aggregate_id, aggregate_revision, completed_at)
       VALUES
        ('system:planner-worker', 'planning.create-empty-draft.v1',
         '56789abc-1234-4234-8234-123456789abc', repeat('a', 64),
         'planning.plan-draft.v1', $1, 1, '2026-03-02T03:04:05.678Z')`,
      [memberResult.aggregateId],
    )
    await expect(
      admin.query(
        `SELECT actor_scope FROM command_receipts
          WHERE command_id = '56789abc-1234-4234-8234-123456789abc'
          ORDER BY actor_scope`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { actor_scope: `member:${firstMemberId}` },
        { actor_scope: 'system:planner-worker' },
      ],
    })
  })

  it('rolls back product/history when receipt completion fails, then succeeds on retry', async () => {
    const commandId = '6789abcd-1234-4234-8234-123456789abc'
    await admin.query(`
      CREATE FUNCTION reject_p01_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.command_id = '${commandId}'::uuid THEN
          RAISE EXCEPTION 'injected receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_p01_receipt BEFORE INSERT ON command_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_p01_receipt();
    `)
    try {
      await expect(
        application.createEmptyDraft.execute(createCommand(commandId)),
      ).rejects.toThrow()
      await expect(counts(admin)).resolves.toEqual({
        months: 0,
        drafts: 0,
        receipts: 0,
        actions: 0,
        focusChanges: 0,
      })
    } finally {
      await admin.query(`
        DROP TRIGGER reject_p01_receipt ON command_receipts;
        DROP FUNCTION reject_p01_receipt();
      `)
    }
    await expect(
      application.createEmptyDraft.execute(createCommand(commandId)),
    ).resolves.toMatchObject({ aggregateRevision: 1n })
  })

  it('enforces direct finite constraints and immutable receipt/history without partial unrelated mutation', async () => {
    const created = await application.createEmptyDraft.execute(
      createCommand('789abcde-1234-4234-8234-123456789abc'),
    )
    const beforeIdentity = await admin.query(
      'SELECT xmin::text, created_at, updated_at FROM users ORDER BY id',
    )
    const freePlanMonthId = '91234567-1234-4234-8234-123456789abc'
    await admin.query(
      `INSERT INTO plan_months
        (id, space_id, month_start, status, revision, created_at, updated_at)
       VALUES ($1, $2, '2026-05-01', 'draft', 1, now(), now())`,
      [freePlanMonthId, spaceId],
    )
    await expect(
      admin.query(
        `INSERT INTO plan_drafts (plan_month_id, focus, revision, created_at, updated_at)
         VALUES ($1, '   ', 1, now(), now())`,
        [freePlanMonthId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'plan_drafts_focus_check',
    })
    await expect(
      admin.query("UPDATE command_receipts SET result_kind = 'changed'"),
    ).rejects.toThrow('immutable')
    await expect(
      admin.query('DELETE FROM planning_action_groups'),
    ).rejects.toThrow('immutable')
    await expect(
      admin.query(
        'UPDATE planning_month_focus_changes SET after_focus = after_focus',
      ),
    ).rejects.toThrow('immutable')
    const constraintCommandId = '92345678-1234-4234-8234-123456789abc'
    const constraintCommandType = 'planning.constraint-probe.v1'
    await admin.query(
      `INSERT INTO command_receipts
        (actor_scope, command_type, command_id, fingerprint, result_kind,
         aggregate_id, aggregate_revision, completed_at)
       VALUES ($1, $2, $3, repeat('b', 64), 'planning.plan-draft.v1',
               $4, 1, now())`,
      [
        `member:${firstMemberId}`,
        constraintCommandType,
        constraintCommandId,
        created.aggregateId,
      ],
    )
    await expect(
      admin.query(
        `INSERT INTO planning_action_groups
          (id, action_kind, actor_kind, actor_scope, member_id, system_actor_id,
           plan_month_id, command_type, command_id, before_revision,
           after_revision, occurred_at)
         VALUES
          (gen_random_uuid(), 'arbitrary', 'member', $1, '${firstMemberId}', null,
           $2, $3, $4, null, 1, now())`,
        [
          `member:${firstMemberId}`,
          created.aggregateId,
          constraintCommandType,
          constraintCommandId,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'planning_action_groups_action_kind_check',
    })
    await expect(
      admin.query(
        'SELECT xmin::text, created_at, updated_at FROM users ORDER BY id',
      ),
    ).resolves.toMatchObject({ rows: beforeIdentity.rows })
  })
})
