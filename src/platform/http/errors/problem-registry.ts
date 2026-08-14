import type {
  ProblemDefinition,
  RegisteredProblemDefinition,
} from './problem.contracts'

const problemDefinitions = [
  [
    'malformed-request',
    'MALFORMED_REQUEST',
    400,
    'Malformed request',
    'The request could not be parsed.',
  ],
  [
    'not-found',
    'NOT_FOUND',
    404,
    'Resource not found',
    'The requested resource does not exist.',
  ],
  [
    'conflict',
    'CONFLICT',
    409,
    'Request conflict',
    'The request conflicts with the current resource state.',
  ],
  [
    'command-fingerprint-conflict',
    'COMMAND_FINGERPRINT_CONFLICT',
    409,
    'Command fingerprint conflict',
    'The command key already completed with a different request.',
  ],
  [
    'payload-too-large',
    'PAYLOAD_TOO_LARGE',
    413,
    'Payload too large',
    'The request payload exceeds the configured limit.',
  ],
  [
    'unsupported-media-type',
    'UNSUPPORTED_MEDIA_TYPE',
    415,
    'Unsupported media type',
    'The request content type is not supported.',
  ],
  [
    'validation-failed',
    'VALIDATION_FAILED',
    422,
    'Validation failed',
    'One or more request fields are invalid.',
  ],
  [
    'rate-limit-exceeded',
    'RATE_LIMIT_EXCEEDED',
    429,
    'Rate limit exceeded',
    'Too many requests were submitted in the allowed interval.',
  ],
  [
    'internal-error',
    'INTERNAL_ERROR',
    500,
    'Internal server error',
    'The server could not complete the request.',
  ],
  [
    'dependency-unavailable',
    'DEPENDENCY_UNAVAILABLE',
    503,
    'Dependency unavailable',
    'A required service is temporarily unavailable.',
  ],
] as const

export type CoreProblemCode = (typeof problemDefinitions)[number][1]

export function defineProblemDefinition<const TCode extends string>(
  definition: ProblemDefinition & { readonly code: TCode },
): RegisteredProblemDefinition & { readonly code: TCode } {
  return Object.freeze({
    ...definition,
    type: `https://planner.invalid/problems/${definition.slug}`,
  })
}

export const PROBLEM_CATALOG = Object.freeze(
  problemDefinitions.map(([slug, code, status, title, detail]) =>
    defineProblemDefinition({ slug, code, status, title, detail }),
  ),
)

export function getProblemDefinition(
  code: CoreProblemCode,
): RegisteredProblemDefinition {
  const definition = PROBLEM_CATALOG.find((entry) => entry.code === code)
  if (definition === undefined)
    throw new Error(`Unregistered OpenAPI problem: ${code}`)
  return definition
}

export const COMMAND_FINGERPRINT_CONFLICT_PROBLEM = getProblemDefinition(
  'COMMAND_FINGERPRINT_CONFLICT',
)
