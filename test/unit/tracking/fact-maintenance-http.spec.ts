import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'

import { toUserId } from '@/modules/auth/domain/user-id'
import type { TrackingApplication } from '@/modules/tracking/application/tracking-application'
import {
  CloseDayAlreadyClosedError,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
  FactCorrectionRequiredError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  WeeklyTaskTargetNotFoundError,
  WeeklyTaskTargetUnavailableError,
} from '@/modules/tracking/application/tracking-errors'
import { TRACKING_HTTP_PROBLEM_CONTRIBUTION } from '@/modules/tracking/composition/tracking-http-problem.contribution'
import { FactMaintenanceController } from '@/modules/tracking/presentation/fact-maintenance.controller'
import {
  CloseDayRequestDto,
  CorrectFactRequestDto,
  RecordWeeklyTaskResultRequestDto,
  toCloseDayPreviewResponse,
  toTrackingDayCloseMutationResponse,
} from '@/modules/tracking/presentation/fact-maintenance.dto'
import type { WorkspaceMemberResolver } from '@/modules/workspace'

const userId = toUserId('11111111-1111-4111-8111-111111111111')
const memberId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const factRecordId = '44444444-4444-4444-8444-444444444444'
const publicationId = '55555555-5555-4555-8555-555555555555'
const flexiblePeriodId = '66666666-6666-4666-8666-666666666666'
const commandId = '77777777-7777-4777-8777-777777777777'
const principal = { userId, sessionId: 'session' }

function members(): WorkspaceMemberResolver {
  return {
    resolveUser: jest.fn().mockResolvedValue({ userId, memberId, spaceId }),
  } as unknown as WorkspaceMemberResolver
}

