import {
  GetMonthQuery,
  GetTodayQuery,
  assertTrackingReadBounds,
  isWithinTrackingCorrectionDeadline,
  previousTrackingAsOf,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  type TrackingMonthStateV1,
  type TrackingReadPersistencePort,
} from '@/modules/tracking'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

const memberId = '11111111-1111-4111-8111-111111111111'
const spaceId = '22222222-2222-4222-8222-222222222222'

class CountingClock implements ProductClock {
  public calls = 0

  public now(): Date {
    return new Date('2026-04-10T07:00:00.000Z')
  }

  public today(): string {
    this.calls += 1
    return '2026-04-10'
  }
}

class ImmediateTransaction implements DatabaseTransactionPort {
  public calls = 0

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.calls += 1
    return operation()
  }
}

function members(
  outcome:
    | 'success'
    | WorkspaceMemberNotFoundError
    | WorkspaceDependencyUnavailableError = 'success',
  calls: string[] = [],
): WorkspaceMemberResolver {
  return {
    resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
    resolveTelegramId: () =>
      Promise.reject(new Error('unexpected resolveTelegramId')),
    resolveMember: (id) => {
      calls.push(id)
      return outcome === 'success'
        ? Promise.resolve({ spaceId, memberId, userId: memberId })
        : Promise.reject(outcome)
    },
  }
}

function reads(
  value: TrackingMonthStateV1,
  inputs: unknown[] = [],
): TrackingReadPersistencePort {
  return {
    getMonth: (input) => {
      inputs.push(input)
      return Promise.resolve(value)
    },
  }
}

const noPlan: TrackingMonthStateV1 = {
  state: 'no_plan',
  queryLocalDate: '2026-04-10',
  targetMonth: '2026-04',
}

