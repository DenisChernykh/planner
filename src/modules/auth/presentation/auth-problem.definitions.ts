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

export const OIDC_LOGIN_REJECTED_PROBLEM = defineProblemDefinition({
  slug: 'oidc-login-rejected',
  code: 'OIDC_LOGIN_REJECTED',
  status: 401,
  title: 'Telegram login rejected',
  detail: 'The Telegram login attempt could not be accepted.',
})

export const OIDC_ACCESS_DENIED_PROBLEM = defineProblemDefinition({
  slug: 'oidc-access-denied',
  code: 'OIDC_ACCESS_DENIED',
  status: 403,
  title: 'Telegram access denied',
  detail: 'The verified Telegram identity is not allowed to access Planner.',
})
