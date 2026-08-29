import { Controller, Get } from '@nestjs/common'
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'

import {
  type BotNavigationResult,
  GetBotNavigationQuery,
} from '../application/get-bot-navigation.query'
import { AUTHENTICATION_REQUIRED_PROBLEM } from '@/modules/auth'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'

const navigationResponseSchema = {
  oneOf: [
    {
      type: 'object' as const,
      additionalProperties: false,
      required: ['schemaVersion', 'capability', 'status', 'url'],
      properties: {
        schemaVersion: {
          type: 'string',
          enum: ['telegram.navigation.v1'],
        },
        capability: { type: 'string', enum: ['open_bot'] },
        status: { type: 'string', enum: ['available'] },
        url: {
          type: 'string',
          format: 'uri',
          pattern: '^https://t\\.me/[A-Za-z0-9_]{5,32}$',
        },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      required: ['schemaVersion', 'capability', 'status', 'url'],
      properties: {
        schemaVersion: {
          type: 'string',
          enum: ['telegram.navigation.v1'],
        },
        capability: { type: 'string', enum: ['open_bot'] },
        status: {
          type: 'string',
          enum: ['disabled', 'misconfigured'],
        },
        url: { type: 'string', nullable: true, enum: [null] },
      },
    },
  ],
}

@ApiTags('telegram')
@ApiSecurity('sessionCookie')
@Controller('telegram')
export class TelegramNavigationController {
  public constructor(private readonly getNavigation: GetBotNavigationQuery) {}

  @Get('navigation')
  @ApiOperation({
    operationId: 'getTelegramNavigation',
    summary: 'Read the configured safe Telegram bot navigation capability.',
  })
  @ApiOkResponse({ schema: navigationResponseSchema })
  @ApiProblemResponses(AUTHENTICATION_REQUIRED_PROBLEM)
  public get(): BotNavigationResult {
    return this.getNavigation.execute()
  }
}
