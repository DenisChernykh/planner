import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const TRACKING_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'tracking-authorization-denied',
  code: 'TRACKING_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Tracking authorization denied',
  detail: 'The current principal cannot access this tracking operation.',
})

export const TRACKING_QUERY_INVALID_PROBLEM = defineProblemDefinition({
  slug: 'tracking-query-invalid',
  code: 'TRACKING_QUERY_INVALID',
  status: 400,
  title: 'Tracking query invalid',
  detail: 'The requested tracking query is invalid.',
})

export const TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-target-not-found',
  code: 'TRACKING_FACT_TARGET_NOT_FOUND',
  status: 404,
  title: 'Tracking fact target not found',
  detail: 'The requested tracking fact target was not found.',
})

export const TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM = defineProblemDefinition(
  {
    slug: 'tracking-fact-target-unavailable',
    code: 'TRACKING_FACT_TARGET_UNAVAILABLE',
    status: 409,
    title: 'Tracking fact target unavailable',
    detail: 'The requested tracking fact target cannot be changed.',
  },
)

export const TRACKING_FACT_REVISION_CONFLICT_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-revision-conflict',
  code: 'TRACKING_FACT_REVISION_CONFLICT',
  status: 409,
  title: 'Tracking fact revision conflict',
  detail: 'The tracking fact changed before this request was applied.',
})

export const TRACKING_FACT_VALUE_INVALID_PROBLEM = defineProblemDefinition({
  slug: 'tracking-fact-value-invalid',
  code: 'TRACKING_FACT_VALUE_INVALID',
  status: 422,
  title: 'Tracking fact value invalid',
  detail: 'The fact value does not match the published target.',
})
