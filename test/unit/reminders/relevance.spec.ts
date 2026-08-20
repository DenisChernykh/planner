import { buildReminderContent } from '@/modules/reminders/domain/reminder-relevance'
import { BuildReminderIntentCommand } from '@/modules/reminders/application/build-reminder-intent.command'
import { ReminderIntentClaimStaleError } from '@/modules/reminders/application/reminder-errors'
import type {
  ReminderIntentPersistencePort,
  ReminderSlotKind,
  ReminderTodayReadPort,
} from '@/modules/reminders/application/reminder.types'
import type { TrackingTodayReadModelV1 } from '@/modules/tracking/application/tracking-read.types'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

type PublishedToday = Extract<TrackingTodayReadModelV1, { state: 'published' }>

const memberId = '44444444-4444-4444-8444-444444444444'
const goalId = '66666666-6666-4666-8666-666666666666'
const fixedId = '77777777-7777-4777-8777-777777777777'

function read(overrides?: Record<string, unknown>): PublishedToday {
  const goal = {
    planGoalSnapshotId: goalId,
    sourceGoalSeriesId: '88888888-8888-4888-8888-888888888888',
    title: 'Вода',
    why: '',
    category: 'Здоровье',
    displayOrder: 1,
    viewerAccess: 'personal_owner' as const,
    config: {
      schemaVersion: 1 as const,
      scope: { kind: 'personal' as const, ownerMemberId: memberId },
      repetition: { kind: 'daily' as const },
      measurement: {
        kind: 'quantity' as const,
        mode: 'targeted' as const,
        unit: 'мл',
        precision: 0 as const,
        aggregation: 'add' as const,
        target: '10',
      },
      checkpoints: null,
    },
    calendar: {} as never,
    progress: {} as never,
  }
  const dayGoal = {
    planGoalSnapshotId: goalId,
    applicable: true,
    writable: true,
    state: 'partial' as const,
    coverage: { filled: '1', applicable: '1' },
    progress: {} as never,
    fixedExpectations: [
      {
        fixedExpectationId: fixedId,
        componentKind: 'goal' as const,
        componentId: null,
        state: 'partial' as const,
        facts: [
          {
            factRecordId: '99999999-9999-4999-8999-999999999999',
            revision: 1n,
            factKind: 'quantity_add' as const,
            contributionId: null,
            checklistItemId: null,
            orVariantId: null,
            revisionKind: 'recorded' as const,
            value: { kind: 'quantity' as const, value: '4' },
            recordedByMemberId: memberId,
            recordedBySystemActorId: null,
          },
        ],
      },
    ],
    flexiblePeriods: [],
  }
  return {
    schemaVersion: 'tracking.today.v1',
    state: 'published',
    planMonthId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lifecycleRevision: 1n,
    factsRevision: 2n,
    monthStatus: 'published',
    phase: 'active',
    publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    publicationRevision: 1n,
    activeLocalDate: '2026-03-30',
    latePublication: false,
    focus: 'Фокус месяца',
    queryLocalDate: '2026-03-30',
    targetMonth: '2026-03',
    goals: [goal],
    day: {
      localDate: '2026-03-30',
      closure: {
        state: 'open',
        dayCloseId: null,
        revision: null,
        closedAt: null,
        closedCount: null,
      },
      state: 'partial',
      coverage: { filled: '1', applicable: '1' },
      goals: [dayGoal],
    },
    ...overrides,
  } as unknown as PublishedToday
}

function content(
  slotKind: ReminderSlotKind,
  value = read(),
): ReturnType<typeof buildReminderContent> {
  return buildReminderContent({
    read: value,
    localDate: '2026-03-30',
    localTime: slotKind === 'morning' ? '08:00' : '19:00',
    slotKind,
  })
}

