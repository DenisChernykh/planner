import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool, type QueryResult } from 'pg'

import {
  AuthDependencyUnavailableError,
  OidcAccessDeniedError,
} from '@/modules/auth/application/auth-errors'
import { TELEGRAM_OIDC_ISSUER } from '@/modules/auth/application/telegram-oidc.ports'
import { PrismaTelegramIdentityBinder } from '@/modules/auth/infrastructure/prisma-telegram-identity-binder'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const firstMemberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const secondMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const firstTelegramId = 4_503_599_627_370_493n
const secondTelegramId = 4_503_599_627_370_495n

function databaseConfig(url: string): {
  readonly database: {
    readonly url: string
    readonly poolMax: number
    readonly connectionTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly healthTimeoutMs: number
    readonly transactionMaxWaitMs: number
    readonly transactionTimeoutMs: number
  }
} {
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
  } as const
}

async function applyMigration(pool: Pool, name: string): Promise<void> {
  const sql = await readFile(
    resolve(process.cwd(), 'prisma', 'migrations', name, 'migration.sql'),
    'utf8',
  )
  await pool.query(sql)
}

async function createBinder(url: string): Promise<{
  readonly provider: PrismaClientProvider
  readonly binder: PrismaTelegramIdentityBinder
}> {
  const context = new PrismaTransactionContext()
  const provider = new PrismaClientProvider(databaseConfig(url), context)
  const transaction = new PrismaTransactionAdapter(
    provider,
    context,
    databaseConfig(url),
  )
  await provider.connect(AbortSignal.timeout(3_000))
  return {
    provider,
    binder: new PrismaTelegramIdentityBinder(transaction, provider),
  }
}

function identity(
  subject = 'opaque-first-subject',
  providerUserId = firstTelegramId,
): Readonly<{
  issuer: typeof TELEGRAM_OIDC_ISSUER
  subject: string
  providerUserId: bigint
}> {
  return Object.freeze({
    issuer: TELEGRAM_OIDC_ISSUER,
    subject,
    providerUserId,
  })
}

async function databaseSnapshot(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ value: string }>(`
    SELECT value FROM (
      SELECT 'user:' || id::text || ':' || xmin::text AS value FROM users
      UNION ALL
      SELECT 'identity:' || issuer || ':' || subject || ':' ||
             provider_user_id::text || ':' || user_id::text || ':' ||
             xmin::text || ':' || created_at::text
        FROM telegram_external_identities
    ) snapshot
    ORDER BY value
  `)
  return result.rows.map(({ value }) => value)
}

