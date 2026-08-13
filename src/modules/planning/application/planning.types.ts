import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

import type { SeedPersona } from './seed-owner-binding.port'

export type CreateEmptyDraftPayload = {
  readonly targetMonth: string
  readonly focus: string
}

export type UpdateMonthFocusPayload = {
  readonly planMonthId: string
  readonly focus: string
}

export type CreateDraftFromPublicationPayload = {
  readonly sourcePublicationId: string
  readonly targetMonth: string
}

export type CreateDraftFromSeedPayload = {
  readonly targetMonth: string
  readonly actorPersona: SeedPersona
}

export type CreateEmptyDraftApplicationCommand =
  ApplicationCommand<CreateEmptyDraftPayload>

export type UpdateMonthFocusApplicationCommand =
  ApplicationCommand<UpdateMonthFocusPayload>

export type CreateDraftFromPublicationApplicationCommand =
  ApplicationCommand<CreateDraftFromPublicationPayload>

export type CreateDraftFromSeedApplicationCommand =
  ApplicationCommand<CreateDraftFromSeedPayload>

export type GetDraftInput = {
  readonly trustedActor: ActorRef
  readonly targetMonth: string
}

export type DraftView = {
  readonly planMonthId: string
  readonly spaceId: string
  readonly targetMonth: string
  readonly status: 'draft'
  readonly focus: string
  readonly planMonthRevision: bigint
  readonly draftRevision: bigint
}
