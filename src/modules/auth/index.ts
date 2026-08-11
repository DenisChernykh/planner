export * from './application/index'
export * from './composition/auth.module'
export * from './composition/create-local-user-provisioning'
export * from './composition/local-user-provisioning.module'
export {
  CurrentPrincipal,
  readAuthenticatedPrincipal,
} from './presentation/current-principal.decorator'
export type { AuthenticatedPrincipal } from './application/auth.types'
export {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
} from './presentation/auth-problem.definitions'
