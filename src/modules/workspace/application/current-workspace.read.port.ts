import type { MemberId, SpaceId } from '../domain/workspace-ids'

export interface CurrentWorkspaceMemberRow {
  readonly memberId: MemberId
}

export interface CurrentWorkspaceSnapshot {
  readonly spaceId: SpaceId
  readonly currentMemberId: MemberId
  readonly members: readonly CurrentWorkspaceMemberRow[]
  readonly denisMemberId: MemberId | null
  readonly tanyaMemberId: MemberId | null
}

export interface CurrentWorkspaceReadPort {
  readByUser(userId: string): Promise<CurrentWorkspaceSnapshot>
}

export const CURRENT_WORKSPACE_READ_PORT: unique symbol = Symbol(
  'CURRENT_WORKSPACE_READ_PORT',
)
