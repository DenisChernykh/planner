export interface ProblemFieldError {
  readonly pointer: string
  readonly code: string
  readonly detail: string
}

export interface ProblemDocument {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly code: string
  readonly requestId: string
  readonly errors?: readonly ProblemFieldError[]
}

export interface ProblemDefinition {
  readonly slug: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail: string
}

export interface RegisteredProblemDefinition extends ProblemDefinition {
  readonly type: string
}

export interface HttpProblemMapping {
  readonly code: string
  readonly errors?: readonly ProblemFieldError[]
}

export type HttpProblemMapper = (
  error: unknown,
) => HttpProblemMapping | undefined

export interface HttpProblemContribution {
  readonly definitions: readonly RegisteredProblemDefinition[]
  readonly mappedCodes: readonly string[]
  readonly map: HttpProblemMapper
}

export interface MappedHttpProblem {
  readonly definition: RegisteredProblemDefinition
  readonly errors?: readonly ProblemFieldError[]
  readonly unexpected: boolean
}