describe('H03 fact maintenance HTTP adapter', () => {
  it('maps correction path, trusted actor, revision, typed value and reason', async () => {
    const execute = jest.fn().mockResolvedValue({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: 2n,
    })
    const controller = new FactMaintenanceController(
      { correctRecord: { execute } } as unknown as TrackingApplication,
      members(),
    )

    await expect(
      controller.correct(
        principal,
        { factRecordId },
        {
          commandId,
          expectedRevision: '1',
          value: { kind: 'text', text: 'Исправлено', result: 'done' },
          reason: 'Уточнение результата',
        },
      ),
    ).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: '2',
    })
    expect(execute).toHaveBeenCalledWith({
      commandId,
      trustedActor: { kind: 'member', id: memberId },
      expectedRevision: 1n,
      payload: {
        factRecordId,
        value: { kind: 'text', text: 'Исправлено', result: 'done' },
        reason: 'Уточнение результата',
      },
    })
  })

  it('maps CloseDay and weekly result without accepting an initial revision', async () => {
    const close = jest.fn().mockResolvedValue({
      kind: 'tracking.day-close.v1',
      aggregateId: factRecordId,
      aggregateRevision: 3n,
    })
    const weekly = jest.fn().mockResolvedValue({
      kind: 'tracking.fact-record.v1',
      aggregateId: factRecordId,
      aggregateRevision: 1n,
    })
    const controller = new FactMaintenanceController(
      {
        closeDay: { execute: close },
        recordWeeklyTaskResult: { execute: weekly },
      } as unknown as TrackingApplication,
      members(),
    )
    const hash = 'a'.repeat(64)

    await controller.closeDay(
      principal,
      { publicationId, localDate: '2026-08-14' },
      {
        commandId,
        expectedRevision: '2',
        previewSchemaVersion: 'tracking.close-day-preview.v1',
        previewHashVersion: 'tracking.close-day-preview-hash.v1',
        previewHash: hash,
      },
    )
    await controller.recordWeeklyTaskResult(
      principal,
      { publicationId, flexiblePeriodId },
      { commandId, result: 'not_done' },
    )

    expect(close).toHaveBeenCalledWith({
      commandId,
      trustedActor: { kind: 'member', id: memberId },
      expectedRevision: 2n,
      payload: {
        publicationId,
        localDate: '2026-08-14',
        previewSchemaVersion: 'tracking.close-day-preview.v1',
        previewHashVersion: 'tracking.close-day-preview-hash.v1',
        previewHash: hash,
      },
    })
    expect(weekly).toHaveBeenCalledWith({
      commandId,
      trustedActor: { kind: 'member', id: memberId },
      payload: { publicationId, flexiblePeriodId, result: 'not_done' },
    })
  })

  it('serializes both CloseDay preview variants and positive result revisions', () => {
    expect(
      toCloseDayPreviewResponse({
        schemaVersion: 'tracking.close-day-preview.v1',
        state: 'ready',
        publicationId,
        localDate: '2026-08-14',
        factsRevision: 0n,
        previewHashVersion: 'tracking.close-day-preview-hash.v1',
        previewHash: 'b'.repeat(64),
        unresolved: [],
      }),
    ).toMatchObject({ state: 'ready', factsRevision: '0' })
    expect(
      toCloseDayPreviewResponse({
        schemaVersion: 'tracking.close-day-preview.v1',
        state: 'closed',
        publicationId,
        localDate: '2026-08-14',
        dayCloseId: factRecordId,
        revision: 3n,
        closedAt: new Date('2026-08-14T10:00:00.000Z'),
        closedCount: 2,
      }),
    ).toMatchObject({
      state: 'closed',
      revision: '3',
      closedAt: '2026-08-14T10:00:00.000Z',
    })
    expect(
      toTrackingDayCloseMutationResponse({
        kind: 'tracking.day-close.v1',
        aggregateId: factRecordId,
        aggregateRevision: 3n,
      }),
    ).toEqual({
      kind: 'tracking.day-close.v1',
      aggregateId: factRecordId,
      aggregateRevision: '3',
    })
  })

  it('enforces exact bodies, revisions, versions and hash boundaries', async () => {
    const correction = {
      commandId,
      expectedRevision: '1',
      value: { kind: 'boolean', result: 'done' },
      reason: 'Исправлено',
    }
    await expect(
      validate(plainToInstance(CorrectFactRequestDto, correction), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).resolves.toEqual([])
    for (const reason of ['', '   ', 'x'.repeat(2_001)]) {
      const errors = await validate(
        plainToInstance(CorrectFactRequestDto, { ...correction, reason }),
        { whitelist: true, forbidNonWhitelisted: true },
      )
      expect(errors.map((error) => error.property)).toContain('reason')
    }
    await expect(
      validate(
        plainToInstance(CorrectFactRequestDto, {
          ...correction,
          reason: 'x'.repeat(2_000),
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).resolves.toEqual([])
    const forbidden = await validate(
      plainToInstance(CorrectFactRequestDto, {
        ...correction,
        actor: memberId,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(forbidden.map((error) => error.property)).toContain('actor')
    const close = await validate(
      plainToInstance(CloseDayRequestDto, {
        commandId,
        expectedRevision: '-1',
        previewSchemaVersion: 'wrong',
        previewHashVersion: 'tracking.close-day-preview-hash.v1',
        previewHash: 'a'.repeat(63),
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(close.map((error) => error.property).sort()).toEqual([
      'expectedRevision',
      'previewHash',
      'previewSchemaVersion',
    ])
    const weekly = await validate(
      plainToInstance(RecordWeeklyTaskResultRequestDto, {
        commandId,
        result: 'done',
        expectedRevision: '1',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(weekly.map((error) => error.property)).toEqual(['expectedRevision'])
  })

  it('maps finite recovery conflicts without losing aggregate references', () => {
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(new FactTargetNotFoundError()),
    ).toEqual({ code: 'TRACKING_FACT_TARGET_NOT_FOUND' })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new FactTargetUnavailableError('closed'),
      ),
    ).toEqual({
      code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
      conflict: { reason: 'closed' },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new FactUndoUnavailableError('superseded'),
      ),
    ).toEqual({
      code: 'TRACKING_FACT_UNDO_UNAVAILABLE',
      conflict: {
        reason: 'superseded',
        nextAction: 'reload-tracking-state',
      },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new FactCorrectionRequiredError({ factRecordId, revision: 2n }),
      ),
    ).toMatchObject({
      code: 'TRACKING_FACT_CORRECTION_REQUIRED',
      conflict: { factRecordId, revision: '2' },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new CloseDayRevisionConflictError(1n, 2n),
      ),
    ).toMatchObject({
      code: 'TRACKING_CLOSE_DAY_REVISION_CONFLICT',
      conflict: { expectedRevision: '1', currentRevision: '2' },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new CloseDayPreviewConflictError(),
      ),
    ).toMatchObject({ code: 'TRACKING_CLOSE_DAY_PREVIEW_CONFLICT' })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new CloseDayAlreadyClosedError({
          dayCloseId: factRecordId,
          revision: 3n,
        }),
      ),
    ).toMatchObject({
      code: 'TRACKING_CLOSE_DAY_ALREADY_CLOSED',
      conflict: { dayCloseId: factRecordId, revision: '3' },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(new CloseDayTargetNotFoundError()),
    ).toEqual({ code: 'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND' })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new CloseDayTargetUnavailableError('closed'),
      ),
    ).toEqual({
      code: 'TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE',
      conflict: { reason: 'closed' },
    })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new WeeklyTaskTargetNotFoundError(),
      ),
    ).toEqual({ code: 'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND' })
    expect(
      TRACKING_HTTP_PROBLEM_CONTRIBUTION.map(
        new WeeklyTaskTargetUnavailableError('stale_period'),
      ),
    ).toEqual({
      code: 'TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE',
      conflict: { reason: 'stale_period' },
    })
  })
})
