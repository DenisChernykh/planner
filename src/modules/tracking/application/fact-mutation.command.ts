import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import { actorScope } from '@/shared/application/durable-command.executor'

import type {
  FactPersistencePort,
  TrackingMutationCommandType,
} from './fact-persistence.port'
import {
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import { localDateAt } from './tracking-command.validation'
import type { RecordSingleFactValueV1 } from './tracking.types'

export type FactMutationDependencies = {
  readonly executor: CommandExecutor
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly facts: FactPersistencePort
}

export type FactMutationTarget = {
  readonly factRecordId: string
  readonly value: RecordSingleFactValueV1 | null
  readonly reason: string
}

function isPublic(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof FactTargetNotFoundError ||
    error instanceof FactTargetUnavailableError ||
    error instanceof FactValueInvalidError ||
    error instanceof FactRevisionConflictError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export async function executeFactMutation<TPayload>(
  dependencies: FactMutationDependencies,
  definition: CommandDefinition<TPayload, 'tracking.fact-record.v1'> & {
    readonly commandType: TrackingMutationCommandType
  },
  command: ApplicationCommand<TPayload> & { readonly expectedRevision: bigint },
  target: FactMutationTarget,
): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
  try {
    return await dependencies.executor.execute(
      definition,
      command,
      async (context) => {
        if (command.trustedActor.kind !== 'member') {
          throw new TrackingAuthorizationDeniedError()
        }
        let member
        try {
          member = await dependencies.workspaceMembers.resolveMember(
            command.trustedActor.id,
          )
        } catch (error: unknown) {
          if (error instanceof WorkspaceMemberNotFoundError) {
            throw new TrackingAuthorizationDeniedError()
          }
          if (error instanceof WorkspaceDependencyUnavailableError) {
            throw new TrackingDependencyUnavailableError({ cause: error })
          }
          throw error
        }
        const result = await dependencies.facts.mutate({
          actor: command.trustedActor,
          actorScope: actorScope(command.trustedActor),
          commandType: definition.commandType,
          commandId: command.commandId,
          occurredAt: context.occurredAt,
          currentLocalDate: localDateAt(context.occurredAt),
          spaceId: member.spaceId,
          memberId: member.memberId,
          expectedRevision: command.expectedRevision,
          ...target,
        })
        return Object.freeze({
          kind: definition.resultKind,
          aggregateId: result.factRecordId,
          aggregateRevision: result.factRevision,
        })
      },
    )
  } catch (error: unknown) {
    if (isPublic(error)) throw error
    throw new TrackingDependencyUnavailableError({ cause: error })
  }
}
