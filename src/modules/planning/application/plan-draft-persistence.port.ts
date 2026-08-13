import type { ActorRef } from '@/shared/application/application-command'

import type { DraftView } from './planning.types'
import type { SeedPersona } from './seed-owner-binding.port'
import type { ResolvedAprilPlanSeedV1 } from '../seed/april-plan.seed'

export type PlanningCommandIdentity = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandType: string
  readonly commandId: string
  readonly occurredAt: Date
}

export type CreateDraftPersistenceInput = PlanningCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
  readonly targetMonth: string
  readonly focus: string
}

export type UpdateFocusPersistenceInput = PlanningCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
  readonly planMonthId: string
  readonly focus: string
  readonly expectedRevision: bigint
}

export type CreateDraftFromPublicationPersistenceInput =
  PlanningCommandIdentity & {
    readonly spaceId: string
    readonly memberId: string
    readonly sourcePublicationId: string
    readonly targetMonth: string
  }

export type CreateDraftFromSeedPersistenceInput = PlanningCommandIdentity & {
  readonly spaceId: string
  readonly memberId: string
  readonly targetMonth: string
  readonly actorPersona: SeedPersona
  readonly denisMemberId: string
  readonly tanyaMemberId: string
  readonly seed: ResolvedAprilPlanSeedV1
}

export type PlanningDraftRef = {
  readonly planMonthId: string
  readonly draftRevision: bigint
}

export type CreateDraftPersistenceResult =
  | { readonly status: 'created'; readonly draft: PlanningDraftRef }
  | { readonly status: 'exists'; readonly draft: PlanningDraftRef }

export interface PlanDraftPersistencePort {
  createEmptyDraft(
    input: CreateDraftPersistenceInput,
  ): Promise<CreateDraftPersistenceResult>
  createFromPublication(
    input: CreateDraftFromPublicationPersistenceInput,
  ): Promise<CreateDraftPersistenceResult>
  createFromSeed(
    input: CreateDraftFromSeedPersistenceInput,
  ): Promise<CreateDraftPersistenceResult>
  updateFocus(input: UpdateFocusPersistenceInput): Promise<PlanningDraftRef>
  findDraft(spaceId: string, targetMonth: string): Promise<DraftView | null>
}
