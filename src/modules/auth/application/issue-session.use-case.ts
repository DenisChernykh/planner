import { Inject, Injectable } from '@nestjs/common'

import {
  AuthenticationRequiredError,
  mapAuthDependencyFailure,
} from './auth-errors'
import { LOCAL_USER_PORT, type LocalUserPort } from './local-user.port'
import {
  SESSION_STORE,
  type IssuedBrowserSession,
  type SessionStorePort,
} from './session-store.port'
import { toUserId } from '../domain/user-id'

@Injectable()
export class IssueSessionUseCase {
  public constructor(
    @Inject(LOCAL_USER_PORT) private readonly users: LocalUserPort,
    @Inject(SESSION_STORE) private readonly sessions: SessionStorePort,
  ) {}

  public async execute(
    userId: string,
    nowMs: number,
  ): Promise<IssuedBrowserSession> {
    try {
      const typedUserId = toUserId(userId)
      if (!(await this.users.exists(typedUserId))) {
        throw new AuthenticationRequiredError()
      }
      return await this.sessions.issue(typedUserId, nowMs)
    } catch (error: unknown) {
      return mapAuthDependencyFailure(error)
    }
  }
}
