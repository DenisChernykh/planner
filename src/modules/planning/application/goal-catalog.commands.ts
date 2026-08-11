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

import type { GoalCatalogPersistencePort } from './goal-catalog-persistence.port'
import type {
  ArchiveGoalDefinitionApplicationCommand,
  CopyGoalDefinitionApplicationCommand,
  CreateGoalDefinitionApplicationCommand,
  CreateGoalDefinitionPayload,
  CreateGoalDefinitionVersionApplicationCommand,
  CreateGoalDefinitionVersionPayload,
  GoalDefinitionIdentityPayload,
  RestoreGoalDefinitionApplicationCommand,
} from './goal-catalog.types'
import {
  canonicalArchiveGoalDefinitionPayload,
  canonicalCopyGoalDefinitionPayload,
  canonicalCreateGoalDefinitionPayload,
  canonicalCreateGoalDefinitionVersionPayload,
  canonicalRestoreGoalDefinitionPayload,
  snapshotArchiveGoalDefinitionCommand,
  snapshotCopyGoalDefinitionCommand,
  snapshotCreateGoalDefinitionCommand,
  snapshotCreateGoalDefinitionVersionCommand,
  snapshotRestoreGoalDefinitionCommand,
} from './goal-catalog.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  GoalDefinitionNotFoundError,
  GoalDefinitionRevisionConflictError,
  GoalDefinitionStateConflictError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

const resultKind = 'planning.goal-definition.v1' as const

export const CREATE_GOAL_DEFINITION: CommandDefinition<
  CreateGoalDefinitionPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.create-goal-definition.v1',
  resultKind,
  toCanonicalPayload: canonicalCreateGoalDefinitionPayload,
})
export const CREATE_GOAL_DEFINITION_VERSION: CommandDefinition<
  CreateGoalDefinitionVersionPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.create-goal-definition-version.v1',
  resultKind,
  toCanonicalPayload: canonicalCreateGoalDefinitionVersionPayload,
})
export const ARCHIVE_GOAL_DEFINITION: CommandDefinition<
  GoalDefinitionIdentityPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.archive-goal-definition.v1',
  resultKind,
  toCanonicalPayload: canonicalArchiveGoalDefinitionPayload,
})
export const RESTORE_GOAL_DEFINITION: CommandDefinition<
  GoalDefinitionIdentityPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.restore-goal-definition.v1',
  resultKind,
  toCanonicalPayload: canonicalRestoreGoalDefinitionPayload,
})
export const COPY_GOAL_DEFINITION: CommandDefinition<
  { readonly sourceGoalDefinitionId: string },
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.copy-goal-definition.v1',
  resultKind,
  toCanonicalPayload: canonicalCopyGoalDefinitionPayload,
})

function ref(value: {
  readonly goalDefinitionId: string
  readonly revision: bigint
}): DurableCommandResultRef<typeof resultKind> {
  return {
    kind: resultKind,
    aggregateId: value.goalDefinitionId,
    aggregateRevision: value.revision,
  }
}

function publicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof GoalDefinitionNotFoundError ||
    error instanceof GoalDefinitionRevisionConflictError ||
    error instanceof GoalDefinitionStateConflictError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

abstract class GoalCatalogCommandBase<TCommand> {
  protected constructor(
    protected readonly executor: CommandExecutor,
    protected readonly workspaceMembers: WorkspaceMemberResolver,
    protected readonly catalog: GoalCatalogPersistencePort,
  ) {}

