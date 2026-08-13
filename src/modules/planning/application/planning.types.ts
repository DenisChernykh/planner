import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

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

export type CreateEmptyDraftApplicationCommand =
  ApplicationCommand<CreateEmptyDraftPayload>

export type UpdateMonthFocusApplicationCommand =
  ApplicationCommand<UpdateMonthFocusPayload>

export type CreateDraftFromPublicationApplicationCommand =
  ApplicationCommand<CreateDraftFromPublicationPayload>

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
