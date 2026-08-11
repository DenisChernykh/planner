import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { AuthenticationRequiredError } from '../application/auth-errors'
import type { AuthenticateSessionUseCase } from '../application/authenticate-session.use-case'
import { PUBLIC_ENDPOINT_METADATA } from '@/platform/http/policy/public-endpoint.decorator'

import type { AuthRequestContext } from './auth-request.context'
import { attachAuthenticatedPrincipal } from './current-principal.decorator'
import { readCanonicalSessionToken } from './session-cookie'

interface CookieRequest {
  readonly headers: { readonly cookie?: string }
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateSessionUseCase,
    private readonly requestContext: AuthRequestContext,
    private readonly cookieName: string,
    private readonly now: () => number = Date.now,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    )
    if (isPublic === true) return true
    const request = context.switchToHttp().getRequest<CookieRequest>()
    const rawToken = readCanonicalSessionToken(
      request.headers.cookie,
      this.cookieName,
    )
    if (rawToken === undefined) throw new AuthenticationRequiredError()
    const principal = await this.authenticate.execute(rawToken, this.now())
    attachAuthenticatedPrincipal(request, principal)
    this.requestContext.prepare(request, principal, rawToken)
    return true
  }
}
