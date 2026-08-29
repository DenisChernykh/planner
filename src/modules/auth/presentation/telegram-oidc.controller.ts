import { Controller, Get, Req, Res } from '@nestjs/common'
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'

import {
  CompleteTelegramOidcLoginUseCase,
  type TelegramOidcCallbackCandidate,
} from '../application/complete-telegram-oidc-login.use-case'
import {
  AuthDependencyUnavailableError,
  OidcAccessDeniedError,
  OidcCallbackValidationError,
  OidcLoginRejectedError,
} from '../application/auth-errors'
import { StartTelegramOidcLoginUseCase } from '../application/start-telegram-oidc-login.use-case'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import { ValidationProblemResponseDto } from '@/platform/http/docs/problem-response.dto'
import { RequestValidationError } from '@/platform/http/errors/request-validation.error'
import { PublicEndpoint } from '@/platform/http/policy/public-endpoint.decorator'

import { AuthCookieAdapter } from './auth-cookie.adapter'
import { OIDC_LOGIN_REJECTED_PROBLEM } from './auth-problem.definitions'
import { OidcStateCookieAdapter } from './oidc-state-cookie.adapter'

const forbiddenInputIssue = Object.freeze({
  code: 'unknown_field',
  detail: 'Field is not allowed.',
})

const canonicalStatePattern = /^[A-Za-z0-9_-]{43}$/u
const visibleCodePattern = /^[\x21-\x7e]{1,4096}$/u
const nqsCharPattern = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/u
const oidcResultPath = '/auth/telegram/result'

export const TELEGRAM_OIDC_RESULT_CODES = Object.freeze({
  success: 'success',
  cancelled: 'cancelled',
  loginRejected: 'login_rejected',
  accessDenied: 'access_denied',
  dependencyUnavailable: 'dependency_unavailable',
  invalidCallback: 'invalid_callback',
} as const)

export type TelegramOidcResultCode =
  (typeof TELEGRAM_OIDC_RESULT_CODES)[keyof typeof TELEGRAM_OIDC_RESULT_CODES]

export function telegramOidcResultLocation(
  result: TelegramOidcResultCode,
): string {
  return `${oidcResultPath}?result=${result}`
}

function callbackQuery(request: Request): URLSearchParams {
  return new URL(request.originalUrl, 'http://planner.invalid').searchParams
}

function hasExactKeys(
  query: URLSearchParams,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = [...query.keys()]
  return (
    keys.every((key) => allowed.has(key)) &&
    required.every((key) => query.getAll(key).length === 1) &&
    optional.every((key) => query.getAll(key).length <= 1)
  )
}

function validNqsChar(
  value: string | null,
  maximum: number,
  minimum = 0,
): boolean {
  return (
    value !== null &&
    value.length >= minimum &&
    value.length <= maximum &&
    nqsCharPattern.test(value)
  )
}

