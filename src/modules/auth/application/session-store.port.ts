import type { AuthenticatedPrincipal } from './auth.types'
import type { UserId } from '../domain/user-id'

export interface StoredSessionRecord {
  readonly schema: 1
  readonly userId: UserId | string
  readonly sessionId: string
  readonly csrfSeed: string
  readonly createdAtMs: number
  readonly lastSeenAtMs: number
  readonly absoluteExpiresAtMs: number
}

export interface IssuedBrowserSession {
  readonly rawToken: string
  readonly sessionId: string
  readonly csrfToken: string
  readonly absoluteExpiresAt: Date
}

export interface SessionStorePort {
  issue(userId: UserId | string, nowMs: number): Promise<IssuedBrowserSession>
  readAndTouch(
    rawToken: string,
    nowMs: number,
  ): Promise<StoredSessionRecord | undefined>
  csrfToken(record: StoredSessionRecord): string
  revoke(rawToken: string, principal: AuthenticatedPrincipal): Promise<boolean>
}

export const SESSION_STORE: unique symbol = Symbol('SESSION_STORE')
