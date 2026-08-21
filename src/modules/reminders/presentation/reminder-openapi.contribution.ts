import type { OpenAPIObject } from '@nestjs/swagger'

import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

function installReminderSchemas(document: OpenAPIObject): void {
  const schemas = ((document.components ??= {}).schemas ??=
    {}) as unknown as Record<string, unknown>
  const uuid = {
    type: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  }
  const nullableTime = {
    type: 'string',
    nullable: true,
    pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
  }
  const object = (
    properties: Record<string, unknown>,
    required: readonly string[],
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  })
  schemas['ReminderSettingsResponseV1'] = object(
    {
      schemaVersion: { type: 'string', enum: ['reminders.settings.v1'] },
      scheduleId: { ...uuid, nullable: true },
      revision: { type: 'string', pattern: '^[1-9][0-9]*$', nullable: true },
      timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
      morning: nullableTime,
      day: nullableTime,
      evening: nullableTime,
    },
    [
      'schemaVersion',
      'scheduleId',
      'revision',
      'timeZone',
      'morning',
      'day',
      'evening',
    ],
  )
  schemas['ReminderDeliveryStatusResponseV1'] = object(
    {
      schemaVersion: {
        type: 'string',
        enum: ['reminders.delivery-status.v1'],
      },
      status: {
        type: 'string',
        enum: ['available', 'blocked', 'connection_lost'],
      },
    },
    ['schemaVersion', 'status'],
  )
  schemas['ReminderScheduleMutationResponseV1'] = object(
    {
      kind: { type: 'string', enum: ['reminders.schedule.v1'] },
      aggregateId: uuid,
      aggregateRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
    },
    ['kind', 'aggregateId', 'aggregateRevision'],
  )
}

export const REMINDERS_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'reminders',
      description: 'Personal reminder settings and Telegram delivery status.',
    },
  ],
  problemCodeComponents: [
    {
      componentName: 'ReminderScheduleRevisionConflictProblemResponseDto',
      codes: ['REMINDER_SCHEDULE_REVISION_CONFLICT'],
    },
  ],
  install: installReminderSchemas,
}
