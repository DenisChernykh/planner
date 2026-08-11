import type { ProblemFieldError } from './problem.contracts'

export class RequestValidationError extends Error {
  public readonly errors: readonly ProblemFieldError[]

  public constructor(errors: readonly ProblemFieldError[]) {
    super('Request validation failed')
    this.name = 'RequestValidationError'
    this.errors = Object.freeze(
      errors.map((error) => Object.freeze({ ...error })),
    )
  }
}
