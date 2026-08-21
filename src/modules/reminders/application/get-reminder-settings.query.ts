import type { ActorRef } from '@/shared/application/application-command'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'

import {
  ReminderAuthorizationDeniedError,
  ReminderDependencyUnavailableError,
} from './reminder-errors'
import type {
  ReminderSettingsReadModel,
  ReminderSettingsReadPort,
} from './reminder.types'
import { REMINDER_SETTINGS_SCHEMA_VERSION } from './reminder.types'

export type GetReminderSettingsInput = {
  readonly trustedActor: ActorRef
}

async function memberContext(
  workspaceMembers: WorkspaceMemberResolver,
  actor: ActorRef,
): Promise<{ readonly spaceId: string; readonly memberId: string }> {
  if (actor.kind !== 'member') throw new ReminderAuthorizationDeniedError()
  try {
    const member = await workspaceMembers.resolveMember(actor.id)
    return { spaceId: member.spaceId, memberId: member.memberId }
  } catch (error: unknown) {
    if (error instanceof WorkspaceMemberNotFoundError) {
      throw new ReminderAuthorizationDeniedError()
    }
    if (error instanceof WorkspaceDependencyUnavailableError) {
      throw new ReminderDependencyUnavailableError({ cause: error })
    }
    throw error
  }
}

export class GetReminderSettingsQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly reads: ReminderSettingsReadPort,
  ) {}

  public async execute(input: GetReminderSettingsInput): Promise<
    ReminderSettingsReadModel & {
      readonly schemaVersion: typeof REMINDER_SETTINGS_SCHEMA_VERSION
    }
  > {
    try {
      const member = await memberContext(
        this.workspaceMembers,
        input.trustedActor,
      )
      const value = await this.reads.getSettings(member)
      return Object.freeze({
        schemaVersion: REMINDER_SETTINGS_SCHEMA_VERSION,
        ...value,
      })
    } catch (error: unknown) {
      if (
        error instanceof ReminderAuthorizationDeniedError ||
        error instanceof ReminderDependencyUnavailableError
      ) {
        throw error
      }
      throw new ReminderDependencyUnavailableError({ cause: error })
    }
  }
}