describe('T07 Today and Month application queries', () => {
  it('keeps published projection calculations inside canonical boundary years', () => {
    expect(previousTrackingAsOf('0001-01-01', '0001-01-01')).toBeNull()
    expect(previousTrackingAsOf('0001-01-01', '0001-01-02')).toBe('0001-01-01')
    expect(isWithinTrackingCorrectionDeadline('9999-12-31', '9999-12-31')).toBe(
      true,
    )
  })

  it('accepts exact read bounds and rejects every first excess without truncation', () => {
    expect(() =>
      assertTrackingReadBounds({
        goals: 200,
        fixedExpectations: 9_994,
        flexiblePeriods: 6,
        currentRecords: 10_000,
      }),
    ).not.toThrow()
    for (const counts of [
      {
        goals: 201,
        fixedExpectations: 0,
        flexiblePeriods: 0,
        currentRecords: 0,
      },
      {
        goals: 0,
        fixedExpectations: 9_995,
        flexiblePeriods: 6,
        currentRecords: 0,
      },
      {
        goals: 0,
        fixedExpectations: 0,
        flexiblePeriods: 0,
        currentRecords: 10_001,
      },
    ]) {
      expect(() => assertTrackingReadBounds(counts)).toThrow(
        'Tracking read model exceeds its bounded input',
      )
    }
  })

  it('reads Today from one trusted-member, clock and transaction snapshot', async () => {
    const clock = new CountingClock()
    const transaction = new ImmediateTransaction()
    const inputs: unknown[] = []
    const query = new GetTodayQuery(
      members(),
      reads(noPlan, inputs),
      transaction,
      clock,
    )

    await expect(
      query.execute({ trustedActor: { kind: 'member', id: memberId } }),
    ).resolves.toEqual({
      schemaVersion: 'tracking.today.v1',
      ...noPlan,
    })
    expect(clock.calls).toBe(1)
    expect(transaction.calls).toBe(1)
    expect(inputs).toEqual([
      {
        spaceId,
        memberId,
        targetMonth: '2026-04',
        queryLocalDate: '2026-04-10',
        selectedLocalDate: '2026-04-10',
      },
    ])
  })

  it('reads any canonical Month and preserves draft as a 200 state', async () => {
    const clock = new CountingClock()
    const transaction = new ImmediateTransaction()
    const inputs: unknown[] = []
    const draft: TrackingMonthStateV1 = {
      state: 'draft',
      queryLocalDate: '2026-04-10',
      targetMonth: '2035-12',
      planMonthId: '33333333-3333-4333-8333-333333333333',
      lifecycleRevision: 2n,
      draftRevision: 4n,
      focus: 'Future draft',
    }
    const query = new GetMonthQuery(
      members(),
      reads(draft, inputs),
      transaction,
      clock,
    )

    await expect(
      query.execute({
        trustedActor: { kind: 'member', id: memberId },
        targetMonth: '2035-12',
      }),
    ).resolves.toEqual({ schemaVersion: 'tracking.month.v1', ...draft })
    expect(clock.calls).toBe(1)
    expect(transaction.calls).toBe(1)
    expect(inputs).toEqual([
      expect.objectContaining({
        targetMonth: '2035-12',
        selectedLocalDate: null,
      }),
    ])
  })

  it('maps the selected published day into Today without changing facts', async () => {
    const day = {
      localDate: '2026-04-10',
      closure: {
        state: 'open' as const,
        dayCloseId: null,
        revision: null,
        closedAt: null,
        closedCount: null,
      },
      state: 'not_applicable' as const,
      coverage: { filled: '0', applicable: '0' },
      goals: [],
    }
    const published: TrackingMonthStateV1 = {
      state: 'published',
      queryLocalDate: '2026-04-10',
      targetMonth: '2026-04',
      planMonthId: '33333333-3333-4333-8333-333333333333',
      lifecycleRevision: 2n,
      factsRevision: 0n,
      monthStatus: 'published',
      phase: 'active',
      publicationId: '44444444-4444-4444-8444-444444444444',
      publicationRevision: 1n,
      activeLocalDate: '2026-04-10',
      latePublication: true,
      focus: 'Late plan',
      goals: [],
      days: [day],
    }
    const query = new GetTodayQuery(
      members(),
      reads(published),
      new ImmediateTransaction(),
      new CountingClock(),
    )
    const { days: _days, ...withoutDays } = published
    void _days
    await expect(
      query.execute({ trustedActor: { kind: 'member', id: memberId } }),
    ).resolves.toEqual({
      schemaVersion: 'tracking.today.v1',
      ...withoutDays,
      day,
    })
  })

  it.each([
    [
      'invalid month',
      {
        trustedActor: { kind: 'member', id: memberId },
        targetMonth: '2026-13',
      },
    ],
    [
      'year zero',
      {
        trustedActor: { kind: 'member', id: memberId },
        targetMonth: '0000-01',
      },
    ],
    [
      'unknown field',
      {
        trustedActor: { kind: 'member', id: memberId },
        targetMonth: '2026-04',
        expectedRevision: 1n,
      },
    ],
    [
      'foreign prototype',
      new (class Input {
        public trustedActor = { kind: 'member', id: memberId }
        public targetMonth = '2026-04'
      })(),
    ],
  ])(
    'rejects %s before membership, clock and persistence',
    async (_label, value) => {
      const clock = new CountingClock()
      const transaction = new ImmediateTransaction()
      const memberCalls: string[] = []
      const query = new GetMonthQuery(
        members('success', memberCalls),
        reads(noPlan),
        transaction,
        clock,
      )
      await expect(query.execute(value as never)).rejects.toBeInstanceOf(
        CommandValidationError,
      )
      expect(memberCalls).toEqual([])
      expect(clock.calls).toBe(0)
      expect(transaction.calls).toBe(0)
    },
  )

  it.each(['0001-01', '9999-12'])(
    'accepts canonical boundary month %s',
    async (targetMonth) => {
      const query = new GetMonthQuery(
        members(),
        reads({ ...noPlan, targetMonth }),
        new ImmediateTransaction(),
        new CountingClock(),
      )
      await expect(
        query.execute({
          trustedActor: { kind: 'member', id: memberId },
          targetMonth,
        }),
      ).resolves.toMatchObject({ state: 'no_plan', targetMonth })
    },
  )

  it('rejects the system actor before membership and persistence', async () => {
    const transaction = new ImmediateTransaction()
    const memberCalls: string[] = []
    const query = new GetTodayQuery(
      members('success', memberCalls),
      reads(noPlan),
      transaction,
      new CountingClock(),
    )
    await expect(
      query.execute({
        trustedActor: { kind: 'system', id: 'planner-worker' },
      }),
    ).rejects.toBeInstanceOf(TrackingAuthorizationDeniedError)
    expect(memberCalls).toEqual([])
    expect(transaction.calls).toBe(0)
  })

  it.each([
    [new WorkspaceMemberNotFoundError(), TrackingAuthorizationDeniedError],
    [
      new WorkspaceDependencyUnavailableError(),
      TrackingDependencyUnavailableError,
    ],
  ])(
    'maps workspace failure %s to a finite tracking error',
    async (failure, expected) => {
      const query = new GetTodayQuery(
        members(failure),
        reads(noPlan),
        new ImmediateTransaction(),
        new CountingClock(),
      )
      await expect(
        query.execute({ trustedActor: { kind: 'member', id: memberId } }),
      ).rejects.toBeInstanceOf(expected)
    },
  )
})
