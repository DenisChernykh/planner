import { Inject, Injectable } from '@nestjs/common'

import type { AuthenticatedPrincipal } from './auth.types'
import {
  AuthenticationRequiredError,
  mapAuthDependencyFailure,
} from './auth-errors'
import { LOCAL_USER_PORT, type LocalUserPort } from './local-user.port'
import { SESSION_STORE, type SessionStorePort } from './session-store.port'
import { toUserId } from '../domain/user-id'

@Injectable()
export class AuthenticateSessionUseCase {
  public constructor(
    @Inject(LOCAL_USER_PORT) private readonly users: LocalUserPort,
    @Inject(SESSION_STORE) private readonly sessions: SessionStorePort,
  ) {}

  public async execute(
    rawToken: string,
    nowMs: number,
  ): Promise<AuthenticatedPrincipal> {
    try {
      const record = await this.sessions.readAndTouch(rawToken, nowMs)
      if (record === undefined) throw new AuthenticationRequiredError()
      const userId = toUserId(record.userId)
      if (!(await this.users.exists(userId)))
        throw new AuthenticationRequiredError()
      return Object.freeze({ userId, sessionId: record.sessionId })
    } catch (error: unknown) {
      return mapAuthDependencyFailure(error)
    }
  }
}
