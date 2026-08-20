import type { StoredTelegramActionIntent } from '@/modules/telegram-bot'
import {
  compositeCommandForIntent,
  compositeFingerprintForIntent,
} from '@/modules/telegram-bot'

const member = {
  spaceId: '33333333-3333-4333-8333-333333333333',
  memberId: '44444444-4444-4444-8444-444444444444',
  userId: '11111111-1111-4111-8111-111111111111',
}

function intent(
  overrides: Partial<StoredTelegramActionIntent>,
): StoredTelegramActionIntent {
  const base: StoredTelegramActionIntent = {
    actionIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    localDate: '2026-04-10',
    sourceFactsRevision: 3n,
    currentFactsRevision: 3n,
    activePublicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    monthStatus: 'published',
    intentKind: 'text',
    state: 'ready',
    checkpointId: null,
    booleanResult: null,
    textResult: 'done',
    checklistItemId: null,
    checklistItemState: null,
    orVariantId: null,
    quantityValue: null,
    actualTimeValue: null,
    ratingValue: null,
    textValue: 'Готово',
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
    title: 'Journal',
    unit: null,
    precision: null,
    aggregation: null,
    result: null,
  }
  return { ...base, ...overrides }
}

describe('G04 composite Telegram fact command mapping', () => {
  it.each([
    [
      intent({}),
      'text',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Готово',
        result: 'done',
      },
    ],
    [
      intent({
        intentKind: 'checkpoint_text',
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
      'text',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        text: 'Готово',
        result: 'done',
      },
    ],
    [
      intent({
        intentKind: 'checklist_item',
        textResult: null,
        checklistItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        checklistItemState: 'not_done',
        textValue: null,
      }),
      'checklist',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        checkpointId: null,
        checklistItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        state: 'not_done',
      },
    ],
    [
      intent({
        intentKind: 'checkpoint_or_variant',
        textResult: null,
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        orVariantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        orVariantValue: '1.5',
        textValue: null,
      }),
      'or_variant',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectationDate: '2026-04-10',
        checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        variantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        value: '1.5',
      },
    ],
    [
      intent({
        intentKind: 'composite_checklist_item',
        textResult: null,
        checklistItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        checklistItemState: 'done',
        textValue: null,
      }),
      'composite',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        localDate: '2026-04-10',
        component: {
          kind: 'checklist_item',
          checklistItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          state: 'done',
        },
      },
    ],
    [
      intent({
        intentKind: 'composite_or_variant',
        textResult: null,
        orVariantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        orVariantValue: '2',
        textValue: null,
      }),
      'composite',
      {
        publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        planGoalSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        localDate: '2026-04-10',
        component: {
          kind: 'or_variant',
          variantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          value: '2',
        },
      },
    ],
  ] as const)(
    'maps %s through the existing T03/T04 command',
    (stored, kind, payload) => {
      const mapped = compositeCommandForIntent(member, stored)
      expect(mapped).toMatchObject({
        kind,
        command: {
          commandId: stored.actionIntentId,
          trustedActor: { kind: 'member', id: member.memberId },
          payload,
        },
      })
      expect(compositeFingerprintForIntent(member, stored)).toMatch(
        /^[0-9a-f]{64}$/u,
      )
    },
  )

  it('changes the fingerprint when a component or text result changes', () => {
    const base = intent({})
    expect(compositeFingerprintForIntent(member, base)).not.toBe(
      compositeFingerprintForIntent(member, {
        ...base,
        textResult: 'not_done',
      }),
    )
    const checklist = intent({
      intentKind: 'checklist_item',
      textResult: null,
      textValue: null,
      checklistItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      checklistItemState: 'done',
    })
    expect(compositeFingerprintForIntent(member, checklist)).not.toBe(
      compositeFingerprintForIntent(member, {
        ...checklist,
        checklistItemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    )
  })
})
