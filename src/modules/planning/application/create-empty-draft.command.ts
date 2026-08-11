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
  canonicalCreatePayload,
  snapshotCreateEmptyDraftCommand,
} from './planning-command.validation'
import {
  PlanMonthAlreadyExistsError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type {
  CreateEmptyDraftApplicationCommand,
  CreateEmptyDraftPayload,
} from './planning.types'

const definition: CommandDefinition<
  CreateEmptyDraftPayload,
  'planning.plan-draft.v1'
> = {
  commandType: 'planning.create-empty-draft.v1',
  resultKind: 'planning.plan-draft.v1',
  toCanonicalPayload: canonicalCreatePayload,
}

function ref(
  planMonthId: string,
  draftRevision: bigint,
): DurableCommandResultRef<'planning.plan-draft.v1'> {
  return {
    kind: 'planning.plan-draft.v1',
    aggregateId: planMonthId,
    aggregateRevision: draftRevision,
  }
}

function isPublicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanMonthAlreadyExistsError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class CreateEmptyDraftCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: PlanDraftPersistencePort,
  ) {}

  public async execute(
    command: CreateEmptyDraftApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-draft.v1'>> {
    try {
      const snapshot = snapshotCreateEmptyDraftCommand(command)
      return await this.executor.execute(
        definition,
        snapshot,
        async (context) => {
          if (
            Object.prototype.hasOwnProperty.call(snapshot, 'expectedRevision')
          ) {
            throw new CommandValidationError()
          }
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const result = await this.drafts.createEmptyDraft({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: definition.commandType,
            commandId: snapshot.commandId,
            occurredAt: context.occurredAt,
            spaceId: member.spaceId,
            memberId: member.memberId,
            targetMonth: snapshot.payload.targetMonth,
            focus: snapshot.payload.focus,
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
