import { defineProblemDefinition } from '@/platform/http/errors/problem-registry'

export const AUTHENTICATION_REQUIRED_PROBLEM = defineProblemDefinition({
  slug: 'authentication-required',
  code: 'AUTHENTICATION_REQUIRED',
  status: 401,
  title: 'Authentication required',
  detail: 'A valid browser session is required.',
})

export const AUTHORIZATION_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'authorization-denied',
  code: 'AUTHORIZATION_DENIED',
  status: 403,
  title: 'Authorization denied',
  detail: 'The request did not satisfy browser authorization controls.',
})