  protected async run(
    definition: CommandDefinition<never, typeof resultKind>,
    command: TCommand,
    effect: (
      snapshot: TCommand,
      member: { readonly spaceId: string; readonly memberId: string },
      occurredAt: Date,
    ) => Promise<{
      readonly goalDefinitionId: string
      readonly revision: bigint
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
          return ref(await effect(command, member, occurredAt))
        },
      )
    } catch (error: unknown) {
      if (publicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}

export class CreateGoalDefinitionCommand extends GoalCatalogCommandBase<CreateGoalDefinitionApplicationCommand> {
  public constructor(
    executor: CommandExecutor,
    workspaceMembers: WorkspaceMemberResolver,
    catalog: GoalCatalogPersistencePort,
  ) {
    super(executor, workspaceMembers, catalog)
  }

  public execute(
    command: CreateGoalDefinitionApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotCreateGoalDefinitionCommand(command)
    return this.run(
      CREATE_GOAL_DEFINITION,
      snapshot,
      (value, member, occurredAt) =>
        this.catalog.create({
          actor: value.trustedActor,
          actorScope: actorScope(value.trustedActor),
          commandType: CREATE_GOAL_DEFINITION.commandType,
          commandId: value.commandId,
          occurredAt,
          ...member,
          ...value.payload,
        }),
    )
  }
}

export class CreateGoalDefinitionVersionCommand extends GoalCatalogCommandBase<CreateGoalDefinitionVersionApplicationCommand> {
  public constructor(
    executor: CommandExecutor,
    workspaceMembers: WorkspaceMemberResolver,
    catalog: GoalCatalogPersistencePort,
  ) {
    super(executor, workspaceMembers, catalog)
  }

  public execute(
    command: CreateGoalDefinitionVersionApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotCreateGoalDefinitionVersionCommand(command)
    return this.run(
      CREATE_GOAL_DEFINITION_VERSION,
      snapshot,
      (value, member, occurredAt) =>
        this.catalog.createVersion({
          actor: value.trustedActor,
          actorScope: actorScope(value.trustedActor),
          commandType: CREATE_GOAL_DEFINITION_VERSION.commandType,
          commandId: value.commandId,
          occurredAt,
          ...member,
          ...value.payload,
          expectedRevision: value.expectedRevision!,
        }),
    )
  }
}

abstract class StateGoalDefinitionCommand<
  TCommand extends ArchiveGoalDefinitionApplicationCommand,
> extends GoalCatalogCommandBase<TCommand> {
  protected executeState(
    command: TCommand,
    requestedState: 'active' | 'archived',
    definition: typeof ARCHIVE_GOAL_DEFINITION,
    snapshotter: (value: unknown) => TCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotter(command)
    return this.run(definition, snapshot, (value, member, occurredAt) =>
      this.catalog.changeState({
        actor: value.trustedActor,
        actorScope: actorScope(value.trustedActor),
        commandType: definition.commandType,
        commandId: value.commandId,
        occurredAt,
        ...member,
        goalDefinitionId: value.payload.goalDefinitionId,
        expectedRevision: value.expectedRevision!,
        requestedState,
      }),
    )
  }
}

export class ArchiveGoalDefinitionCommand extends StateGoalDefinitionCommand<ArchiveGoalDefinitionApplicationCommand> {
  public constructor(
    executor: CommandExecutor,
    workspaceMembers: WorkspaceMemberResolver,
    catalog: GoalCatalogPersistencePort,
  ) {
    super(executor, workspaceMembers, catalog)
  }
  public execute(
    command: ArchiveGoalDefinitionApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    return this.executeState(
      command,
      'archived',
      ARCHIVE_GOAL_DEFINITION,
      snapshotArchiveGoalDefinitionCommand,
    )
  }
}

export class RestoreGoalDefinitionCommand extends StateGoalDefinitionCommand<RestoreGoalDefinitionApplicationCommand> {
  public constructor(
    executor: CommandExecutor,
    workspaceMembers: WorkspaceMemberResolver,
    catalog: GoalCatalogPersistencePort,
  ) {
    super(executor, workspaceMembers, catalog)
  }
  public execute(
    command: RestoreGoalDefinitionApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    return this.executeState(
      command,
      'active',
      RESTORE_GOAL_DEFINITION,
      snapshotRestoreGoalDefinitionCommand,
    )
  }
}

export class CopyGoalDefinitionCommand extends GoalCatalogCommandBase<CopyGoalDefinitionApplicationCommand> {
  public constructor(
    executor: CommandExecutor,
    workspaceMembers: WorkspaceMemberResolver,
    catalog: GoalCatalogPersistencePort,
  ) {
    super(executor, workspaceMembers, catalog)
  }
  public execute(
    command: CopyGoalDefinitionApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotCopyGoalDefinitionCommand(command)
    return this.run(
      COPY_GOAL_DEFINITION,
      snapshot,
      (value, member, occurredAt) =>
        this.catalog.copy({
          actor: value.trustedActor,
          actorScope: actorScope(value.trustedActor),
          commandType: COPY_GOAL_DEFINITION.commandType,
          commandId: value.commandId,
          occurredAt,
          ...member,
          sourceGoalDefinitionId: value.payload.sourceGoalDefinitionId,
          expectedRevision: value.expectedRevision!,
        }),
    )
  }
}
