import {
  FactTargetUnavailableError,
  FactValueInvalidError,
  type TrackingApplication,
} from '@/modules/tracking'
import {
  commandForIntent,
  executeBasicFactIntent,
  fingerprintForIntent,
  type StoredTelegramActionIntent,
} from '@/modules/telegram-bot'

const member = {
  spaceId: '33333333-3333-4333-8333-333333333333',
  memberId: '44444444-4444-4444-8444-444444444444',
  userId: '11111111-1111-4111-8111-111111111111',
}

function intent(
  overrides: Partial<StoredTelegramActionIntent> = {},
): StoredTelegramActionIntent {
  const base: StoredTelegramActionIntent = {
    actionIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    localDate: '2026-04-10',
    sourceFactsRevision: 0n,
    currentFactsRevision: 0n,
    activePublicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    monthStatus: 'published',
    intentKind: 'quantity',
    state: 'ready',
    checkpointId: null,
    booleanResult: null,
    textResult: null,
    checklistItemId: null,
    checklistItemState: null,
    orVariantId: null,
    quantityValue: '400',
    actualTimeValue: null,
    ratingValue: null,
    textValue: null,
    orVariantValue: null,
    factRecordId: null,
    expectedRecordRevision: null,
    flexiblePeriodId: null,
    reason: null,
    closePreviewSchemaVersion: null,
    closePreviewHashVersion: null,
    closePreviewHash: null,
    closeUnresolvedCount: null,
    commandFingerprint: null,
    expiresAt: new Date('2026-04-10T07:15:00.000Z'),
    title: 'Water',
    unit: 'ml',
    precision: 0,
    aggregation: 'add',
    result: null,
  }
  const candidate = { ...base, ...overrides }
  return {
    ...candidate,
    commandFingerprint:
      overrides.commandFingerprint === undefined
        ? fingerprintForIntent(member, candidate)
        : overrides.commandFingerprint,
  }
}

describe('G02 basic Telegram fact command mapping', () => {
  it('uses the semantic intent ID as the T01 command ID', () => {
    const value = intent()
    expect(commandForIntent(member, value)).toEqual({
      commandId: value.actionIntentId,
      trustedActor: { kind: 'member', id: member.memberId },
      payload: {
        publicationId: value.publicationId,
        planGoalSnapshotId: value.planGoalSnapshotId,
        localDate: value.localDate,
        value: { kind: 'quantity', value: '400' },
      },
    })
    expect(fingerprintForIntent(member, value)).not.toBe(
      fingerprintForIntent(member, { ...value, quantityValue: '800' }),
    )
  })

  it.each([
    [new FactTargetUnavailableError('closed'), 'stale'],
    [new FactValueInvalidError(), 'blocked'],
  ] as const)('maps finite T01 failure %p to %s', async (error, outcome) => {
    const tracking = {
      recordFact: { execute: jest.fn().mockRejectedValue(error) },
    } as unknown as TrackingApplication
    await expect(
      executeBasicFactIntent(tracking, member, intent()),
    ).resolves.toEqual({
      kind: outcome,
    })
  })
})
