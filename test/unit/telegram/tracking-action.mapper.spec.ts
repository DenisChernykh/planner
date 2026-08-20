import {
  FactUndoUnavailableError,
  TrackingAuthorizationDeniedError,
  type TrackingApplication,
} from '@/modules/tracking'
import {
  executeTrackingIntent,
  trackingCommandForIntent,
  trackingFingerprintForIntent,
} from '@/modules/telegram-bot/application/tracking-action.mapper'

import type { StoredTelegramActionIntent } from '@/modules/telegram-bot/application/action-intent.types'

const member = {
  spaceId: '018f0000-0000-7000-8000-000000000001',
  memberId: '018f0000-0000-7000-8000-000000000002',
  userId: '018f0000-0000-7000-8000-000000000003',
} as const

function intent(
  input: Partial<StoredTelegramActionIntent> &
    Pick<StoredTelegramActionIntent, 'intentKind'>,
): StoredTelegramActionIntent {
  return {
    actionIntentId: '018f0000-0000-7000-8000-000000000010',
    commandId: '018f0000-0000-7000-8000-000000000010',
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: '018f0000-0000-7000-8000-000000000011',
    planGoalSnapshotId: '018f0000-0000-7000-8000-000000000012',
    localDate: '2026-04-10',
    sourceFactsRevision: 4n,
    currentFactsRevision: 4n,
    activePublicationId: '018f0000-0000-7000-8000-000000000011',
    monthStatus: 'published',
    state: 'ready',
    checkpointId: null,
    booleanResult: null,
    textResult: null,
    checklistItemId: null,
    checklistItemState: null,
    orVariantId: null,
    quantityValue: null,
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
    expiresAt: new Date('2026-04-10T12:15:00.000Z'),
    title: 'Цель',
    unit: null,
    precision: null,
    aggregation: null,
    result: null,
    ...input,
  }
}

describe('G05 Telegram tracking action mapping', () => {
  it('maps correction, delete, undo, CloseDay and weekly result through trusted commands', () => {
    const factRecordId = '018f0000-0000-7000-8000-000000000020'
    const flexiblePeriodId = '018f0000-0000-7000-8000-000000000021'

    expect(
      trackingCommandForIntent(
        member,
        intent({
          intentKind: 'correct_boolean',
          factRecordId,
          expectedRecordRevision: 2n,
          booleanResult: 'done',
          reason: 'Исправлена ошибка',
        }),
      ),
    ).toMatchObject({
      kind: 'correct',
      command: {
        trustedActor: { kind: 'member', id: member.memberId },
        expectedRevision: 2n,
        payload: {
          factRecordId,
          value: { kind: 'boolean', result: 'done' },
          reason: 'Исправлена ошибка',
        },
      },
    })

    expect(
      trackingCommandForIntent(
        member,
        intent({
          intentKind: 'delete_record',
          factRecordId,
          expectedRecordRevision: 2n,
          reason: 'Запись лишняя',
        }),
      )?.kind,
    ).toBe('delete')
    expect(
      trackingCommandForIntent(
        member,
        intent({
          intentKind: 'undo_record',
          factRecordId,
          expectedRecordRevision: 2n,
        }),
      )?.kind,
    ).toBe('undo')
    expect(
      trackingCommandForIntent(
        member,
        intent({
          intentKind: 'close_day',
          planGoalSnapshotId: null,
          closePreviewSchemaVersion: 'tracking.close-day-preview.v1',
          closePreviewHashVersion: 'tracking.close-day-preview-hash.v1',
          closePreviewHash: 'a'.repeat(64),
        }),
      ),
    ).toMatchObject({ kind: 'close_day', command: { expectedRevision: 4n } })
    expect(
      trackingCommandForIntent(
        member,
        intent({
          intentKind: 'weekly_task_result',
          flexiblePeriodId,
          booleanResult: 'not_done',
        }),
      )?.kind,
    ).toBe('weekly_task_result')
  })

  it('rejects incomplete tracking action payloads before command execution', () => {
    expect(
      trackingCommandForIntent(
        member,
        intent({ intentKind: 'correct_quantity' }),
      ),
    ).toBeNull()
    expect(
      trackingCommandForIntent(member, intent({ intentKind: 'close_day' })),
    ).toBeNull()
  })

  it.each([
    [new FactUndoUnavailableError('not_latest'), 'stale'],
    [new TrackingAuthorizationDeniedError(), 'blocked'],
  ] as const)(
    'maps partner/system-action Undo denial %p to %s recovery',
    async (error, outcome) => {
      const candidate = intent({
        intentKind: 'undo_record',
        factRecordId: '018f0000-0000-7000-8000-000000000020',
        expectedRecordRevision: 2n,
      })
      const ready = {
        ...candidate,
        commandFingerprint: trackingFingerprintForIntent(member, candidate),
      }
      const tracking = {
        undoLastOwnAction: { execute: jest.fn().mockRejectedValue(error) },
      } as unknown as TrackingApplication

      await expect(
        executeTrackingIntent(tracking, member, ready),
      ).resolves.toEqual({ kind: outcome })
    },
  )
})
