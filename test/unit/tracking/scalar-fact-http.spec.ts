import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'

import { toUserId } from '@/modules/auth/domain/user-id'
import type { TrackingApplication } from '@/modules/tracking/application/tracking-application'
import { ScalarFactController } from '@/modules/tracking/presentation/scalar-fact.controller'
import {
  RecordFactRequestDto,
  RecordTimeRequestDto,
  toTrackingFactMutationResponse,
} from '@/modules/tracking/presentation/scalar-fact.dto'
import type { WorkspaceMemberResolver } from '@/modules/workspace'

const userId = toUserId('11111111-1111-4111-8111-111111111111')
const memberId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const publicationId = '44444444-4444-4444-8444-444444444444'
const snapshotId = '55555555-5555-4555-8555-555555555555'
const commandId = '66666666-6666-4666-8666-666666666666'

describe('H01 scalar fact HTTP adapter', () => {
  it('maps only the verified session member and decimal revision into RecordFact', async () => {
    const execute = jest.fn().mockResolvedValue({
      kind: 'tracking.fact-record.v1',
      aggregateId: '77777777-7777-4777-8777-777777777777',
      aggregateRevision: 1n,
    })
    const tracking = {
      recordFact: { execute },
    } as unknown as TrackingApplication
    const members = {
      resolveUser: jest.fn().mockResolvedValue({ userId, memberId, spaceId }),
    } as unknown as WorkspaceMemberResolver
    const controller = new ScalarFactController(tracking, members)

    await expect(
      controller.recordFact(
        { userId, sessionId: 'session' },
        {
          commandId,
          expectedRevision: '2',
          publicationId,
          planGoalSnapshotId: snapshotId,
          localDate: '2026-08-14',
          value: { kind: 'boolean', result: 'done' },
        },
      ),
    ).resolves.toEqual({
      kind: 'tracking.fact-record.v1',
      aggregateId: '77777777-7777-4777-8777-777777777777',
      aggregateRevision: '1',
    })
    expect(execute).toHaveBeenCalledWith({
      commandId,
      trustedActor: { kind: 'member', id: memberId },
      expectedRevision: 2n,
      payload: {
        publicationId,
        planGoalSnapshotId: snapshotId,
        localDate: '2026-08-14',
        value: { kind: 'boolean', result: 'done' },
      },
    })
  })

  it('keeps T02 create DTO revision-free and rejects unknown actor fields', async () => {
    const value = {
      commandId,
      publicationId,
      planGoalSnapshotId: snapshotId,
      expectationDate: '2026-08-14',
      value: '08:30',
      expectedRevision: '1',
      actor: memberId,
    }
    const errors = await validate(
      plainToInstance(RecordTimeRequestDto, value),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      },
    )
    expect(errors.map((error) => error.property).sort()).toEqual([
      'actor',
      'expectedRevision',
    ])
  })

  it('accepts an absent or positive RecordFact revision and rejects zero', async () => {
    const base = {
      commandId,
      publicationId,
      planGoalSnapshotId: snapshotId,
      localDate: '2026-08-14',
      value: { kind: 'quantity', value: '1.5' },
    }
    await expect(
      validate(plainToInstance(RecordFactRequestDto, base), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).resolves.toEqual([])
    const invalid = await validate(
      plainToInstance(RecordFactRequestDto, {
        ...base,
        expectedRevision: '0',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    )
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.property).toBe('expectedRevision')
  })

  it('serializes only positive fact revisions', () => {
    expect(() =>
      toTrackingFactMutationResponse({
        kind: 'tracking.fact-record.v1',
        aggregateId: snapshotId,
        aggregateRevision: 0n,
      }),
    ).toThrow('Expected positive fact revision')
  })
})
