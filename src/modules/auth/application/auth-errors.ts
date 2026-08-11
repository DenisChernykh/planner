export type AuthFailureCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHORIZATION_DENIED'
  | 'OIDC_LOGIN_REJECTED'
  | 'OIDC_ACCESS_DENIED'
  | 'OIDC_CALLBACK_INVALID'
  | 'AUTH_DEPENDENCY_UNAVAILABLE'

export class AuthError extends Error {
  public constructor(
    readonly code: AuthFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AuthError'
  }
}

export class AuthenticationRequiredError extends AuthError {
  public constructor() {
    super('AUTHENTICATION_REQUIRED', 'Authentication required')
    this.name = 'AuthenticationRequiredError'
  }
}

export class AuthCsrfRejectedError extends AuthError {
  public constructor() {
    super('AUTHORIZATION_DENIED', 'Request authorization denied')
    this.name = 'AuthCsrfRejectedError'
  }
}

export class AuthDependencyUnavailableError extends AuthError {
  public constructor(options?: ErrorOptions) {
    super(
      'AUTH_DEPENDENCY_UNAVAILABLE',
      'Authentication dependency unavailable',
      options,
    )
    this.name = 'AuthDependencyUnavailableError'
  }
}

export class OidcLoginRejectedError extends AuthError {
  public constructor(options?: ErrorOptions) {
    super('OIDC_LOGIN_REJECTED', 'Telegram login rejected', options)
    this.name = 'OidcLoginRejectedError'
  }
}

export class OidcAccessDeniedError extends AuthError {
  public constructor(options?: ErrorOptions) {
    super('OIDC_ACCESS_DENIED', 'Telegram access denied', options)
    this.name = 'OidcAccessDeniedError'
  }
}

export class OidcCallbackValidationError extends AuthError {
  public constructor() {
    super('OIDC_CALLBACK_INVALID', 'OIDC callback query is invalid')
    this.name = 'OidcCallbackValidationError'
  }
}

export function mapAuthDependencyFailure(error: unknown): never {
  if (error instanceof AuthError) throw error
  throw new AuthDependencyUnavailableError({ cause: error })
}
