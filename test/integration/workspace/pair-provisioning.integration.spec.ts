import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { PrismaLocalUserProvisioningRepository } from '@/modules/auth/infrastructure/prisma-local-user-provisioning.repository'
import type { PairProvisioningInput } from '@/modules/workspace/application/pair-workspace.port'
import { ProvisionPairUseCase } from '@/modules/workspace/application/provision-pair.use-case'
import {
  PairProvisioningConflictError,
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'
import { PrismaPairWorkspaceRepository } from '@/modules/workspace/infrastructure/prisma-pair-workspace.repository'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import type { ProvisionPairRuntimeConfig } from '@/platform/config/provision-pair-runtime-config'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const thirdUserId = '33333333-3333-4333-8333-333333333333'

function databaseConfig(url: string): ProvisionPairRuntimeConfig {
  return {
    database: {
      url,
      poolMax: 8,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 10_000,
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
): ReturnType<typeof spawnSync> {
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

function mapping(
  firstTelegramId = 9007199254740993n,
  secondTelegramId = 9007199254740995n,
): PairProvisioningInput {
  return {
    members: [
      { userId: firstUserId, telegramId: firstTelegramId },
      { userId: secondUserId, telegramId: secondTelegramId },
    ],
  } as const
}

function reversedMapping(): PairProvisioningInput {
  const members = mapping().members
  return { members: [members[1], members[0]] }
}

function databaseOnlyEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  }
  delete environment['REDIS_AUTH_URL']
  delete environment['REDIS_KEY_PREFIX']
  delete environment['AUTH_SESSION_KEY_SECRET']
  delete environment['AUTH_CSRF_SECRET']
  delete environment['AUTH_CSRF_ORIGINS']
  return environment
}

function runProvisionPairProcess(
  databaseUrl: string,
  input: string,
): SpawnSyncReturns<string> {
  return spawnSync('pnpm', ['provision:pair'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: databaseOnlyEnvironment(databaseUrl),
    input,
  })
}

async function rowSnapshot(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ value: string }>(
    `SELECT value
       FROM (
         SELECT 'user:' || id::text || ':' || xmin::text || ':' || created_at::text || ':' || updated_at::text AS value FROM users
         UNION ALL SELECT 'space:' || id::text || ':' || xmin::text || ':' || created_at::text FROM spaces
         UNION ALL SELECT 'member:' || id::text || ':' || xmin::text || ':' || space_id::text || ':' || user_id::text || ':' || slot::text || ':' || created_at::text FROM memberships
         UNION ALL SELECT 'allow:' || xmin::text || ':' || space_id::text || ':' || user_id::text || ':' || telegram_id::text FROM telegram_access_allowlist
       ) snapshot
      ORDER BY value`,
  )
  return result.rows.map(({ value }) => value)
}

async function createProvisionStack(databaseUrl: string): Promise<{
  readonly provider: PrismaClientProvider
  readonly provision: ProvisionPairUseCase
}> {
  const context = new PrismaTransactionContext()
  const stackProvider = new PrismaClientProvider(
    databaseConfig(databaseUrl),
    context,
  )
  const stackTransaction = new PrismaTransactionAdapter(
    stackProvider,
    context,
    databaseConfig(databaseUrl),
  )
  const stackProvision = new ProvisionPairUseCase(
    stackTransaction,
    new PrismaLocalUserProvisioningRepository(stackProvider),
    new PrismaPairWorkspaceRepository(stackProvider),
  )
  await stackProvider.connect(AbortSignal.timeout(2_000))
  return { provider: stackProvider, provision: stackProvision }
}

describe('A01 pair workspace provisioning with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let workspace: PrismaPairWorkspaceRepository
  let users: PrismaLocalUserProvisioningRepository
  let provision: ProvisionPairUseCase
  let resolver: PrismaWorkspaceMemberResolver

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_a01_test')
      .withUsername('planner')
      .withPassword('planner-test-password')
      .start()
    admin = new Pool({ connectionString: container.getConnectionUri() })

    await applyMigration(admin, '20260811100000_local_user_session')
    await applyMigration(admin, '20260811110000_pair_workspace')

    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(
      databaseConfig(container.getConnectionUri()),
      context,
    )
    transaction = new PrismaTransactionAdapter(
      provider,
      context,
      databaseConfig(container.getConnectionUri()),
    )
    workspace = new PrismaPairWorkspaceRepository(provider)
    users = new PrismaLocalUserProvisioningRepository(provider)
    provision = new ProvisionPairUseCase(transaction, users, workspace)
    resolver = new PrismaWorkspaceMemberResolver(provider)
    await provider.connect(AbortSignal.timeout(2_000))
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    await admin.query(
      'TRUNCATE telegram_access_allowlist, memberships, spaces, users CASCADE',
    )
  })

  it.each([
    ['zero members', { members: [] }],
    ['one member', { members: [mapping().members[0]] }],
    [
      'three members',
      {
        members: [
          ...mapping().members,
          { userId: thirdUserId, telegramId: 9007199254740997n },
        ],
      },
    ],
    [
      'duplicate user',
      {
        members: [
          mapping().members[0],
          { userId: firstUserId, telegramId: 9007199254740997n },
        ],
      },
    ],
    [
      'duplicate Telegram ID',
      {
        members: [
          mapping().members[0],
          { userId: secondUserId, telegramId: 9007199254740993n },
        ],
      },
    ],
    [
      'non-positive Telegram ID',
      {
        members: [
          { userId: firstUserId, telegramId: 0n },
          mapping().members[1],
        ],
      },
    ],
    [
      'out-of-range Telegram ID',
      {
        members: [
          { userId: firstUserId, telegramId: 9223372036854775808n },
          mapping().members[1],
        ],
      },
    ],
  ])(
    'rejects direct application input with %s without writes',
    async (_label, input) => {
      await expect(
        provision.execute(input as unknown as PairProvisioningInput),
      ).rejects.toThrow('Invalid pair provisioning input')
      await expect(rowSnapshot(admin)).resolves.toEqual([])
    },
  )

  it('applies the A01 migration over S04 while preserving an existing local User', async () => {
    const upgradeDatabase = 'planner_a01_upgrade'
    await admin.query(`CREATE DATABASE ${upgradeDatabase}`)
    const upgradeUrl = new URL(container.getConnectionUri())
    upgradeUrl.pathname = `/${upgradeDatabase}`
    const upgradePool = new Pool({ connectionString: upgradeUrl.toString() })
    const temporaryProject = await mkdtemp(
      join(tmpdir(), 'planner-a01-migration-upgrade-'),
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
      const s04Deploy = deployMigrations(temporaryConfig, upgradeUrl.toString())
      expect(s04Deploy.status).toBe(0)
      await upgradePool.query(
        `INSERT INTO users (id, created_at, updated_at)
         VALUES ($1, '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')`,
        [firstUserId],
      )
      await cp(
        resolve(
          process.cwd(),
          'prisma',
          'migrations',
          '20260811110000_pair_workspace',
        ),
        join(temporaryMigrations, '20260811110000_pair_workspace'),
        { recursive: true },
      )
      const a01Deploy = deployMigrations(temporaryConfig, upgradeUrl.toString())
      expect(a01Deploy.status).toBe(0)

      await expect(
        upgradePool.query(
          `SELECT id::text, created_at::text, updated_at::text
             FROM users
            WHERE id = $1`,
          [firstUserId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            id: firstUserId,
            created_at: '2026-01-02 03:04:05+00',
            updated_at: '2026-01-02 03:04:05+00',
          },
        ],
      })
      await expect(
        upgradePool.query<{ migration_name: string }>(
          'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name',
        ),
      ).resolves.toMatchObject({
        rows: [
          { migration_name: '20260811090000_planner_foundation' },
          { migration_name: '20260811100000_local_user_session' },
          { migration_name: '20260811110000_pair_workspace' },
        ],
      })
    } finally {
      await upgradePool.end()
      await rm(temporaryProject, { recursive: true, force: true })
    }
  })

  it('upgrades an S04 database and stores exact BIGINT values', async () => {
    const result = await provision.execute(mapping())

    expect(result.status).toBe('created')
    expect(result.members).toHaveLength(2)
    const rows = await admin.query<{
      telegram_id: string
      user_id: string
      slot: number
    }>(
      `SELECT a.telegram_id::text, a.user_id::text, m.slot
         FROM telegram_access_allowlist a
         JOIN memberships m ON m.user_id = a.user_id
        ORDER BY a.user_id`,
    )
    expect(rows.rows).toEqual([
      { telegram_id: '9007199254740993', user_id: firstUserId, slot: 1 },
      { telegram_id: '9007199254740995', user_id: secondUserId, slot: 2 },
    ])
  })

  it('preserves an existing explicit local User while creating only the missing peer', async () => {
    await admin.query(
      `INSERT INTO users (id, created_at, updated_at)
       VALUES ($1, '2026-02-03T04:05:06.000Z', '2026-02-03T04:05:06.000Z')`,
      [firstUserId],
    )

    await expect(provision.execute(mapping())).resolves.toMatchObject({
      status: 'created',
    })
    const preserved = await admin.query<{
      created_at: string
      id: string
      updated_at: string
    }>(
      `SELECT id::text, created_at::text, updated_at::text
         FROM users
        WHERE id = $1`,
      [firstUserId],
    )
    expect(preserved.rows).toEqual([
      {
        id: firstUserId,
        created_at: '2026-02-03 04:05:06+00',
        updated_at: '2026-02-03 04:05:06+00',
      },
    ])
    await expect(
      admin.query('SELECT count(*)::int AS count FROM users'),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] })
  })

  it('runs the actual database-only pnpm provision:pair command without auth or Redis env', async () => {
    const databaseUrl = container.getConnectionUri()
    const command = runProvisionPairProcess(
      databaseUrl,
      JSON.stringify({
        members: [
          { userId: firstUserId, telegramId: '9007199254740993' },
          { userId: secondUserId, telegramId: '9007199254740995' },
        ],
      }),
    )

    expect(command.status).toBe(0)
    expect(command.stderr).toBe('$ tsx src/bootstrap/provision-pair/main.ts\n')
    const created = JSON.parse(command.stdout) as {
      readonly status: string
      readonly spaceId: string
      readonly members: readonly {
        readonly memberId: string
        readonly userId: string
      }[]
    }
    expect(created).toMatchObject({
      status: 'created',
      members: [{ userId: firstUserId }, { userId: secondUserId }],
    })
    expect(command.stdout).not.toContain('9007199254740993')
    expect(command.stdout).not.toContain('9007199254740995')
    expect(command.stderr).not.toContain('9007199254740993')
    expect(command.stderr).not.toContain('9007199254740995')

    const beforeReplay = await rowSnapshot(admin)
    const replay = runProvisionPairProcess(
      databaseUrl,
      JSON.stringify({
        members: [
          { userId: secondUserId, telegramId: '9007199254740995' },
          { userId: firstUserId, telegramId: '9007199254740993' },
        ],
      }),
    )
    expect(replay.status).toBe(0)
    const existing = JSON.parse(replay.stdout) as typeof created
    expect(existing).toEqual({ ...created, status: 'existing' })
    expect(replay.stdout).not.toContain('9007199254740993')
    expect(replay.stderr).not.toContain('9007199254740995')
    await expect(rowSnapshot(admin)).resolves.toEqual(beforeReplay)
  })

  it('maps actual pnpm invalid, conflict and dependency outcomes to safe finite exits', async () => {
    const databaseUrl = container.getConnectionUri()
    const created = runProvisionPairProcess(
      databaseUrl,
      JSON.stringify({
        members: [
          { userId: firstUserId, telegramId: '9007199254740993' },
          { userId: secondUserId, telegramId: '9007199254740995' },
        ],
      }),
    )
    expect(created.status).toBe(0)
    const before = await rowSnapshot(admin)

    const invalid = runProvisionPairProcess(databaseUrl, '{"members":[]}')
    expect(invalid.status).toBe(2)
    expect(invalid.stdout).toBe(
      '[ELIFECYCLE] Command failed with exit code 2.\n',
    )
    expect(invalid.stderr).toBe(
      '$ tsx src/bootstrap/provision-pair/main.ts\nInvalid provisioning input\n',
    )

    const swapped = runProvisionPairProcess(
      databaseUrl,
      JSON.stringify({
        members: [
          { userId: firstUserId, telegramId: '9007199254740995' },
          { userId: secondUserId, telegramId: '9007199254740993' },
        ],
      }),
    )
    const changedUsers = runProvisionPairProcess(
      databaseUrl,
      JSON.stringify({
        members: [
          { userId: firstUserId, telegramId: '9007199254740993' },
          { userId: thirdUserId, telegramId: '9007199254740997' },
        ],
      }),
    )
    for (const conflict of [swapped, changedUsers]) {
      expect(conflict.status).toBe(3)
      expect(conflict.stdout).toBe(
        '[ELIFECYCLE] Command failed with exit code 3.\n',
      )
      expect(conflict.stderr).toBe(
        '$ tsx src/bootstrap/provision-pair/main.ts\nProvisioning state conflict\n',
      )
      expect(conflict.stderr).not.toContain('9007199254740993')
      expect(conflict.stderr).not.toContain('9007199254740997')
    }
    await expect(rowSnapshot(admin)).resolves.toEqual(before)

    const dependency = runProvisionPairProcess(
      'postgresql://planner:planner@127.0.0.1:1/unavailable',
      JSON.stringify({
        members: [
          { userId: firstUserId, telegramId: '9007199254740993' },
          { userId: secondUserId, telegramId: '9007199254740995' },
        ],
      }),
    )
    expect(dependency.status).toBe(1)
    expect(dependency.stdout).toBe(
      '[ELIFECYCLE] Command failed with exit code 1.\n',
    )
    expect(dependency.stderr).toBe(
      '$ tsx src/bootstrap/provision-pair/main.ts\nProvisioning dependency unavailable\n',
    )
    expect(dependency.stderr).not.toContain('9007199254740993')
  })

  it('replays the exact and reversed mapping without writes or ID changes', async () => {
    const created = await provision.execute(mapping())
    const before = await admin.query<{ marker: string }>(
      `SELECT md5(string_agg(value, ',' ORDER BY value)) AS marker
         FROM (
           SELECT id::text AS value FROM spaces
           UNION ALL SELECT id::text FROM memberships
           UNION ALL SELECT user_id::text || ':' || telegram_id::text
             FROM telegram_access_allowlist
         ) snapshot`,
    )
    const existing = await provision.execute(reversedMapping())
    const after = await admin.query<{ marker: string }>(
      `SELECT md5(string_agg(value, ',' ORDER BY value)) AS marker
         FROM (
           SELECT id::text AS value FROM spaces
           UNION ALL SELECT id::text FROM memberships
           UNION ALL SELECT user_id::text || ':' || telegram_id::text
             FROM telegram_access_allowlist
         ) snapshot`,
    )

    expect(existing).toEqual({ ...created, status: 'existing' })
    expect(after.rows).toEqual(before.rows)
  })

  it('rejects changed mappings and partial state without repairing either', async () => {
    await provision.execute(mapping())
    await expect(
      provision.execute(mapping(9007199254740997n)),
    ).rejects.toBeInstanceOf(PairProvisioningConflictError)

    await admin.query(
      'DELETE FROM telegram_access_allowlist WHERE user_id = $1',
      [firstUserId],
    )
    await expect(provision.execute(mapping())).rejects.toBeInstanceOf(
      PairProvisioningConflictError,
    )
    await expect(
      admin.query(
        'SELECT count(*)::int AS count FROM telegram_access_allowlist',
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] })
  })

  it('serializes independent equal and different provider stacks under one advisory lock', async () => {
    const independent = await createProvisionStack(container.getConnectionUri())
    try {
      const equal = await Promise.all([
        provision.execute(mapping()),
        independent.provision.execute(reversedMapping()),
      ])
      expect(equal.map((result) => result.status).sort()).toEqual([
        'created',
        'existing',
      ])
      expect(equal[0]?.spaceId).toBe(equal[1]?.spaceId)
      await expect(rowSnapshot(admin)).resolves.toHaveLength(7)

      await admin.query(
        'TRUNCATE telegram_access_allowlist, memberships, spaces, users CASCADE',
      )
      const different = await Promise.allSettled([
        provision.execute(mapping()),
        independent.provision.execute(
          mapping(9007199254740997n, 9007199254740999n),
        ),
      ])
      expect(
        different.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      const rejected = different.find((result) => result.status === 'rejected')
      expect(rejected?.status).toBe('rejected')
      expect(
        (rejected as PromiseRejectedResult).reason as unknown,
      ).toBeInstanceOf(PairProvisioningConflictError)
      const winnerIndex = different.findIndex(
        (result) => result.status === 'fulfilled',
      )
      const expectedMapping =
        winnerIndex === 0
          ? [
              { user_id: firstUserId, telegram_id: '9007199254740993' },
              { user_id: secondUserId, telegram_id: '9007199254740995' },
            ]
          : [
              { user_id: firstUserId, telegram_id: '9007199254740997' },
              { user_id: secondUserId, telegram_id: '9007199254740999' },
            ]
      const finalMapping = await admin.query<{
        telegram_id: string
        user_id: string
      }>(
        `SELECT user_id::text, telegram_id::text
           FROM telegram_access_allowlist
          ORDER BY user_id`,
      )
      expect(finalMapping.rows).toEqual(expectedMapping)
      const counts = await admin.query<{
        allowlist: number
        memberships: number
        spaces: number
        users: number
      }>(
        `SELECT
           (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM spaces) AS spaces,
           (SELECT count(*)::int FROM memberships) AS memberships,
           (SELECT count(*)::int FROM telegram_access_allowlist) AS allowlist`,
      )
      expect(counts.rows).toEqual([
        { users: 2, spaces: 1, memberships: 2, allowlist: 2 },
      ])
    } finally {
      await independent.provider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
    }
  })

  it('rolls back Users and earlier workspace DML when the second allowlist insert fails', async () => {
    await admin.query(`
      CREATE FUNCTION reject_second_pair_allowlist() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${secondUserId}'::uuid THEN
          RAISE EXCEPTION 'injected second allowlist failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_second_pair_allowlist
      BEFORE INSERT ON telegram_access_allowlist
      FOR EACH ROW EXECUTE FUNCTION reject_second_pair_allowlist();
    `)
    try {
      await expect(provision.execute(mapping())).rejects.toBeInstanceOf(
        WorkspaceDependencyUnavailableError,
      )
      await expect(rowSnapshot(admin)).resolves.toEqual([])
    } finally {
      await admin.query(`
        DROP TRIGGER reject_second_pair_allowlist ON telegram_access_allowlist;
        DROP FUNCTION reject_second_pair_allowlist();
      `)
    }
  })

  it('enforces singleton, two slots, unique IDs and membership-backed allowlist in PostgreSQL', async () => {
    const created = await provision.execute(mapping())
    await expect(
      admin.query(
        'INSERT INTO spaces (id, singleton_key) VALUES (gen_random_uuid(), 1)',
      ),
    ).rejects.toThrow()
    await admin.query('INSERT INTO users (id) VALUES ($1)', [thirdUserId])
    await expect(
      admin.query(
        `INSERT INTO memberships (id, space_id, user_id, slot)
         VALUES (gen_random_uuid(), $1, $2, 3)`,
        [created.spaceId, thirdUserId],
      ),
    ).rejects.toThrow()
    await expect(
      admin.query(
        `INSERT INTO memberships (id, space_id, user_id, slot)
         VALUES (gen_random_uuid(), $1, $2, 1)`,
        [created.spaceId, thirdUserId],
      ),
    ).rejects.toThrow()
    await expect(
      admin.query(
        `UPDATE telegram_access_allowlist
            SET telegram_id = 9007199254740993
          WHERE user_id = $1`,
        [secondUserId],
      ),
    ).rejects.toThrow()
    await expect(
      admin.query(
        `INSERT INTO telegram_access_allowlist (user_id, space_id, telegram_id)
         VALUES ($1, $2, 42)`,
        [thirdUserId, created.spaceId],
      ),
    ).rejects.toThrow()
  })

  it('resolves both identifiers into the same role-free space and distinguishes unknown IDs', async () => {
    const created = await provision.execute(mapping())
    const byUser = await resolver.resolveUser(firstUserId)
    const byTelegram = await resolver.resolveTelegramId(9007199254740995n)
    const firstMember = created.members.find(
      (member) => member.userId === firstUserId,
    )
    const secondMember = created.members.find(
      (member) => member.userId === secondUserId,
    )
    if (firstMember === undefined || secondMember === undefined)
      throw new Error('Expected both provisioned members')

    expect(byUser).toEqual({
      spaceId: created.spaceId,
      memberId: firstMember.memberId,
      userId: firstUserId,
    })
    expect(byTelegram).toEqual({
      spaceId: created.spaceId,
      memberId: secondMember.memberId,
      userId: secondUserId,
    })
    expect(byUser).not.toHaveProperty('role')
    expect(byTelegram).not.toHaveProperty('role')
    const beforeUnknown = await rowSnapshot(admin)
    await expect(resolver.resolveUser(thirdUserId)).rejects.toBeInstanceOf(
      WorkspaceMemberNotFoundError,
    )
    await expect(resolver.resolveTelegramId(42n)).rejects.toBeInstanceOf(
      WorkspaceMemberNotFoundError,
    )
    await expect(rowSnapshot(admin)).resolves.toEqual(beforeUnknown)
  })

  it('maps a database outage to a distinct resolver dependency error', async () => {
    const context = new PrismaTransactionContext()
    const unavailableProvider = new PrismaClientProvider(
      databaseConfig('postgresql://planner:planner@127.0.0.1:1/unavailable'),
      context,
    )
    const unavailable = new PrismaWorkspaceMemberResolver(unavailableProvider)

    await expect(unavailable.resolveUser(firstUserId)).rejects.toBeInstanceOf(
      WorkspaceDependencyUnavailableError,
    )
    await unavailableProvider
      .close(AbortSignal.timeout(500))
      .catch(() => undefined)
  })
})
