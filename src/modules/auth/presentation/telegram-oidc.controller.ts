import { Controller, Get, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'

import { StartTelegramOidcLoginUseCase } from '../application/start-telegram-oidc-login.use-case'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import { RequestValidationError } from '@/platform/http/errors/request-validation.error'
import { PublicEndpoint } from '@/platform/http/policy/public-endpoint.decorator'

import { OidcStateCookieAdapter } from './oidc-state-cookie.adapter'

const forbiddenInputIssue = Object.freeze({
  code: 'unknown_field',
  detail: 'Field is not allowed.',
})

function hasWireBody(request: Request): boolean {
  const contentLength = request.headers['content-length']
  const transferEncoding = request.headers['transfer-encoding']
  return (
    request.body !== undefined ||
    (typeof contentLength === 'string' && contentLength !== '0') ||
    transferEncoding !== undefined
  )
}

@ApiTags('auth')
@Controller('auth/telegram')
export class TelegramOidcController {
  public constructor(
    private readonly startLogin: StartTelegramOidcLoginUseCase,
    private readonly stateCookie: OidcStateCookieAdapter,
  ) {}

  @Get('start')
  @PublicEndpoint()
  @ApiOperation({
    operationId: 'startTelegramOidcLogin',
    summary: 'Start the Telegram OpenID Connect authorization ceremony.',
    security: [],
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the verified Telegram authorization endpoint.',
    headers: {
      Location: {
        description: 'Verified Telegram authorization URL.',
        schema: { type: 'string', format: 'uri' },
      },
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Pragma: { schema: { type: 'string', enum: ['no-cache'] } },
      'Referrer-Policy': {
        schema: { type: 'string', enum: ['no-referrer'] },
      },
      'X-Request-ID': {
        description: 'Trusted request correlation ID.',
        schema: { type: 'string' },
      },
      'Set-Cookie': {
        description: 'Short-lived browser OIDC state binding.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiProblemResponses(
    'MALFORMED_REQUEST',
    'PAYLOAD_TOO_LARGE',
    'VALIDATION_FAILED',
    'DEPENDENCY_UNAVAILABLE',
  )
  public async start(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const issues = []
    if (Object.keys(request.query).length > 0) {
      issues.push({ pointer: '/query', ...forbiddenInputIssue })
    }
    if (hasWireBody(request)) {
      issues.push({ pointer: '/body', ...forbiddenInputIssue })
    }
    if (issues.length > 0) throw new RequestValidationError(issues)

    const result = await this.startLogin.execute()
    this.stateCookie.set(response, result.state)
    response.status(302)
    response.setHeader('Location', result.authorizationUrl)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Pragma', 'no-cache')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.end()
  }
}
