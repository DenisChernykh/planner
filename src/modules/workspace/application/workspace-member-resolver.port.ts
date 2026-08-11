export type SpaceId = string
export type MemberId = string
export type UserId = string

export interface MemberContext {
  readonly spaceId: SpaceId
  readonly memberId: MemberId
  readonly userId: UserId
}

export interface WorkspaceMemberResolver {
  resolveUser(userId: UserId): Promise<MemberContext>
  resolveTelegramId(telegramId: bigint): Promise<MemberContext>
}

export const WORKSPACE_MEMBER_RESOLVER: unique symbol = Symbol(
  'WORKSPACE_MEMBER_RESOLVER',
)
