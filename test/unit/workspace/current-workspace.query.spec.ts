import {
  CurrentWorkspaceAuthorizationDeniedError,
  CurrentWorkspaceDependencyUnavailableError,
  CurrentWorkspaceStateConflictError,
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'
import { GetCurrentWorkspaceQuery } from '@/modules/workspace/application/get-current-workspace.query'
import type {
  CurrentWorkspaceReadPort,
  CurrentWorkspaceSnapshot,
} from '@/modules/workspace/application/current-workspace.read.port'
import {
  existingMemberId,
  existingSpaceId,
} from '@/modules/workspace/domain/workspace-ids'

const currentMemberId = existingMemberId('44444444-4444-4444-8444-444444444444')
const partnerMemberId = existingMemberId('55555555-5555-4555-8555-555555555555')
const spaceId = existingSpaceId('33333333-3333-4333-8333-333333333333')

function snapshot(
  overrides: Partial<
    Awaited<ReturnType<CurrentWorkspaceReadPort['readByUser']>>
  > = {},
): CurrentWorkspaceSnapshot {
  return {
    spaceId,
    currentMemberId,
    members: [{ memberId: currentMemberId }, { memberId: partnerMemberId }],
    denisMemberId: null,
    tanyaMemberId: null,
    ...overrides,
  }
}

function query(read: CurrentWorkspaceReadPort): GetCurrentWorkspaceQuery {
  return new GetCurrentWorkspaceQuery(read)
}

describe('GetCurrentWorkspaceQuery', () => {
  it('returns current-first relative labels before persona binding', async () => {
    const result = await query({
      readByUser: () => Promise.resolve(snapshot()),
    }).execute({ trustedUserId: '11111111-1111-4111-8111-111111111111' })

    expect(result).toEqual({
      schemaVersion: 'workspace.current.v1',
      spaceId,
      timeZone: 'Asia/Yekaterinburg',
      currentMemberId,
      personaMappingState: 'unbound',
      members: [
        {
          memberId: currentMemberId,
          relation: 'current',
          displayName: 'Вы',
          persona: null,
        },
        {
          memberId: partnerMemberId,
          relation: 'partner',
          displayName: 'Партнёр',
          persona: null,
        },
      ],
    })
  })

  it('keeps bound persona labels stable when the viewer changes', async () => {
    const first = await query({
      readByUser: () =>
        Promise.resolve(
          snapshot({
            denisMemberId: currentMemberId,
            tanyaMemberId: partnerMemberId,
          }),
        ),
    }).execute({ trustedUserId: '11111111-1111-4111-8111-111111111111' })
    const second = await query({
      readByUser: () =>
        Promise.resolve(
          snapshot({
            currentMemberId: partnerMemberId,
            members: [
              { memberId: partnerMemberId },
              { memberId: currentMemberId },
            ],
            denisMemberId: currentMemberId,
            tanyaMemberId: partnerMemberId,
          }),
        ),
    }).execute({ trustedUserId: '22222222-2222-4222-8222-222222222222' })

    expect(first.personaMappingState).toBe('bound')
    expect(first.members).toEqual([
      expect.objectContaining({
        memberId: currentMemberId,
        persona: 'memberA',
        displayName: 'Участник А',
      }),
      expect.objectContaining({
        memberId: partnerMemberId,
        persona: 'memberB',
        displayName: 'Участник Б',
      }),
    ])
    expect(second.members).toEqual([
      expect.objectContaining({
        memberId: partnerMemberId,
        relation: 'current',
        persona: 'memberB',
        displayName: 'Участник Б',
      }),
      expect.objectContaining({
        memberId: currentMemberId,
        relation: 'partner',
        persona: 'memberA',
        displayName: 'Участник А',
      }),
    ])
  })

  it.each([
    ['missing member', new WorkspaceMemberNotFoundError()],
    ['dependency failure', new WorkspaceDependencyUnavailableError()],
  ])('maps %s to a safe endpoint error', async (_label, error) => {
    const read: CurrentWorkspaceReadPort = {
      readByUser: () => Promise.reject(error),
    }

    const result = query(read).execute({
      trustedUserId: '11111111-1111-4111-8111-111111111111',
    })
    await expect(result).rejects.toBeInstanceOf(
      error instanceof WorkspaceMemberNotFoundError
        ? CurrentWorkspaceAuthorizationDeniedError
        : CurrentWorkspaceDependencyUnavailableError,
    )
  })

  it('rejects an incomplete pair or a partial persona mapping', async () => {
    await expect(
      query({
        readByUser: () =>
          Promise.resolve(
            snapshot({ members: [{ memberId: currentMemberId }] }),
          ),
      }).execute({ trustedUserId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toBeInstanceOf(CurrentWorkspaceStateConflictError)

    await expect(
      query({
        readByUser: () =>
          Promise.resolve(snapshot({ denisMemberId: currentMemberId })),
      }).execute({ trustedUserId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toBeInstanceOf(CurrentWorkspaceStateConflictError)
  })
})