function classifyCallback(
  query: URLSearchParams,
): TelegramOidcCallbackCandidate {
  if (hasExactKeys(query, ['state', 'code'])) {
    const code = query.get('code')
    return code !== null && visibleCodePattern.test(code)
      ? Object.freeze({ kind: 'success', code })
      : Object.freeze({ kind: 'invalid' })
  }
  if (
    hasExactKeys(
      query,
      ['state', 'error'],
      ['error_description', 'error_uri'],
    ) &&
    validNqsChar(query.get('error'), 128, 1) &&
    (query.get('error_description') === null ||
      validNqsChar(query.get('error_description'), 1_024)) &&
    (query.get('error_uri') === null ||
      validNqsChar(query.get('error_uri'), 2_048))
  ) {
    return Object.freeze({ kind: 'oauth-error' })
  }
  return Object.freeze({ kind: 'invalid' })
}

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
    private readonly completeLogin: CompleteTelegramOidcLoginUseCase,
    private readonly stateCookie: OidcStateCookieAdapter,
    private readonly sessionCookie: AuthCookieAdapter,
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

  @Get('callback')
  @PublicEndpoint()
  @ApiOperation({
    operationId: 'completeTelegramOidcLogin',
    summary: 'Complete the Telegram OpenID Connect authorization ceremony.',
    security: [],
  })
  @ApiQuery({
    name: 'state',
    required: true,
    description:
      'Canonical OIDC state. Required for both success and OAuth error callbacks.',
    schema: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{43}$',
      minLength: 43,
      maxLength: 43,
    },
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'Authorization code. Supply exactly one of code or error.',
    schema: {
      type: 'string',
      pattern: '^[\\x21-\\x7E]+$',
      minLength: 1,
      maxLength: 4_096,
    },
  })
  @ApiQuery({
    name: 'error',
    required: false,
    description: 'OAuth error. Supply exactly one of error or code.',
    schema: {
      type: 'string',
      pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]+$',
      minLength: 1,
      maxLength: 128,
    },
  })
  @ApiQuery({
    name: 'error_description',
    required: false,
    description:
      'Optional OAuth error description; allowed only with error and ignored by Planner.',
    schema: {
      type: 'string',
      pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]*$',
      minLength: 0,
      maxLength: 1_024,
    },
  })
  @ApiQuery({
    name: 'error_uri',
    required: false,
    description:
      'Optional OAuth error URI; allowed only with error and ignored by Planner.',
    schema: {
      type: 'string',
      pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]*$',
      minLength: 0,
      maxLength: 2_048,
    },
  })
  @ApiResponse({
    status: 303,
    description:
      'Recognized terminal callback; redirect to the fixed Planner result route.',
    headers: {
      Location: {
        description:
          'Fixed relative Planner result route with one backend-owned result code.',
        schema: {
          type: 'string',
          enum: Object.values(TELEGRAM_OIDC_RESULT_CODES).map(
            telegramOidcResultLocation,
          ),
        },
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
        description:
          'Cleared OIDC state cookie; success also sets the local session cookie.',
        schema: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string' },
        },
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: 'Validation failed',
    content: {
      'application/problem+json': {
        schema: { $ref: getSchemaPath(ValidationProblemResponseDto) },
        examples: {
          VALIDATION_FAILED: {
            summary: 'Validation failed',
            value: {
              type: 'https://planner.invalid/problems/validation-failed',
              title: 'Validation failed',
              status: 422,
              detail: 'One or more request fields are invalid.',
              instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
              code: 'VALIDATION_FAILED',
              requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              errors: [
                {
                  pointer: '/query',
                  code: 'invalid_value',
                  detail: 'OIDC callback query is invalid.',
                },
              ],
            },
          },
        },
      },
    },
  })
  @ApiProblemResponses(
    'MALFORMED_REQUEST',
    OIDC_LOGIN_REJECTED_PROBLEM,
    'PAYLOAD_TOO_LARGE',
    'VALIDATION_FAILED',
  )
  public async callback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (hasWireBody(request)) {
      throw new RequestValidationError([
        { pointer: '/body', ...forbiddenInputIssue },
      ])
    }

    const query = callbackQuery(request)
    const states = query.getAll('state')
    const state = states[0]
    if (
      states.length !== 1 ||
      state === undefined ||
      !canonicalStatePattern.test(state) ||
      !this.stateCookie.matches(request.headers.cookie, state)
    ) {
      throw new OidcLoginRejectedError()
    }

    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Pragma', 'no-cache')
    response.setHeader('Referrer-Policy', 'no-referrer')
    let candidate: TelegramOidcCallbackCandidate | undefined
    try {
      try {
        const result = await this.completeLogin.execute(
          state,
          () => {
            candidate = classifyCallback(query)
            return candidate
          },
          Date.now(),
        )
        this.sessionCookie.set(response, result.session)
        response.status(303)
        response.setHeader(
          'Location',
          telegramOidcResultLocation(TELEGRAM_OIDC_RESULT_CODES.success),
        )
      } catch (error: unknown) {
        const resultCode = this.resultCodeFor(error, candidate)
        response.status(303)
        response.setHeader('Location', telegramOidcResultLocation(resultCode))
      }
    } finally {
      this.stateCookie.clear(response)
    }
    response.end()
  }

  private resultCodeFor(
    error: unknown,
    candidate: TelegramOidcCallbackCandidate | undefined,
  ): TelegramOidcResultCode {
    if (error instanceof OidcCallbackValidationError) {
      return TELEGRAM_OIDC_RESULT_CODES.invalidCallback
    }
    if (error instanceof OidcAccessDeniedError) {
      return TELEGRAM_OIDC_RESULT_CODES.accessDenied
    }
    if (error instanceof AuthDependencyUnavailableError) {
      return TELEGRAM_OIDC_RESULT_CODES.dependencyUnavailable
    }
    if (error instanceof OidcLoginRejectedError) {
      return candidate?.kind === 'oauth-error'
        ? TELEGRAM_OIDC_RESULT_CODES.cancelled
        : TELEGRAM_OIDC_RESULT_CODES.loginRejected
    }
    throw error
  }
}
