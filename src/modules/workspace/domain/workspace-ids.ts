export type SpaceId = string & { readonly __spaceId: unique symbol }
export type MemberId = string & { readonly __memberId: unique symbol }

export function existingSpaceId(value: string): SpaceId {
  return value as SpaceId
}

export function existingMemberId(value: string): MemberId {
  return value as MemberId
}
