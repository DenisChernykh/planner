import { ListPlanMonthsQuery } from '@/modules/planning/application/list-plan-months.query'
import type {
  ListPlanMonthsReadPort,
  PlanMonthReadRecord,
} from '@/modules/planning/application/list-plan-months.read.port'
import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from '@/modules/planning/application/planning-errors'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace/application/workspace-errors'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

const userId = '11111111-1111-4111-8111-111111111111'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'

function record(
  targetMonth: string,
  overrides: Partial<PlanMonthReadRecord> = {},
): PlanMonthReadRecord {
  const planMonthId =
    targetMonth === '2031-03'
      ? '66666666-6666-4666-8666-666666666666'
      : '77777777-7777-4777-8777-777777777777'
  return {
    planMonthId,
    targetMonth,
    monthStart: `${targetMonth}-01`,
    status: 'draft',
    mode: 'ordinary',
    revision: '1',
    factsRevision: '0',
    draftRevision: '2',
    latestPublication: null,
    latestReport: null,
    ...overrides,
    ...(overrides.latestPublication === undefined
      ? {}
      : { latestPublication: overrides.latestPublication }),
  }
}

function publication(
  planMonthId: string,
  isActive = true,
): NonNullable<PlanMonthReadRecord['latestPublication']> {
  return {
    publicationId: `${planMonthId.slice(0, 8)}-8888-4888-8888-888888888888`,
    revision: '3',
    activeLocalDate: '2031-03-01',
    isActive,
  }
}

function query(read: ListPlanMonthsReadPort): ListPlanMonthsQuery {
  const members: WorkspaceMemberResolver = {
    resolveUser: () => Promise.resolve({ spaceId, memberId, userId }),
    resolveMember: () => Promise.reject(new Error('unused')),
    resolveTelegramId: () => Promise.reject(new Error('unused')),
  }
  const transaction: DatabaseTransactionPort = {
    run: async (operation, options) => {
      expect(options).toEqual({ mode: 'repeatable_read_only' })
      return operation()
    },
  }
  return new ListPlanMonthsQuery(
    members,
    read,
    transaction,
    new FakeProductClock(new Date('2031-03-15T10:00:00.000Z')),
  )
}

