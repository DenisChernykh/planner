import { AuthError, type AuthFailureCode } from '../application/auth-errors'
import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  OIDC_ACCESS_DENIED_PROBLEM,
  OIDC_LOGIN_REJECTED_PROBLEM,
} from '../presentation/auth-problem.definitions'
import type {
  HttpProblemContribution,
  HttpProblemMapping,
} from '@/platform/http/errors/problem.contracts'

const codeMap = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  OIDC_LOGIN_REJECTED: 'OIDC_LOGIN_REJECTED',
  OIDC_ACCESS_DENIED: 'OIDC_ACCESS_DENIED',
  OIDC_CALLBACK_INVALID: 'VALIDATION_FAILED',
  AUTH_DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const satisfies Readonly<Record<AuthFailureCode, string>>)

const invalidCallbackIssue = Object.freeze({
  pointer: '/query',
  code: 'invalid_value',
  detail: 'OIDC callback query is invalid.',
})

export const AUTH_HTTP_PROBLEM_CONTRIBUTION: HttpProblemContribution =
  Object.freeze({
    definitions: Object.freeze([
      AUTHENTICATION_REQUIRED_PROBLEM,
      AUTHORIZATION_DENIED_PROBLEM,
      OIDC_LOGIN_REJECTED_PROBLEM,
      OIDC_ACCESS_DENIED_PROBLEM,
    ]),
    mappedCodes: Object.freeze([
      'AUTHENTICATION_REQUIRED',
      'AUTHORIZATION_DENIED',
      'OIDC_LOGIN_REJECTED',
      'OIDC_ACCESS_DENIED',
      'VALIDATION_FAILED',
      'DEPENDENCY_UNAVAILABLE',
    ]),
    map: (error: unknown): HttpProblemMapping | undefined => {
      if (!(error instanceof AuthError)) return undefined
      return error.code === 'OIDC_CALLBACK_INVALID'
        ? { code: 'VALIDATION_FAILED', errors: [invalidCallbackIssue] }
        : { code: codeMap[error.code] }
    },
  })
