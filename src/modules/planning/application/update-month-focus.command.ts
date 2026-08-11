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
  canonicalUpdatePayload,
  snapshotUpdateMonthFocusCommand,
} from './planning-command.validation'
import {
  DraftRevisionConflictError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type {
  UpdateMonthFocusApplicationCommand,
  UpdateMonthFocusPayload,
} from './planning.types'

const definition: CommandDefinition<
  UpdateMonthFocusPayload,
  'planning.plan-draft.v1'
> = {
  commandType: 'planning.update-month-focus.v1',
  resultKind: 'planning.plan-draft.v1',
  toCanonicalPayload: canonicalUpdatePayload,
}

function isPublicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanDraftNotFoundError ||
    error instanceof PlanDraftNotEditableError ||
    error instanceof DraftRevisionConflictError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class UpdateMonthFocusCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: PlanDraftPersistencePort,
  ) {}

  public async execute(
    command: UpdateMonthFocusApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-draft.v1'>> {
    try {
      const snapshot = snapshotUpdateMonthFocusCommand(command)
      return await this.executor.execute(
        definition,
        snapshot,
        async (context) => {
          if (
            snapshot.expectedRevision === undefined ||
            snapshot.expectedRevision <= 0n
          ) {
            throw new CommandValidationError()
          }
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const updated = await this.drafts.updateFocus({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: definition.commandType,
            commandId: snapshot.commandId,
            occurredAt: context.occurredAt,
            spaceId: member.spaceId,
            memberId: member.memberId,
            planMonthId: snapshot.payload.planMonthId,
            focus: snapshot.payload.focus,
            expectedRevision: snapshot.expectedRevision,
          })
          return {
            kind: 'planning.plan-draft.v1',
            aggregateId: updated.planMonthId,
            aggregateRevision: updated.draftRevision,
          }
        },
      )
    } catch (error: unknown) {
      if (isPublicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
