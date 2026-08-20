import type { StoredTelegramActionIntent } from '@/modules/telegram-bot'
import {
  scalarCommandForIntent,
  scalarFingerprintForIntent,
} from '@/modules/telegram-bot'

const member = {
  spaceId: '33333333-3333-4333-8333-333333333333',
  memberId: '44444444-4444-4444-8444-444444444444',
  userId: '11111111-1111-4111-8111-111111111111',
}

function intent(
  overrides: Partial<StoredTelegramActionIntent>,
): StoredTelegramActionIntent {
  return {
    actionIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    localDate: '2026-04-10',
    sourceFactsRevision: 9_007_199_254_740_993n,
    currentFactsRevision: 9_007_199_254_740_993n,
    activePublicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    monthStatus: 'published',
    intentKind: 'actual_time',
    state: 'ready',
    checkpointId: null,
    booleanResult: null,
    textResult: null,
    checklistItemId: null,
    checklistItemState: null,
    orVariantId: null,
    quantityValue: null,
    actualTimeValue: '00:30',
    ratingValue: null,
    textValue: null,
    orVariantValue: null,
    commandFingerprint: null,
    expiresAt: new Date('2026-04-10T07:15:00.000Z'),
    title: 'Sleep',
    unit: null,
    precision: null,
    aggregation: null,
    result: null,
    ...overrides,
  }
}

describe('G03 scalar Telegram fact command mapping', () => {
  it.each([
    [
      intent({}),
      'time',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        value: '00:30',
      },
    ],
    [
      intent({
        intentKind: 'rating',
        actualTimeValue: null,
        ratingValue: BigInt(Number.MIN_SAFE_INTEGER),
      }),
      'rating',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        value: Number.MIN_SAFE_INTEGER,
      },
    ],
    [
      intent({
        intentKind: 'checkpoint_rating',
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        actualTimeValue: null,
        ratingValue: BigInt(Number.MAX_SAFE_INTEGER),
      }),
      'checkpoint',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        value: { kind: 'rating', value: Number.MAX_SAFE_INTEGER },
      },
    ],
  ] as const)(
    'maps %s through the existing T02 command',
    (stored, kind, payload) => {
      const mapped = scalarCommandForIntent(member, stored)
      expect(mapped).toMatchObject({
        kind,
        command: {
          commandId: stored.actionIntentId,
          trustedActor: { kind: 'member', id: member.memberId },
          payload,
        },
      })
      expect(scalarFingerprintForIntent(member, stored)).toMatch(
        /^[0-9a-f]{64}$/u,
      )
    },
  )

  it('rejects a rating bigint before unsafe conversion to number', () => {
    const stored = intent({
      intentKind: 'rating',
      actualTimeValue: null,
      ratingValue: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    })
    expect(scalarCommandForIntent(member, stored)).toBeNull()
    expect(scalarFingerprintForIntent(member, stored)).toBeNull()
  })
})
