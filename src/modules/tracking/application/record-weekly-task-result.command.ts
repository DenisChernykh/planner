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

import {
  FactCorrectionRequiredError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
  WeeklyTaskAlreadySystemClosedError,
  WeeklyTaskTargetNotFoundError,
  WeeklyTaskTargetUnavailableError,
} from './tracking-errors'
import {
  canonicalRecordWeeklyTaskResultPayload,
  localDateAt,
  snapshotRecordWeeklyTaskResultCommand,
} from './tracking-command.validation'
import type {
  RecordWeeklyTaskResultApplicationCommand,
  RecordWeeklyTaskResultPayload,
} from './tracking.types'
import type { WeeklyTaskResultPersistencePort } from './weekly-task-result-persistence.port'

const definition: CommandDefinition<
  RecordWeeklyTaskResultPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-weekly-task-result.v1' } = {
  commandType: 'tracking.record-weekly-task-result.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordWeeklyTaskResultPayload,
}

function accepted(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof WeeklyTaskTargetNotFoundError ||
    error instanceof WeeklyTaskTargetUnavailableError ||
    error instanceof FactCorrectionRequiredError ||
    error instanceof WeeklyTaskAlreadySystemClosedError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export class RecordWeeklyTaskResultCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly weeklyTasks: WeeklyTaskResultPersistencePort,
  ) {}

  public async execute(
    input: RecordWeeklyTaskResultApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const command = snapshotRecordWeeklyTaskResultCommand(input)
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
          const result = await this.weeklyTasks.record({
            actor: command.trustedActor,
            actorScope: actorScope(command.trustedActor),
            commandId: command.commandId,
            occurredAt: context.occurredAt,
            currentLocalDate: localDateAt(context.occurredAt),
            spaceId: member.spaceId,
            memberId: member.memberId,
            ...command.payload,
          })
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: result.factRecordId,
            aggregateRevision: result.factRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
