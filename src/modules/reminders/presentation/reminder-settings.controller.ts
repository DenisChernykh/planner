import { Body, Controller, Get, Inject, Post } from '@nestjs/common'
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'

import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  CurrentPrincipal,
  type AuthenticatedPrincipal,
} from '@/modules/auth'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import { COMMAND_FINGERPRINT_CONFLICT_PROBLEM } from '@/platform/http/errors/problem-registry'
import type { ActorRef } from '@/shared/application/application-command'

import {
  REMINDERS_APPLICATION,
  type RemindersApplication,
} from '../application/reminders-application'
import {
  ReminderAuthorizationDeniedError,
  ReminderDependencyUnavailableError,
} from '../application/reminder-errors'
import {
  SaveReminderSettingsRequestDto,
  reminderSlots,
  toReminderDeliveryStatusResponse,
  toReminderScheduleMutationResponse,
  toReminderSettingsResponse,
  type ReminderDeliveryStatusResponseV1,
  type ReminderScheduleMutationResponseV1,
  type ReminderSettingsResponseV1,
} from './reminder-settings.dto'
import {
  REMINDER_AUTHORIZATION_DENIED_PROBLEM,
  REMINDER_SCHEDULE_REVISION_CONFLICT_PROBLEM,
} from './reminder-problem.definitions'

const uuid = {
  type: 'string' as const,
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const positive = { type: 'string' as const, pattern: '^[1-9][0-9]*$' }
const time = {
  type: 'string' as const,
  pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
}
const ref = (name: string): Record<string, unknown> => ({
  $ref: `#/components/schemas/${name}`,
})
const settingsBody = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuid,
    expectedRevision: positive,
    timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
    morning: { ...time, nullable: true },
    day: { ...time, nullable: true },
    evening: { ...time, nullable: true },
  },
  required: ['commandId', 'timeZone', 'morning', 'day', 'evening'],
}

const readProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  REMINDER_AUTHORIZATION_DENIED_PROBLEM,
  'DEPENDENCY_UNAVAILABLE' as const,
]

const mutationProblems = [
  ...readProblems,
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  REMINDER_SCHEDULE_REVISION_CONFLICT_PROBLEM,
  'VALIDATION_FAILED' as const,
]

@ApiTags('reminders')
@ApiSecurity('sessionCookie')
@Controller('reminders')
export class ReminderSettingsController {
  public constructor(
    @Inject(REMINDERS_APPLICATION)
    private readonly reminders: RemindersApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Read the current member reminder settings.' })
  @ApiOkResponse({ schema: ref('ReminderSettingsResponseV1') })
  @ApiProblemResponses(...readProblems)
  public async settings(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<ReminderSettingsResponseV1> {
    return toReminderSettingsResponse(
      await this.reminders.getReminderSettings.execute({
        trustedActor: await this.actor(principal),
      }),
    )
  }

  @Post('settings')
  @ApiOperation({
    summary: 'Create or update the current member reminder settings.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: settingsBody })
  @ApiCreatedResponse({ schema: ref('ReminderScheduleMutationResponseV1') })
  @ApiProblemResponses(...mutationProblems)
  public async saveSettings(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: SaveReminderSettingsRequestDto,
  ): Promise<ReminderScheduleMutationResponseV1> {
    return toReminderScheduleMutationResponse(
      await this.reminders.saveReminderSchedule.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        ...(body.expectedRevision === undefined
          ? {}
          : { expectedRevision: BigInt(body.expectedRevision) }),
        payload: {
          timeZone: body.timeZone,
          ...reminderSlots(body),
        },
      }),
    )
  }

  @Get('delivery-status')
  @ApiOperation({
    summary: 'Read the current member Telegram delivery status.',
  })
  @ApiOkResponse({ schema: ref('ReminderDeliveryStatusResponseV1') })
  @ApiProblemResponses(...readProblems)
  public async deliveryStatus(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<ReminderDeliveryStatusResponseV1> {
    return toReminderDeliveryStatusResponse(
      await this.reminders.getDeliveryStatus.execute({
        trustedActor: await this.actor(principal),
      }),
    )
  }

  private async actor(principal: AuthenticatedPrincipal): Promise<ActorRef> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member', id: member.memberId }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new ReminderAuthorizationDeniedError()
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new ReminderDependencyUnavailableError({ cause: error })
      }
      throw new ReminderDependencyUnavailableError({ cause: error })
    }
  }
}
