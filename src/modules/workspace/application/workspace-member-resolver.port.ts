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
  resolveMember(memberId: MemberId): Promise<MemberContext>
}

export interface WorkspaceTelegramRecipientResolver {
  resolveTelegramRecipient(memberId: MemberId): Promise<bigint>
}

export const WORKSPACE_MEMBER_RESOLVER: unique symbol = Symbol(
  'WORKSPACE_MEMBER_RESOLVER',
)

export const WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER: unique symbol = Symbol(
  'WORKSPACE_TELEGRAM_RECIPIENT_RESOLVER',
)
