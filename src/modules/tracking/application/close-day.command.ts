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

import type { CloseDayPersistencePort } from './close-day-persistence.port'
import type {
  CloseDayApplicationCommand,
  CloseDayPayload,
} from './close-day.types'
import {
  CloseDayAlreadyClosedError,
  CloseDayPreviewConflictError,
  CloseDayRevisionConflictError,
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import {
  canonicalCloseDayPayload,
  localDateAt,
  snapshotCloseDayCommand,
} from './tracking-command.validation'

const definition: CommandDefinition<CloseDayPayload, 'tracking.day-close.v1'> =
  {
    commandType: 'tracking.close-day.v1',
    resultKind: 'tracking.day-close.v1',
    toCanonicalPayload: canonicalCloseDayPayload,
  }

function accepted(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof CloseDayTargetNotFoundError ||
    error instanceof CloseDayTargetUnavailableError ||
    error instanceof CloseDayRevisionConflictError ||
    error instanceof CloseDayPreviewConflictError ||
    error instanceof CloseDayAlreadyClosedError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export class CloseDayCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly closeDays: CloseDayPersistencePort,
  ) {}

  public execute(
    input: CloseDayApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.day-close.v1'>> {
    const command = snapshotCloseDayCommand(input)
    return this.executeSnapshot(command)
  }

  private async executeSnapshot(
    command: CloseDayApplicationCommand & { readonly expectedRevision: bigint },
  ): Promise<DurableCommandResultRef<'tracking.day-close.v1'>> {
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
          const result = await this.closeDays.close({
            actor: command.trustedActor,
            actorScope: actorScope(command.trustedActor),
            commandId: command.commandId,
            occurredAt: context.occurredAt,
            currentLocalDate: localDateAt(context.occurredAt),
            spaceId: member.spaceId,
            memberId: member.memberId,
            expectedRevision: command.expectedRevision,
            ...command.payload,
          })
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: result.dayCloseId,
            aggregateRevision: result.factsRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
