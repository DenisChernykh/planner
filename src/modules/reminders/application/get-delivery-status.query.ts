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
  ReminderDeliveryStatusReadModel,
  ReminderSettingsReadPort,
} from './reminder.types'
import { REMINDER_DELIVERY_STATUS_SCHEMA_VERSION } from './reminder.types'

export type GetDeliveryStatusInput = {
  readonly trustedActor: ActorRef
}

export class GetDeliveryStatusQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly reads: ReminderSettingsReadPort,
  ) {}

  public async execute(input: GetDeliveryStatusInput): Promise<
    ReminderDeliveryStatusReadModel & {
      readonly schemaVersion: typeof REMINDER_DELIVERY_STATUS_SCHEMA_VERSION
    }
  > {
    try {
      if (input.trustedActor.kind !== 'member') {
        throw new ReminderAuthorizationDeniedError()
      }
      let member
      try {
        member = await this.workspaceMembers.resolveMember(
          input.trustedActor.id,
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
      const value = await this.reads.getDeliveryStatus({
        spaceId: member.spaceId,
        memberId: member.memberId,
      })
      return Object.freeze({
        schemaVersion: REMINDER_DELIVERY_STATUS_SCHEMA_VERSION,
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