describe('ListPlanMonthsQuery', () => {
  it('derives phases/actions and serializes every revision as a string', async () => {
    const future = record('2031-04', {
      status: 'published',
      latestPublication: publication('77777777-7777-4777-8777-777777777777'),
    })
    const active = record('2031-03', {
      planMonthId: '66666666-6666-4666-8666-666666666666',
      status: 'published',
      latestPublication: publication('66666666-6666-4666-8666-666666666666'),
    })
    const grace = record('2031-02', {
      status: 'grace',
      latestPublication: publication('77777777-7777-4777-8777-777777777777'),
    })
    const reopened = record('2031-01', {
      status: 'grace',
      mode: 'reopened',
      latestPublication: publication('77777777-7777-4777-8777-777777777777'),
      latestReport: {
        reportRevisionId: '99999999-9999-4999-8999-999999999998',
        revision: '2',
        status: 'original',
      },
    })
    const closed = record('2030-12', {
      status: 'closed',
      latestPublication: publication('77777777-7777-4777-8777-777777777777'),
      latestReport: {
        reportRevisionId: '99999999-9999-4999-8999-999999999999',
        revision: '4',
        status: 'original',
      },
    })
    const rows = [future, active, grace, reopened, closed]
    const result = await query({ read: () => Promise.resolve(rows) }).execute({
      trustedUserId: userId,
      limit: 50,
    })

    expect(result.queryLocalDate).toBe('2031-03-15')
    expect(result.items.map((item) => [item.targetMonth, item.phase])).toEqual([
      ['2031-04', 'future'],
      ['2031-03', 'active'],
      ['2031-02', 'grace'],
      ['2031-01', 'grace'],
      ['2030-12', 'closed'],
    ])
    expect(result.items[0]?.allowedActions).toEqual({
      openDraft: false,
      openPublication: true,
      copySource: true,
      cancel: true,
      reopen: false,
      reclose: false,
    })
    expect(result.items[3]?.allowedActions.reclose).toBe(true)
    expect(result.items[4]?.report).toEqual(closed.latestReport)
    expect(typeof result.items[4]?.lifecycle.revision).toBe('string')
    expect(typeof result.items[4]?.publication?.revision).toBe('string')
  })

  it('keeps a cancelled latest publication as an exact copy source', async () => {
    const cancelled = record('2031-05', {
      latestPublication: publication(
        '77777777-7777-4777-8777-777777777777',
        false,
      ),
    })
    const result = await query({
      read: () => Promise.resolve([cancelled]),
    }).execute({
      trustedUserId: userId,
    })
    expect(result.items[0]).toMatchObject({
      phase: 'draft',
      publication: { isActive: false },
      allowedActions: {
        openDraft: true,
        openPublication: true,
        copySource: true,
        cancel: false,
        reopen: false,
        reclose: false,
      },
    })
  })

  it.each([
    {
      name: 'draft with active publication',
      overrides: {
        latestPublication: publication('77777777-7777-4777-8777-777777777777'),
      },
    },
    {
      name: 'published reopened',
      overrides: {
        status: 'published' as const,
        mode: 'reopened' as const,
        latestPublication: publication('77777777-7777-4777-8777-777777777777'),
      },
    },
    {
      name: 'closed without report',
      overrides: {
        status: 'closed' as const,
        latestPublication: publication('77777777-7777-4777-8777-777777777777'),
      },
    },
    {
      name: 'report without publication',
      overrides: {
        latestReport: {
          reportRevisionId: '99999999-9999-4999-8999-999999999999',
          revision: '1',
          status: 'original' as const,
        },
      },
    },
  ])('fails closed for impossible matrix: $name', async ({ overrides }) => {
    await expect(
      query({
        read: () => Promise.resolve([record('2031-03', overrides)]),
      }).execute({
        trustedUserId: userId,
      }),
    ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
  })

  it('uses stable keyset cursor and requests a bounded limit plus one', async () => {
    const first = record('2031-04')
    const second = record('2031-03')
    const calls: number[] = []
    const read: ListPlanMonthsReadPort = {
      read: (input) => {
        calls.push(input.limit)
        return Promise.resolve(
          input.cursor === null ? [first, second] : [second],
        )
      },
    }
    const firstPage = await query(read).execute({
      trustedUserId: userId,
      limit: 1,
    })
    expect(calls).toEqual([2])
    expect(firstPage.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u)
    const secondPage = await query(read).execute({
      trustedUserId: userId,
      limit: 1,
      cursor: firstPage.nextCursor!,
    })
    expect(secondPage.nextCursor).toBeNull()
    expect(secondPage.items).toHaveLength(1)
  })

  it.each([0, 51, 1.5])('rejects invalid limit %s', async (limit) => {
    await expect(
      query({ read: () => Promise.resolve([]) }).execute({
        trustedUserId: userId,
        limit,
      }),
    ).rejects.toThrow('Application command is invalid')
  })

  it('maps missing membership and read failures to safe errors', async () => {
    const members: WorkspaceMemberResolver = {
      resolveUser: () => Promise.reject(new WorkspaceMemberNotFoundError()),
      resolveMember: () => Promise.reject(new Error('unused')),
      resolveTelegramId: () => Promise.reject(new Error('unused')),
    }
    const transaction: DatabaseTransactionPort = {
      run: (operation) => operation(),
    }
    const unauthorized = new ListPlanMonthsQuery(
      members,
      { read: () => Promise.resolve([]) },
      transaction,
      new FakeProductClock(new Date('2031-03-15T10:00:00.000Z')),
    )
    await expect(
      unauthorized.execute({ trustedUserId: userId }),
    ).rejects.toBeInstanceOf(PlanningAuthorizationDeniedError)

    await expect(
      query({ read: () => Promise.reject(new Error('db')) }).execute({
        trustedUserId: userId,
      }),
    ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
  })
})
