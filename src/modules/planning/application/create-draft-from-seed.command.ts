import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import { actorScope } from '@/shared/application/durable-command.executor'

import { resolveAprilPlanSeed } from '../seed/april-plan.seed'
import type { PlanDraftPersistencePort } from './plan-draft-persistence.port'
import { resolvePlanningMember } from './planning-authorization'
import {
  canonicalCreateDraftFromSeedPayload,
  snapshotCreateDraftFromSeedCommand,
} from './planning-command.validation'
import {
  PlanMonthAlreadyExistsError,
  PlanSeedAlreadyConsumedError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type {
  CreateDraftFromSeedApplicationCommand,
  CreateDraftFromSeedPayload,
} from './planning.types'
import type { SeedOwnerBindingPort } from './seed-owner-binding.port'

const definition: CommandDefinition<
  CreateDraftFromSeedPayload,
  'planning.plan-draft.v1'
> = {
  commandType: 'planning.create-draft-from-seed.v1',
  resultKind: 'planning.plan-draft.v1',
  toCanonicalPayload: canonicalCreateDraftFromSeedPayload,
}

function ref(
  planMonthId: string,
  draftRevision: bigint,
): DurableCommandResultRef<'planning.plan-draft.v1'> {
  return Object.freeze({
    kind: 'planning.plan-draft.v1',
    aggregateId: planMonthId,
    aggregateRevision: draftRevision,
  })
}

function isPublicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanMonthAlreadyExistsError ||
    error instanceof PlanSeedAlreadyConsumedError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class CreateDraftFromSeedCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly ownerBindings: SeedOwnerBindingPort,
    private readonly drafts: PlanDraftPersistencePort,
  ) {}

  public async execute(
    command: CreateDraftFromSeedApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-draft.v1'>> {
    try {
      const snapshot = snapshotCreateDraftFromSeedCommand(command)
      return await this.executor.execute(
        definition,
        snapshot,
        async (context) => {
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const bindings = await this.ownerBindings.resolvePair({
            spaceId: member.spaceId,
            actorMemberId: member.memberId,
            actorPersona: snapshot.payload.actorPersona,
          })
          const seed = resolveAprilPlanSeed(bindings)
          const result = await this.drafts.createFromSeed({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: definition.commandType,
            commandId: snapshot.commandId,
            occurredAt: context.occurredAt,
            spaceId: member.spaceId,
            memberId: member.memberId,
            targetMonth: snapshot.payload.targetMonth,
            actorPersona: snapshot.payload.actorPersona,
            ...bindings,
            seed,
          })
          const resultRef = ref(
            result.draft.planMonthId,
            result.draft.draftRevision,
          )
          if (result.status === 'exists') {
            throw new PlanMonthAlreadyExistsError(resultRef)
          }
          return resultRef
        },
      )
    } catch (error: unknown) {
      if (isPublicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
