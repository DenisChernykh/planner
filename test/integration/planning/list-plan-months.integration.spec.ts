import { spawnSync } from 'node:child_process'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { ListPlanMonthsQuery } from '@/modules/planning/application/list-plan-months.query'
import { PrismaListPlanMonthsRead } from '@/modules/planning/infrastructure/prisma-list-plan-months.read'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import {
  LIST_PLAN_MONTH_FIXTURES,
  seedListPlanMonthsFixture,
} from '@test/support/planning/list-plan-months-fixture'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const outsiderUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const outsiderMemberId = '55555555-5555-4555-8555-555555555555'

function cursor(targetMonth: string, planMonthId: string): string {
  return `v1.${Buffer.from(
    JSON.stringify({ v: 1, targetMonth, planMonthId }),
    'utf8',
  ).toString('base64url')}`
}

function migrate(databaseUrl: string): void {
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

describe('F02 list plan months read model', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let query: ListPlanMonthsQuery

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_f02_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    migrate(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [
      userId,
      outsiderUserId,
    ])
    await pool.query('INSERT INTO spaces (id, singleton_key) VALUES ($1, 1)', [
      spaceId,
    ])
    await pool.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $2, $3, 1), ($4, $2, $5, 2)`,
      [memberId, spaceId, userId, outsiderMemberId, outsiderUserId],
    )
    await seedListPlanMonthsFixture(pool, { spaceId, memberId })
    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 4,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 1_000,
        transactionMaxWaitMs: 2_000,
        transactionTimeoutMs: 10_000,
      },
    }
    const transactionContext = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, transactionContext)
    await provider.connect(AbortSignal.timeout(3_000))
    query = new ListPlanMonthsQuery(
      new PrismaWorkspaceMemberResolver(provider),
      new PrismaListPlanMonthsRead(provider),
      new PrismaTransactionAdapter(provider, transactionContext, config),
      new FakeProductClock(new Date('2031-03-15T10:00:00.000Z')),
    )
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  it('returns populated lifecycle pages with exact refs, actions and stable cursors', async () => {
    const first = await query.execute({ trustedUserId: userId, limit: 3 })
    expect(first.schemaVersion).toBe('planning.month-index.v1')
    expect(first.queryLocalDate).toBe('2031-03-15')
    expect(first.items).toHaveLength(3)
    expect(first.items.map((item) => item.targetMonth)).toEqual([
      '2031-04',
      '2031-03',
      '2031-02',
    ])
    expect(first.items[0]).toMatchObject({
      targetMonth: LIST_PLAN_MONTH_FIXTURES.future.targetMonth,
      phase: 'future',
      lifecycle: {
        planMonthId: LIST_PLAN_MONTH_FIXTURES.future.planMonthId,
        status: 'published',
        mode: 'ordinary',
        revision: '2',
      },
      draft: { revision: '1' },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.future.publicationId,
        revision: '1',
        activeLocalDate: '2031-04-01',
        isActive: true,
      },
      report: null,
      allowedActions: {
        openDraft: false,
        openPublication: true,
        copySource: true,
        cancel: true,
        reopen: false,
        reclose: false,
      },
    })
    expect(first.items[1]).toMatchObject({
      targetMonth: '2031-03',
      phase: 'active',
      lifecycle: { status: 'published', revision: '2' },
      publication: { isActive: true },
      report: null,
      allowedActions: { cancel: false },
    })
    expect(first.items[2]).toMatchObject({
      targetMonth: '2031-02',
      phase: 'draft',
      lifecycle: {
        planMonthId: LIST_PLAN_MONTH_FIXTURES.cancelled.planMonthId,
        status: 'draft',
        mode: 'ordinary',
        revision: '3',
      },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.cancelled.publicationId,
        revision: '1',
        activeLocalDate: '2031-02-01',
        isActive: false,
      },
      report: null,
      allowedActions: {
        openDraft: true,
        openPublication: true,
        copySource: true,
        cancel: false,
        reopen: false,
        reclose: false,
      },
    })
    expect(first.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u)
    const second = await query.execute({
      trustedUserId: userId,
      limit: 3,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((item) => item.targetMonth)).toEqual([
      '2031-01',
      '2030-12',
      '2030-11',
    ])
    expect(second.items[0]).toMatchObject({
      phase: 'grace',
      lifecycle: { status: 'grace', mode: 'ordinary', revision: '3' },
      publication: { isActive: true },
      report: null,
      allowedActions: { reclose: false },
    })
    expect(second.items[1]).toMatchObject({
      phase: 'grace',
      lifecycle: { status: 'grace', mode: 'reopened', revision: '5' },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.graceReopened.reportRevisionId,
        revision: '1',
        status: 'original',
      },
      allowedActions: { reclose: true },
    })
    expect(second.items[2]).toMatchObject({
      phase: 'closed',
      lifecycle: { status: 'closed', mode: 'ordinary', revision: '4' },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.closedOrdinary.reportRevisionId,
        revision: '1',
        status: 'original',
      },
      allowedActions: { reopen: true, reclose: false },
    })
    expect(second.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u)
    const third = await query.execute({
      trustedUserId: userId,
      limit: 3,
      cursor: second.nextCursor!,
    })
    expect(third.items).toHaveLength(1)
    expect(third.items[0]).toMatchObject({
      targetMonth: '2030-10',
      phase: 'closed',
      lifecycle: { status: 'closed', mode: 'reopened', revision: '6' },
      publication: {
        publicationId: LIST_PLAN_MONTH_FIXTURES.closedReopened.publicationId,
        revision: '1',
        isActive: true,
      },
      report: {
        reportRevisionId:
          LIST_PLAN_MONTH_FIXTURES.closedReopened.reportRevisionId,
        revision: '2',
        status: 'revised',
      },
      allowedActions: { reopen: true, reclose: false },
    })
    expect(third.nextCursor).toBeNull()

    const allItems = [...first.items, ...second.items, ...third.items]
    expect(
      new Set(allItems.map((item) => item.lifecycle.planMonthId)).size,
    ).toBe(allItems.length)
    for (const item of allItems) {
      expect(typeof item.lifecycle.revision).toBe('string')
      expect(typeof item.draft.revision).toBe('string')
      if (item.publication !== null) {
        expect(typeof item.publication.revision).toBe('string')
      }
      if (item.report !== null)
        expect(typeof item.report.revision).toBe('string')
    }

    const empty = await query.execute({
      trustedUserId: userId,
      limit: 1,
      cursor: cursor('1900-01', '00000000-0000-4000-8000-000000000000'),
    })
    expect(empty.items).toEqual([])
    expect(empty.nextCursor).toBeNull()

    await expect(
      query.execute({ trustedUserId: userId, cursor: 'v1.not-base64' }),
    ).rejects.toThrow('Application command is invalid')
    await expect(
      query.execute({
        trustedUserId: userId,
        cursor: cursor(
          '2031-02',
          '00000000-0000-4000-8000-000000000000',
        ).replace('v1.', 'v2.'),
      }),
    ).rejects.toThrow('Application command is invalid')
  })
})
