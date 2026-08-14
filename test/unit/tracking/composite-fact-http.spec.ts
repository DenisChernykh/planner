import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'

import { toUserId } from '@/modules/auth/domain/user-id'
import type { TrackingApplication } from '@/modules/tracking/application/tracking-application'
import type { RecordCompositeOccurrenceApplicationCommand } from '@/modules/tracking/application/tracking.types'
import { CompositeFactController } from '@/modules/tracking/presentation/composite-fact.controller'
import {
  RecordCompositeOccurrenceRequestDto,
  RecordTextRequestDto,
} from '@/modules/tracking/presentation/composite-fact.dto'
import type { WorkspaceMemberResolver } from '@/modules/workspace'

const userId = toUserId('11111111-1111-4111-8111-111111111111')
const memberId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const publicationId = '44444444-4444-4444-8444-444444444444'
const snapshotId = '55555555-5555-4555-8555-555555555555'
const componentId = '66666666-6666-4666-8666-666666666666'
const commandId = '77777777-7777-4777-8777-777777777777'

describe('H02 composite fact HTTP adapter', () => {
  it('maps the verified session member and exact text payload', async () => {
    const execute = jest.fn().mockResolvedValue({
      kind: 'tracking.fact-record.v1',
      aggregateId: '88888888-8888-4888-8888-888888888888',
      aggregateRevision: 1n,
    })
    const tracking = {
      recordText: { execute },
    } as unknown as TrackingApplication
    const members = {
      resolveUser: jest.fn().mockResolvedValue({ userId, memberId, spaceId }),
    } as unknown as WorkspaceMemberResolver
    const controller = new CompositeFactController(tracking, members)

    await expect(
      controller.recordText(
        { userId, sessionId: 'session' },
        {
          commandId,
          publicationId,
          planGoalSnapshotId: snapshotId,
          expectationDate: '2026-08-14',
          checkpointId: null,
          text: 'Готово',
          result: 'done',
        },
      ),
    ).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: '88888888-8888-4888-8888-888888888888',
      aggregateRevision: '1',
    })
    expect(execute).toHaveBeenCalledWith({
      commandId,
      trustedActor: { kind: 'member', id: memberId },
      payload: {
        publicationId,
        planGoalSnapshotId: snapshotId,
        expectationDate: '2026-08-14',
        checkpointId: null,
        text: 'Готово',
        result: 'done',
      },
    })
  })

  it('maps both flexible composite component discriminators unchanged', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'tracking.fact-record.v1',
        aggregateId: '88888888-8888-4888-8888-888888888888',
        aggregateRevision: 1n,
      })
      .mockResolvedValueOnce({
        kind: 'tracking.fact-record.v1',
        aggregateId: '99999999-9999-4999-8999-999999999999',
        aggregateRevision: 1n,
      })
    const members = {
      resolveUser: jest.fn().mockResolvedValue({ userId, memberId, spaceId }),
    } as unknown as WorkspaceMemberResolver
    const controller = new CompositeFactController(
      {
        recordCompositeOccurrence: { execute },
      } as unknown as TrackingApplication,
      members,
    )
    const principal = { userId, sessionId: 'session' }

    await controller.recordCompositeOccurrence(principal, {
      commandId,
      publicationId,
      planGoalSnapshotId: snapshotId,
      localDate: '2026-08-14',
      component: {
        kind: 'checklist_item',
        checklistItemId: componentId,
        state: 'not_done',
      },
    })
    await controller.recordCompositeOccurrence(principal, {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      publicationId,
      planGoalSnapshotId: snapshotId,
      localDate: '2026-08-14',
      component: { kind: 'or_variant', variantId: componentId, value: '1.5' },
    })

    const calls = execute.mock.calls as unknown as readonly (readonly [
      RecordCompositeOccurrenceApplicationCommand,
    ])[]
    expect(calls.map(([value]) => value.payload.component)).toEqual([
      {
        kind: 'checklist_item',
        checklistItemId: componentId,
        state: 'not_done',
      },
      { kind: 'or_variant', variantId: componentId, value: '1.5' },
    ])
  })

  it('forbids actor and expectedRevision and requires explicit checkpoint null', async () => {
    const base = {
      commandId,
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-08-14',
      checkpointId: null,
      text: 'Готово',
      result: 'done',
    }
    await expect(
      validate(plainToInstance(RecordTextRequestDto, base), {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      }),
    ).resolves.toEqual([])
    const forbidden = await validate(
      plainToInstance(RecordTextRequestDto, {
        ...base,
        actor: memberId,
        expectedRevision: '1',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(forbidden.map((error) => error.property).sort()).toEqual([
      'actor',
      'expectedRevision',
    ])
    const missingCheckpoint = await validate(
      plainToInstance(RecordTextRequestDto, {
        ...base,
        checkpointId: undefined,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(missingCheckpoint.map((error) => error.property)).toContain(
      'checkpointId',
    )
  })

  it('validates outer flexible occurrence shape before application mapping', async () => {
    const invalid = await validate(
      plainToInstance(RecordCompositeOccurrenceRequestDto, {
        commandId,
        publicationId,
        planGoalSnapshotId: snapshotId,
        localDate: '2026-13-14',
        component: 'invalid',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(invalid.map((error) => error.property).sort()).toEqual([
      'component',
      'localDate',
    ])
  })
})
