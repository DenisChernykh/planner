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
import type {
  MemberContext,
  WorkspaceMemberResolver,
} from '@/modules/workspace/application/workspace-member-resolver.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'

import {
  ReminderDependencyUnavailableError,
  ReminderAuthorizationDeniedError,
  ReminderScheduleRevisionConflictError,
} from './reminder-errors'
import type { ReminderSchedulePersistencePort } from './reminder.types'
import {
  REMINDER_SCHEDULE_RESULT_KIND,
  canonicalReminderSchedulePayload,
  type SaveReminderScheduleApplicationCommand,
  type SaveReminderSchedulePayload,
} from './reminder.types'
import { snapshotSaveReminderScheduleCommand } from './reminder.validation'

const definition: CommandDefinition<
  SaveReminderSchedulePayload,
  typeof REMINDER_SCHEDULE_RESULT_KIND
> = {
  commandType: 'reminders.save-schedule.v1',
  resultKind: REMINDER_SCHEDULE_RESULT_KIND,
  toCanonicalPayload: canonicalReminderSchedulePayload,
}

function isPublicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof ReminderAuthorizationDeniedError ||
    error instanceof ReminderScheduleRevisionConflictError ||
    error instanceof ReminderDependencyUnavailableError
  )
}

export class SaveReminderScheduleCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly schedules: ReminderSchedulePersistencePort,
  ) {}

  public async execute(
    input: SaveReminderScheduleApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof REMINDER_SCHEDULE_RESULT_KIND>> {
    try {
      const command = snapshotSaveReminderScheduleCommand(input)
      return await this.executor.execute(
        definition,
        command,
        async (context) => {
          let member: MemberContext
          try {
            member = await this.workspaceMembers.resolveMember(
              command.trustedActor.id,
            )
          } catch (error: unknown) {
            if (error instanceof WorkspaceMemberNotFoundError) {
              throw new ReminderAuthorizationDeniedError()
            }
            if (error instanceof WorkspaceDependencyUnavailableError) {
              throw new ReminderDependencyUnavailableError({ cause: error })
            }
            throw error
          }
          const saved = await this.schedules.saveSchedule({
            actor: command.trustedActor,
            actorScope: actorScope(command.trustedActor),
            commandType: definition.commandType,
            commandId: command.commandId,
            occurredAt: context.occurredAt,
            spaceId: member.spaceId,
            memberId: member.memberId,
            ...(command.expectedRevision === undefined
              ? {}
              : { expectedRevision: command.expectedRevision }),
            slots: {
              morning: command.payload.morning,
              day: command.payload.day,
              evening: command.payload.evening,
            },
          })
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: saved.scheduleId,
            aggregateRevision: saved.revision,
          })
        },
      )
    } catch (error: unknown) {
      if (isPublicError(error)) throw error
      throw new ReminderDependencyUnavailableError({ cause: error })
    }
  }
}
