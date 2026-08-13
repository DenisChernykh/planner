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
  FactValueInvalidError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import {
  canonicalRecordFactPayload,
  localDateAt,
  snapshotRecordFactCommand,
} from './tracking-command.validation'
import type {
  RecordFactApplicationCommand,
  RecordFactPayload,
} from './tracking.types'

const commandType = 'tracking.record-fact.v1' as const

const definition: CommandDefinition<
  RecordFactPayload,
  'tracking.fact-record.v1'
> = {
  commandType,
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordFactPayload,
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

export class RecordFactCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public async execute(
    command: RecordFactApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    try {
      const snapshot = snapshotRecordFactCommand(command)
      return await this.executor.execute(
        definition,
        snapshot,
        async (context) => {
          if (snapshot.trustedActor.kind !== 'member') {
            throw new TrackingAuthorizationDeniedError()
          }
          let member
          try {
            member = await this.workspaceMembers.resolveMember(
              snapshot.trustedActor.id,
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
          let currentLocalDate: string
          try {
            currentLocalDate = localDateAt(context.occurredAt)
          } catch (error: unknown) {
            throw new TrackingDependencyUnavailableError({ cause: error })
          }
          const result = await this.facts.record({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType,
            commandId: snapshot.commandId,
            occurredAt: context.occurredAt,
            currentLocalDate,
            spaceId: member.spaceId,
            memberId: member.memberId,
            expectedRevision: snapshot.expectedRevision ?? null,
            ...snapshot.payload,
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
