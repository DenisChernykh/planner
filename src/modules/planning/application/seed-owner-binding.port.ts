export type SeedPersona = 'memberA' | 'memberB'

export type SeedOwnerBindingInput = {
  readonly spaceId: string
  readonly actorMemberId: string
  readonly actorPersona: SeedPersona
}

export type SeedOwnerBindings = {
  readonly denisMemberId: string
  readonly tanyaMemberId: string
}

export interface SeedOwnerBindingPort {
  resolvePair(input: SeedOwnerBindingInput): Promise<SeedOwnerBindings>
}
