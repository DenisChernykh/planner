import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import { AuthenticationRequiredError } from '../application/auth-errors'
import type { AuthenticatedPrincipal } from '../application/auth.types'

const principalKey = Symbol('auth:principal')

export function attachAuthenticatedPrincipal(
  request: object,
  principal: AuthenticatedPrincipal,
): void {
  if (Object.hasOwn(request, principalKey)) {
    throw new Error('Authenticated principal already attached')
  }
  Object.defineProperty(request, principalKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: principal,
  })
}

export function readAuthenticatedPrincipal(
  request: object,
): AuthenticatedPrincipal {
  const principal = Reflect.get(request, principalKey) as
    AuthenticatedPrincipal | undefined
  if (principal === undefined) throw new AuthenticationRequiredError()
  return principal
}

export const CurrentPrincipal: (
  ...dataOrPipes: unknown[]
) => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal =>
    readAuthenticatedPrincipal(context.switchToHttp().getRequest<object>()),
)
