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

import type { DraftGoalPersistencePort } from './draft-goal-persistence.port'
import type { PlanningCommandIdentity } from './plan-draft-persistence.port'
import type {
  AddDraftGoalApplicationCommand,
  AddDraftGoalPayload,
  RemoveDraftGoalApplicationCommand,
  RemoveDraftGoalPayload,
  ReorderDraftGoalsApplicationCommand,
  ReorderDraftGoalsPayload,
  UpdateDraftGoalApplicationCommand,
  UpdateDraftGoalPayload,
} from './draft-goal.types'
import {
  canonicalAddDraftGoalPayload,
  canonicalRemoveDraftGoalPayload,
  canonicalReorderDraftGoalsPayload,
  canonicalUpdateDraftGoalPayload,
  snapshotAddDraftGoalCommand,
  snapshotRemoveDraftGoalCommand,
  snapshotReorderDraftGoalsCommand,
  snapshotUpdateDraftGoalCommand,
} from './draft-goal.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  DraftGoalNotFoundError,
  DraftRevisionConflictError,
  GoalDefinitionVersionNotFoundError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

const resultKind = 'planning.plan-draft.v1' as const
export const ADD_DRAFT_GOAL: CommandDefinition<
  AddDraftGoalPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.add-draft-goal.v1',
  resultKind,
  toCanonicalPayload: canonicalAddDraftGoalPayload,
})
export const UPDATE_DRAFT_GOAL: CommandDefinition<
  UpdateDraftGoalPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.update-draft-goal.v1',
  resultKind,
  toCanonicalPayload: canonicalUpdateDraftGoalPayload,
})
export const REMOVE_DRAFT_GOAL: CommandDefinition<
  RemoveDraftGoalPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.remove-draft-goal.v1',
  resultKind,
  toCanonicalPayload: canonicalRemoveDraftGoalPayload,
})
export const REORDER_DRAFT_GOALS: CommandDefinition<
  ReorderDraftGoalsPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.reorder-draft-goals.v1',
  resultKind,
  toCanonicalPayload: canonicalReorderDraftGoalsPayload,
})

function publicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanDraftNotFoundError ||
    error instanceof PlanDraftNotEditableError ||
    error instanceof DraftRevisionConflictError ||
    error instanceof DraftGoalNotFoundError ||
    error instanceof GoalDefinitionVersionNotFoundError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

abstract class DraftGoalCommandBase<TCommand> {
  public constructor(
    protected readonly executor: CommandExecutor,
    protected readonly workspaceMembers: WorkspaceMemberResolver,
    protected readonly drafts: DraftGoalPersistencePort,
  ) {}

  protected async run<TPayload>(
    definition: CommandDefinition<TPayload, typeof resultKind>,
    command: TCommand,
    effect: (
      input: TCommand,
      member: { readonly spaceId: string; readonly memberId: string },
      occurredAt: Date,
    ) => Promise<{
      readonly planMonthId: string
      readonly draftRevision: bigint
    }>,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    try {
      return await this.executor.execute(
        definition,
        command as never,
        async ({ occurredAt }) => {
          const trustedActor = (command as { readonly trustedActor: never })
            .trustedActor
          const member = await resolvePlanningMember(
            trustedActor,
            this.workspaceMembers,
          )
          const value = await effect(command, member, occurredAt)
          return {
            kind: resultKind,
            aggregateId: value.planMonthId,
            aggregateRevision: value.draftRevision,
          }
        },
      )
    } catch (error: unknown) {
      if (publicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }

  protected identity(
    command: {
      readonly commandId: string
      readonly trustedActor: Parameters<typeof actorScope>[0]
      readonly expectedRevision?: bigint
      readonly payload: { readonly planMonthId: string }
    },
    member: { readonly spaceId: string; readonly memberId: string },
    occurredAt: Date,
    commandType: string,
  ): PlanningCommandIdentity & {
    readonly spaceId: string
    readonly memberId: string
    readonly planMonthId: string
    readonly expectedRevision: bigint
  } {
    return {
      actor: command.trustedActor,
      actorScope: actorScope(command.trustedActor),
      commandType,
      commandId: command.commandId,
      occurredAt,
      ...member,
      planMonthId: command.payload.planMonthId,
      expectedRevision: command.expectedRevision!,
    }
  }
}

export class AddDraftGoalCommand extends DraftGoalCommandBase<AddDraftGoalApplicationCommand> {
  public execute(
    command: AddDraftGoalApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotAddDraftGoalCommand(command)
    return this.run(ADD_DRAFT_GOAL, snapshot, (value, member, occurredAt) =>
      this.drafts.add({
        ...this.identity(value, member, occurredAt, ADD_DRAFT_GOAL.commandType),
        goalDefinitionId: value.payload.goalDefinitionId,
        config: value.payload.config,
        sourceProvenance: value.payload.sourceProvenance,
      }),
    )
  }
}

export class UpdateDraftGoalCommand extends DraftGoalCommandBase<UpdateDraftGoalApplicationCommand> {
  public execute(
    command: UpdateDraftGoalApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotUpdateDraftGoalCommand(command)
    return this.run(UPDATE_DRAFT_GOAL, snapshot, (value, member, occurredAt) =>
      this.drafts.update({
        ...this.identity(
          value,
          member,
          occurredAt,
          UPDATE_DRAFT_GOAL.commandType,
        ),
        planGoalId: value.payload.planGoalId,
        goalDefinitionVersionId: value.payload.goalDefinitionVersionId,
        config: value.payload.config,
        sourceProvenance: value.payload.sourceProvenance,
      }),
    )
  }
}

export class RemoveDraftGoalCommand extends DraftGoalCommandBase<RemoveDraftGoalApplicationCommand> {
  public execute(
    command: RemoveDraftGoalApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotRemoveDraftGoalCommand(command)
    return this.run(REMOVE_DRAFT_GOAL, snapshot, (value, member, occurredAt) =>
      this.drafts.remove({
        ...this.identity(
          value,
          member,
          occurredAt,
          REMOVE_DRAFT_GOAL.commandType,
        ),
        planGoalId: value.payload.planGoalId,
      }),
    )
  }
}

export class ReorderDraftGoalsCommand extends DraftGoalCommandBase<ReorderDraftGoalsApplicationCommand> {
  public execute(
    command: ReorderDraftGoalsApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotReorderDraftGoalsCommand(command)
    return this.run(
      REORDER_DRAFT_GOALS,
      snapshot,
      (value, member, occurredAt) =>
        this.drafts.reorder({
          ...this.identity(
            value,
            member,
            occurredAt,
            REORDER_DRAFT_GOALS.commandType,
          ),
          orderedPlanGoalIds: value.payload.orderedPlanGoalIds,
        }),
    )
  }
}