describe('A03 Telegram external identity binding with real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let admin: Pool
  let provider: PrismaClientProvider
  let binder: PrismaTelegramIdentityBinder

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_a03_identity')
      .withUsername('planner')
      .withPassword('planner-test-password')
      .start()
    admin = new Pool({ connectionString: container.getConnectionUri() })
    for (const migration of [
      '20260811100000_local_user_session',
      '20260811110000_pair_workspace',
      '20260811120000_telegram_external_identity',
    ]) {
      await applyMigration(admin, migration)
    }
    ;({ provider, binder } = await createBinder(container.getConnectionUri()))
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await admin?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    await admin.query(
      'TRUNCATE telegram_external_identities, telegram_access_allowlist, memberships, spaces, users CASCADE',
    )
    await admin.query('INSERT INTO users (id) VALUES ($1), ($2)', [
      firstUserId,
      secondUserId,
    ])
    await admin.query('INSERT INTO spaces (id, singleton_key) VALUES ($1, 1)', [
      spaceId,
    ])
    await admin.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $3, $4, 1), ($2, $3, $5, 2)`,
      [firstMemberId, secondMemberId, spaceId, firstUserId, secondUserId],
    )
    await admin.query(
      `INSERT INTO telegram_access_allowlist (space_id, user_id, telegram_id)
       VALUES ($1, $2, $4), ($1, $3, $5)`,
      [
        spaceId,
        firstUserId,
        secondUserId,
        firstTelegramId.toString(),
        secondTelegramId.toString(),
      ],
    )
  })

  it('binds the exact allowlisted tuple without creating or mutating a User', async () => {
    const usersBefore = await admin.query<{ id: string; xmin: string }>(
      'SELECT id::text, xmin::text FROM users ORDER BY id',
    )

    await expect(binder.bindVerifiedIdentity(identity())).resolves.toBe(
      firstUserId,
    )
    await expect(
      admin.query(
        `SELECT issuer, subject, provider_user_id::text, user_id::text
           FROM telegram_external_identities`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          issuer: TELEGRAM_OIDC_ISSUER,
          subject: 'opaque-first-subject',
          provider_user_id: firstTelegramId.toString(),
          user_id: firstUserId,
        },
      ],
    })
    const usersAfter = await admin.query<{ id: string; xmin: string }>(
      'SELECT id::text, xmin::text FROM users ORDER BY id',
    )
    expect(usersAfter.rows).toEqual(usersBefore.rows)
  })

  it('replays an exact binding without changing row xmin or timestamps', async () => {
    await binder.bindVerifiedIdentity(identity())
    const before = await databaseSnapshot(admin)

    await expect(binder.bindVerifiedIdentity(identity())).resolves.toBe(
      firstUserId,
    )
    await expect(databaseSnapshot(admin)).resolves.toEqual(before)
  })

  it('rejects direct mutation of every fixed identity field without changing the row snapshot or xmin', async () => {
    await binder.bindVerifiedIdentity(identity())
    const before = await databaseSnapshot(admin)
    const mutations: readonly {
      readonly sql: string
      readonly values: string[]
    }[] = [
      {
        sql: `UPDATE telegram_external_identities
                 SET issuer = 'https://evil.invalid'`,
        values: [],
      },
      {
        sql: `UPDATE telegram_external_identities
                 SET subject = 'replacement-subject'`,
        values: [],
      },
      {
        sql: `UPDATE telegram_external_identities
                 SET provider_user_id = $1`,
        values: [secondTelegramId.toString()],
      },
      {
        sql: `UPDATE telegram_external_identities
                 SET user_id = $1`,
        values: [secondUserId],
      },
      {
        sql: `UPDATE telegram_external_identities
                 SET created_at = created_at + interval '1 second'`,
        values: [],
      },
      {
        sql: `UPDATE telegram_external_identities
                 SET provider_user_id = $1, user_id = $2`,
        values: [secondTelegramId.toString(), secondUserId],
      },
    ]

    for (const mutation of mutations) {
      const client = await admin.connect()
      try {
        await client.query('BEGIN')
        await expect(
          client.query(mutation.sql, mutation.values),
        ).rejects.toThrow()
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      await expect(databaseSnapshot(admin)).resolves.toEqual(before)
    }
  })

  it('denies unknown allowlist ID and all subject/provider/user collision axes without writes', async () => {
    await expect(
      binder.bindVerifiedIdentity(identity('unknown', 42n)),
    ).rejects.toBeInstanceOf(OidcAccessDeniedError)
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM telegram_external_identities',
        )
      ).rows,
    ).toEqual([{ count: 0 }])

    await binder.bindVerifiedIdentity(identity())
    const before = await databaseSnapshot(admin)
    for (const conflicting of [
      identity('opaque-first-subject', secondTelegramId),
      identity('different-subject', firstTelegramId),
      identity('different-subject-for-user', firstTelegramId),
    ]) {
      await expect(
        binder.bindVerifiedIdentity(conflicting),
      ).rejects.toBeInstanceOf(OidcAccessDeniedError)
      await expect(databaseSnapshot(admin)).resolves.toEqual(before)
    }
  })

  it('serializes equal independent binders and converges on one immutable row', async () => {
    const independent = await createBinder(container.getConnectionUri())
    try {
      await expect(
        Promise.all([
          binder.bindVerifiedIdentity(identity()),
          independent.binder.bindVerifiedIdentity(identity()),
        ]),
      ).resolves.toEqual([firstUserId, firstUserId])
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM telegram_external_identities',
          )
        ).rows,
      ).toEqual([{ count: 1 }])
    } finally {
      await independent.provider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
    }
  })

  it('serializes conflicting independent binders with one complete winner', async () => {
    const independent = await createBinder(container.getConnectionUri())
    try {
      const attempts = [
        identity('shared-subject', firstTelegramId),
        identity('shared-subject', secondTelegramId),
      ] as const
      const outcomes = await Promise.allSettled(
        attempts.map((attempt, index) =>
          index === 0
            ? binder.bindVerifiedIdentity(attempt)
            : independent.binder.bindVerifiedIdentity(attempt),
        ),
      )
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1)
      const rejection = outcomes.find(({ status }) => status === 'rejected')
      expect(rejection?.status).toBe('rejected')
      expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(
        OidcAccessDeniedError,
      )
      const winnerIndex = outcomes.findIndex(
        ({ status }) => status === 'fulfilled',
      )
      const winner = attempts[winnerIndex]
      if (winner === undefined) throw new Error('missing concurrency winner')
      const expectedUserId =
        winner.providerUserId === firstTelegramId ? firstUserId : secondUserId
      expect(
        (
          await admin.query(
            `SELECT subject, provider_user_id::text, user_id::text
               FROM telegram_external_identities`,
          )
        ).rows,
      ).toEqual([
        {
          subject: winner.subject,
          provider_user_id: winner.providerUserId.toString(),
          user_id: expectedUserId,
        },
      ])
    } finally {
      await independent.provider
        .close(AbortSignal.timeout(2_000))
        .catch(() => undefined)
    }
  })

  it('enforces issuer, provider range, composite allowlist FK and all unique axes in PostgreSQL', async () => {
    await binder.bindVerifiedIdentity(identity())
    const insert = (
      issuer: string,
      subject: string,
      providerId: bigint,
      mappedUserId: string,
    ): Promise<QueryResult> =>
      admin.query(
        `INSERT INTO telegram_external_identities
          (issuer, subject, provider_user_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [issuer, subject, providerId.toString(), mappedUserId],
      )

    await expect(
      insert('https://evil.invalid', 'foreign', secondTelegramId, secondUserId),
    ).rejects.toThrow()
    await expect(
      insert(TELEGRAM_OIDC_ISSUER, '', secondTelegramId, secondUserId),
    ).rejects.toThrow()
    await expect(
      insert(TELEGRAM_OIDC_ISSUER, 'zero', 0n, secondUserId),
    ).rejects.toThrow()
    await expect(
      insert(
        TELEGRAM_OIDC_ISSUER,
        'outside-json-number-contract',
        2n ** 52n,
        secondUserId,
      ),
    ).rejects.toThrow()
    await expect(
      insert(
        TELEGRAM_OIDC_ISSUER,
        's'.repeat(256),
        secondTelegramId,
        secondUserId,
      ),
    ).rejects.toThrow()
    await expect(
      insert(
        TELEGRAM_OIDC_ISSUER,
        'mismatched-pair',
        secondTelegramId,
        firstUserId,
      ),
    ).rejects.toThrow()
    await expect(
      admin.query(
        `UPDATE telegram_access_allowlist
            SET telegram_id = $1
          WHERE user_id = $2`,
        ['42', firstUserId],
      ),
    ).rejects.toThrow()
    await expect(
      admin.query('DELETE FROM telegram_access_allowlist WHERE user_id = $1', [
        firstUserId,
      ]),
    ).rejects.toThrow()
    await expect(
      insert(
        TELEGRAM_OIDC_ISSUER,
        'duplicate-provider',
        firstTelegramId,
        firstUserId,
      ),
    ).rejects.toThrow()
  })

  it('maps a real database outage to dependency failure without a session-capable result', async () => {
    const context = new PrismaTransactionContext()
    const unavailableProvider = new PrismaClientProvider(
      databaseConfig('postgresql://planner:planner@127.0.0.1:1/unavailable'),
      context,
    )
    const unavailable = new PrismaTelegramIdentityBinder(
      new PrismaTransactionAdapter(
        unavailableProvider,
        context,
        databaseConfig('postgresql://planner:planner@127.0.0.1:1/unavailable'),
      ),
      unavailableProvider,
    )

    await expect(
      unavailable.bindVerifiedIdentity(identity()),
    ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    await unavailableProvider
      .close(AbortSignal.timeout(500))
      .catch(() => undefined)
  })
})
