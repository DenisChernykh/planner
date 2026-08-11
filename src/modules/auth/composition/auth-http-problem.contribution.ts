import { AuthError, type AuthFailureCode } from '../application/auth-errors'
import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
} from '../presentation/auth-problem.definitions'
import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

const codeMap = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  AUTH_DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const satisfies Readonly<Record<AuthFailureCode, string>>)

export const AUTH_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      AUTHENTICATION_REQUIRED_PROBLEM,
      AUTHORIZATION_DENIED_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'AUTHENTICATION_REQUIRED',
      'AUTHORIZATION_DENIED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined =>
      error instanceof AuthError ? { code: codeMap[error.code] } : undefined,
  })