describe('reminder relevance policy', () => {
  it('keeps a partial targeted quantity with an exact remainder and morning focus', () => {
    expect(content('morning')).toMatchObject({
      focus: 'Фокус месяца',
      items: [
        expect.objectContaining({
          kind: 'fixed',
          remaining: '6',
          state: 'partial',
        }),
      ],
    })
  })

  it('does not show a fixed item before its time deadline in the day slot', () => {
    const baseline = read()
    const value = read({
      goals: [
        {
          ...baseline.goals[0],
          config: {
            ...baseline.goals[0]!.config,
            measurement: { kind: 'actual_time', start: '08:00', end: '18:00' },
          },
        },
      ],
    })
    expect(
      buildReminderContent({
        read: value,
        localDate: '2026-03-30',
        localTime: '13:00',
        slotKind: 'day',
      }),
    ).toBeNull()
  })

  it('suppresses focus-only, completed and partner-private content', () => {
    const completed = read({
      day: {
        ...read().day,
        goals: [
          {
            ...read().day.goals[0]!,
            fixedExpectations: [
              { ...read().day.goals[0]!.fixedExpectations[0]!, state: 'done' },
            ],
          },
        ],
      },
    })
    expect(content('morning', completed)).toBeNull()
    const partnerOnly = read({
      goals: [{ ...read().goals[0]!, viewerAccess: 'partner_read_only' }],
    })
    expect(content('morning', partnerOnly)).toBeNull()
  })

  it('suppresses informational and completed flexible periods', () => {
    const baseline = read()
    const value = read({
      goals: [
        {
          ...baseline.goals[0]!,
          config: {
            ...baseline.goals[0]!.config,
            measurement: {
              kind: 'quantity',
              mode: 'informational',
              unit: 'руб.',
              precision: 0,
              aggregation: 'add',
              target: null,
            },
          },
        },
      ],
      day: {
        ...baseline.day,
        goals: [
          {
            ...baseline.day.goals[0]!,
            flexiblePeriods: [
              {
                flexiblePeriodId: fixedId,
                periodKind: 'monthly',
                ordinal: 1,
                periodStart: '2026-03-01',
                periodEnd: '2026-03-31',
                periodTarget: 10,
                eligibleOnDate: true,
                expectedProgress: 1,
                actualProgress: { numerator: '1', denominator: '1' },
                state: 'done',
                facts: [],
              },
            ],
          },
        ],
      },
    })
    expect(content('evening', value)).toBeNull()
  })

  it('uses a checkpoint satisfaction target for an exact partial remainder', () => {
    const baseline = read()
    const value = read({
      goals: [
        {
          ...baseline.goals[0]!,
          config: {
            ...baseline.goals[0]!.config,
            checkpoints: {
              aggregation: 'independent',
              items: [
                {
                  checkpointId: fixedId,
                  name: 'Checkpoint',
                  deadline: '08:00',
                  satisfaction: { kind: 'quantity', target: '5' },
                },
              ],
            },
          },
        },
      ],
      day: {
        ...baseline.day,
        goals: [
          {
            ...baseline.day.goals[0]!,
            fixedExpectations: [
              {
                ...baseline.day.goals[0]!.fixedExpectations[0]!,
                componentKind: 'checkpoint',
                componentId: fixedId,
              },
            ],
          },
        ],
      },
    })
    expect(content('morning', value)).toMatchObject({
      items: [expect.objectContaining({ kind: 'checkpoint', remaining: '1' })],
    })
  })

  it('suppresses inactive lifecycle and absent-plan reads', () => {
    expect(content('morning', read({ phase: 'grace' }))).toBeNull()
    expect(
      buildReminderContent({
        read: { state: 'no_plan' },
        localDate: '2026-03-30',
        localTime: '08:00',
        slotKind: 'morning',
      }),
    ).toBeNull()
  })

  it('does not persist when the claim expires during the authoritative reread', async () => {
    const clock = new FakeProductClock(new Date('2026-03-30T07:00:00.000Z'))
    const claim = {
      occurrenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipientMemberId: memberId,
      localDate: '2026-03-30',
      slotKind: 'morning' as const,
      dueAt: new Date('2026-03-30T06:59:00.000Z'),
      expiresAt: new Date('2026-03-30T07:00:01.000Z'),
      fencingToken: 1n,
    }
    let transactionCalls = 0
    let persistenceCalls = 0
    const today: ReminderTodayReadPort = {
      getToday: () => {
        clock.set(new Date('2026-03-30T07:00:01.000Z'))
        return Promise.resolve(read())
      },
    }
    const persistence: ReminderIntentPersistencePort = {
      persistIntent: () => {
        persistenceCalls += 1
        return Promise.reject(new Error('persistence must not be reached'))
      },
    }
    const transaction: DatabaseTransactionPort = {
      run: async (operation) => {
        transactionCalls += 1
        return operation()
      },
    }
    await expect(
      new BuildReminderIntentCommand(
        today,
        persistence,
        transaction,
        clock,
      ).execute({ claim, leaseOwner: 'worker-a' }),
    ).rejects.toBeInstanceOf(ReminderIntentClaimStaleError)
    expect(transactionCalls).toBe(0)
    expect(persistenceCalls).toBe(0)
  })
})
