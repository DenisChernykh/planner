export type AuthFailureCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHORIZATION_DENIED'
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

export function mapAuthDependencyFailure(error: unknown): never {
  if (error instanceof AuthError) throw error
  throw new AuthDependencyUnavailableError({ cause: error })
}
