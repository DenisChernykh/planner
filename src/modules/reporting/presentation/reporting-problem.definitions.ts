import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const REPORTING_AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'reporting-authorization-denied',
  code: 'REPORTING_AUTHORIZATION_DENIED',
  status: 403,
  title: 'Reporting authorization denied',
  detail: 'The current principal cannot access this report.',
})

export const REPORTING_QUERY_INVALID_PROBLEM = defineProblemDefinition({
  slug: 'reporting-query-invalid',
  code: 'REPORTING_QUERY_INVALID',
  status: 400,
  title: 'Reporting query invalid',
  detail: 'The requested report query is invalid.',
})

export const REPORTING_NOT_FOUND_PROBLEM = defineProblemDefinition({
  slug: 'reporting-not-found',
  code: 'REPORTING_NOT_FOUND',
  status: 404,
  title: 'Pilot report not found',
  detail: 'The requested active or preliminary report was not found.',
})

export const REPORTING_SOURCE_CHANGED_PROBLEM = defineProblemDefinition({
  slug: 'reporting-source-changed',
  code: 'REPORTING_SOURCE_CHANGED',
  status: 409,
  title: 'Pilot report source changed',
  detail: 'The report source changed while it was being read.',
})
