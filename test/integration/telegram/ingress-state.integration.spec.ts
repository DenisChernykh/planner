import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { PrismaTelegramIngressStateRepository } from '@/modules/telegram-bot'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const migrationsThroughT10 = [
  '20260811090000_planner_foundation',
  '20260811100000_local_user_session',
  '20260811110000_pair_workspace',
  '20260811120000_telegram_external_identity',
  '20260811130000_plan_draft_kernel',
  '20260811140000_goal_catalog',
  '20260811150000_typed_draft_goals',
  '20260811151000_plan_publication',
  '20260811152000_cancel_republish',
  '20260811153000_copy_month',
  '20260811155000_seed_consumption',
  '20260811160000_tracking_record_kernel',
  '20260811161000_time_rating_checkpoints',
  '20260811162000_text_checklist_facts',
  '20260811163000_or_composite_facts',
  '20260811164000_fact_corrections_tombstones',
  '20260811165000_fact_undo',
  '20260811166000_close_day',
  '20260811167000_weekly_task_result',
  '20260811168000_close_week',
] as const
const G01_MIGRATION = '20260811170000_telegram_ingress_state'

describe('G01 durable Telegram getUpdates offset on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let state: PrismaTelegramIngressStateRepository

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g01_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrationsThroughT10) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    await pool.query(`
      INSERT INTO users (id)
      VALUES ('11111111-1111-4111-8111-111111111111'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('33333333-3333-4333-8333-333333333333'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot)
      VALUES (
        '44444444-4444-4444-8444-444444444444'::uuid,
        '33333333-3333-4333-8333-333333333333'::uuid,
        '11111111-1111-4111-8111-111111111111'::uuid,
        1
      );
      INSERT INTO telegram_access_allowlist (user_id, space_id, telegram_id)
      VALUES (
        '11111111-1111-4111-8111-111111111111'::uuid,
        '33333333-3333-4333-8333-333333333333'::uuid,
        123456789
      );
    `)
    const before = await pool.query<{ readonly digest: string }>(`
      SELECT md5(string_agg(value, '|' ORDER BY value)) digest
        FROM (
          SELECT id::text value FROM users
          UNION ALL SELECT id::text FROM spaces
          UNION ALL SELECT id::text FROM memberships
          UNION ALL SELECT telegram_id::text FROM telegram_access_allowlist
        ) rows
    `)
    await pool.query(
      readFileSync(`prisma/migrations/${G01_MIGRATION}/migration.sql`, 'utf8'),
    )
    const after = await pool.query<{ readonly digest: string }>(`
      SELECT md5(string_agg(value, '|' ORDER BY value)) digest
        FROM (
          SELECT id::text value FROM users
          UNION ALL SELECT id::text FROM spaces
          UNION ALL SELECT id::text FROM memberships
          UNION ALL SELECT telegram_id::text FROM telegram_access_allowlist
        ) rows
    `)
    expect(after.rows[0]?.digest).toBe(before.rows[0]?.digest)

    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 8,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 2_000,
        transactionTimeoutMs: 5_000,
      },
    }
    provider = new PrismaClientProvider(
      runtimeConfig,
      new PrismaTransactionContext(),
    )
    await provider.connect(AbortSignal.timeout(3_000))
    state = new PrismaTelegramIngressStateRepository(provider)
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  it('advances monotonically and skips an exact replay', async () => {
    expect(await state.getNextUpdateId()).toBe(0n)
    await expect(state.claim(10n)).resolves.toBe(true)
    expect(await state.getNextUpdateId()).toBe(11n)
    await expect(state.claim(10n)).resolves.toBe(false)
    expect(await state.getNextUpdateId()).toBe(11n)
  })

  it('serializes concurrent claims to one winning outbound admission', async () => {
    const outcomes = await Promise.all([state.claim(11n), state.claim(11n)])
    expect(outcomes.sort()).toEqual([false, true])
    expect(await state.getNextUpdateId()).toBe(12n)
  })

  it('serializes different update ids without timestamp-order failures', async () => {
    const outcomes = await Promise.allSettled([
      state.claim(12n),
      state.claim(13n),
    ])
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(
      true,
    )
    expect(await state.getNextUpdateId()).toBe(14n)
  })

  it('rejects invalid application and direct-SQL transitions', async () => {
    await expect(state.claim(0n)).rejects.toThrow(
      'Telegram update identifier is invalid',
    )
    await expect(
      pool.query(`
        UPDATE telegram_ingress_state
           SET next_update_id = 1,
               revision = revision + 1
      `),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`
        UPDATE telegram_ingress_state
           SET next_update_id = 4503599627370497,
               revision = revision + 1
      `),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`
        UPDATE telegram_ingress_state
           SET revision = revision + 1
      `),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query('DELETE FROM telegram_ingress_state'),
    ).rejects.toMatchObject({ code: '23514' })
    expect(await state.getNextUpdateId()).toBe(14n)
  })
})
