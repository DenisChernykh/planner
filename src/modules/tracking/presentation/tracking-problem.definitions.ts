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
