import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common'
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'
import type { Response } from 'express'

import type { AuthenticatedPrincipal } from '../application/auth.types'
import { GetCsrfTokenQuery } from '../application/get-csrf-token.query'
import { RevokeSessionUseCase } from '../application/revoke-session.use-case'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'

import { AuthCookieAdapter } from './auth-cookie.adapter'
import { AuthRequestContext } from './auth-request.context'
import {
  AuthenticatedPrincipalResponseDto,
  CsrfTokenResponseDto,
} from './auth-response.dto'
import { CurrentPrincipal } from './current-principal.decorator'
import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
} from './auth-problem.definitions'

@ApiTags('auth')
@ApiSecurity('sessionCookie')
@Controller('auth')
export class AuthController {
  public constructor(
    private readonly csrf: GetCsrfTokenQuery,
    private readonly revoke: RevokeSessionUseCase,
    private readonly requestContext: AuthRequestContext,
    private readonly cookies: AuthCookieAdapter,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Read the current local session principal.' })
  @ApiOkResponse({ type: AuthenticatedPrincipalResponseDto })
  @ApiProblemResponses(
    AUTHENTICATION_REQUIRED_PROBLEM,
    'DEPENDENCY_UNAVAILABLE',
  )
  public me(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): AuthenticatedPrincipalResponseDto {
    return principal
  }

  @Get('csrf')
  @ApiOperation({ summary: 'Derive the current session CSRF token.' })
  @ApiOkResponse({ type: CsrfTokenResponseDto })
  @ApiProblemResponses(
    AUTHENTICATION_REQUIRED_PROBLEM,
    'DEPENDENCY_UNAVAILABLE',
  )
  public csrfToken(): Promise<CsrfTokenResponseDto> {
    return this.csrf.execute(this.requestContext.rawToken, Date.now())
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke and clear the current browser session.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiProblemResponses(
    AUTHENTICATION_REQUIRED_PROBLEM,
    AUTHORIZATION_DENIED_PROBLEM,
    'UNSUPPORTED_MEDIA_TYPE',
    'DEPENDENCY_UNAVAILABLE',
  )
  public async logout(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.revoke.execute(principal, this.requestContext.rawToken)
    this.cookies.clear(response)
  }
}
