import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
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

import type { FactPersistencePort } from './fact-persistence.port'
import {
  FactRevisionConflictError,
  FactTargetNotFoundError,
  FactTargetUnavailableError,
  FactUndoUnavailableError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import {
  canonicalUndoLastOwnActionPayload,
  localDateAt,
  snapshotUndoLastOwnActionCommand,
} from './tracking-command.validation'
import type {
  UndoLastOwnActionApplicationCommand,
  UndoLastOwnActionPayload,
} from './tracking.types'

const definition: CommandDefinition<
  UndoLastOwnActionPayload,
  'tracking.fact-record.v1'
> = {
  commandType: 'tracking.undo-last-own-action.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalUndoLastOwnActionPayload,
}

function isPublic(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof FactTargetNotFoundError ||
    error instanceof FactTargetUnavailableError ||
    error instanceof FactRevisionConflictError ||
    error instanceof FactUndoUnavailableError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export class UndoLastOwnActionCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: UndoLastOwnActionApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotUndoLastOwnActionCommand(command)
    return this.executeSnapshot(snapshot)
  }

  private async executeSnapshot(
    command: UndoLastOwnActionApplicationCommand & {
      readonly expectedRevision: bigint
    },
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    try {
      return await this.executor.execute(
        definition,
        command,
        async (context) => {
          if (command.trustedActor.kind !== 'member') {
            throw new TrackingAuthorizationDeniedError()
          }
          let member
          try {
            member = await this.workspaceMembers.resolveMember(
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
          const result = await this.facts.undoLastOwnAction({
            actor: command.trustedActor,
            actorScope: actorScope(command.trustedActor),
            commandId: command.commandId,
            occurredAt: context.occurredAt,
            currentLocalDate: localDateAt(context.occurredAt),
            spaceId: member.spaceId,
            memberId: member.memberId,
            expectedRevision: command.expectedRevision,
            factRecordId: command.payload.factRecordId,
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
}
