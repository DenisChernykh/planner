import type { CurrentWorkspaceReadPort } from './current-workspace.read.port'
import {
  CurrentWorkspaceAuthorizationDeniedError,
  CurrentWorkspaceDependencyUnavailableError,
  CurrentWorkspaceStateConflictError,
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from './workspace-errors'
import type { MemberId } from '../domain/workspace-ids'

export type WorkspacePersona = 'memberA' | 'memberB'
export type WorkspaceMemberRelation = 'current' | 'partner'

export interface CurrentWorkspaceMemberView {
  readonly memberId: MemberId
  readonly relation: WorkspaceMemberRelation
  readonly displayName: 'Вы' | 'Партнёр' | 'Участник А' | 'Участник Б'
  readonly persona: WorkspacePersona | null
}

export interface CurrentWorkspaceView {
  readonly schemaVersion: 'workspace.current.v1'
  readonly spaceId: string
  readonly timeZone: 'Asia/Yekaterinburg'
  readonly currentMemberId: string
  readonly personaMappingState: 'unbound' | 'bound'
  readonly members: readonly CurrentWorkspaceMemberView[]
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function personaDisplayName(
  persona: WorkspacePersona | null,
  relation: WorkspaceMemberRelation,
): CurrentWorkspaceMemberView['displayName'] {
  if (persona === 'memberA') return 'Участник А'
  if (persona === 'memberB') return 'Участник Б'
  return relation === 'current' ? 'Вы' : 'Партнёр'
}

export class GetCurrentWorkspaceQuery {
  public constructor(private readonly workspace: CurrentWorkspaceReadPort) {}

  public async execute(input: {
    readonly trustedUserId: string
  }): Promise<CurrentWorkspaceView> {
    try {
      const snapshot = await this.workspace.readByUser(input.trustedUserId)
      if (snapshot.members.length !== 2) {
        throw new CurrentWorkspaceStateConflictError()
      }

      const memberIds = snapshot.members.map(({ memberId }) => memberId)
      if (
        new Set(memberIds).size !== 2 ||
        !memberIds.includes(snapshot.currentMemberId)
      ) {
        throw new CurrentWorkspaceStateConflictError()
      }

      const mappingValues = [snapshot.denisMemberId, snapshot.tanyaMemberId]
      const allUnbound = mappingValues.every((value) => value === null)
      const allBound = mappingValues.every((value) => value !== null)
      if (!allUnbound && !allBound) {
        throw new CurrentWorkspaceStateConflictError()
      }

      let personas = new Map<string, WorkspacePersona>()
      const personaMappingState = allBound ? 'bound' : 'unbound'
      if (allBound) {
        if (
          snapshot.denisMemberId === snapshot.tanyaMemberId ||
          !memberIds.includes(snapshot.denisMemberId!) ||
          !memberIds.includes(snapshot.tanyaMemberId!)
        ) {
          throw new CurrentWorkspaceStateConflictError()
        }
        personas = new Map([
          [snapshot.denisMemberId!, 'memberA'],
          [snapshot.tanyaMemberId!, 'memberB'],
        ])
      }

      const members = snapshot.members.map(({ memberId }) => {
        const relation: WorkspaceMemberRelation =
          memberId === snapshot.currentMemberId ? 'current' : 'partner'
        const persona = personas.get(memberId) ?? null
        return {
          memberId,
          relation,
          displayName: personaDisplayName(persona, relation),
          persona,
        }
      })

      if (members[0]?.relation !== 'current') {
        throw new CurrentWorkspaceStateConflictError()
      }

      return freeze({
        schemaVersion: 'workspace.current.v1' as const,
        spaceId: snapshot.spaceId,
        timeZone: 'Asia/Yekaterinburg' as const,
        currentMemberId: snapshot.currentMemberId,
        personaMappingState,
        members,
      })
    } catch (error: unknown) {
      if (
        error instanceof CurrentWorkspaceStateConflictError ||
        error instanceof CurrentWorkspaceDependencyUnavailableError ||
        error instanceof CurrentWorkspaceAuthorizationDeniedError
      ) {
        throw error
      }
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new CurrentWorkspaceAuthorizationDeniedError({ cause: error })
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new CurrentWorkspaceDependencyUnavailableError({ cause: error })
      }
      throw new CurrentWorkspaceDependencyUnavailableError({ cause: error })
    }
  }
}
