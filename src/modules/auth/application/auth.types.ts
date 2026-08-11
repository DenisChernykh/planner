import type { UserId } from '../domain/user-id'

export interface AuthenticatedPrincipal {
  readonly userId: UserId
  readonly sessionId: string
}
