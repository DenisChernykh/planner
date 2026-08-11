import type { MemberId, SpaceId } from '../domain/workspace-ids'

export interface PairProvisioningMemberInput {
  readonly userId: string
  readonly telegramId: bigint
}

export interface PairProvisioningInput {
  readonly members: readonly [
    PairProvisioningMemberInput,
    PairProvisioningMemberInput,
  ]
}

export interface ProvisionedMember {
  readonly memberId: MemberId
  readonly userId: string
}

export interface PairProvisioningResult {
  readonly status: 'created' | 'existing'
  readonly spaceId: SpaceId
  readonly members: readonly ProvisionedMember[]
}

export interface PairWorkspaceSnapshot {
  readonly spaces: readonly { readonly spaceId: SpaceId }[]
  readonly members: readonly ProvisionedMember[]
  readonly allowlist: readonly PairProvisioningMemberInput[]
}

export interface PairWorkspacePort {
  acquireProvisioningLock(): Promise<void>
  findSnapshot(): Promise<PairWorkspaceSnapshot>
  create(
    members: readonly PairProvisioningMemberInput[],
  ): Promise<Omit<PairProvisioningResult, 'status'>>
}

export const PAIR_WORKSPACE_PORT: unique symbol = Symbol('PAIR_WORKSPACE_PORT')
