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

import type { PlanDraftPersistencePort } from './plan-draft-persistence.port'
import { resolvePlanningMember } from './planning-authorization'
import {
  canonicalCreateDraftFromPublicationPayload,
  snapshotCreateDraftFromPublicationCommand,
} from './planning-command.validation'
import {
  PlanMonthAlreadyExistsError,
  PlanPublicationNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type {
  CreateDraftFromPublicationApplicationCommand,
  CreateDraftFromPublicationPayload,
} from './planning.types'

const definition: CommandDefinition<
  CreateDraftFromPublicationPayload,
  'planning.plan-draft.v1'
> = {
  commandType: 'planning.create-draft-from-publication.v1',
  resultKind: 'planning.plan-draft.v1',
  toCanonicalPayload: canonicalCreateDraftFromPublicationPayload,
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
    error instanceof PlanPublicationNotFoundError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class CreateDraftFromPublicationCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: PlanDraftPersistencePort,
  ) {}

  public async execute(
    command: CreateDraftFromPublicationApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-draft.v1'>> {
    try {
      const snapshot = snapshotCreateDraftFromPublicationCommand(command)
      return await this.executor.execute(
        definition,
        snapshot,
        async (context) => {
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const result = await this.drafts.createFromPublication({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: definition.commandType,
            commandId: snapshot.commandId,
            occurredAt: context.occurredAt,
            spaceId: member.spaceId,
            memberId: member.memberId,
            sourcePublicationId: snapshot.payload.sourcePublicationId,
            targetMonth: snapshot.payload.targetMonth,
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
