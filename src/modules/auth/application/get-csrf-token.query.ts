import { Inject, Injectable } from '@nestjs/common'

import {
  AuthenticationRequiredError,
  mapAuthDependencyFailure,
} from './auth-errors'
import { SESSION_STORE, type SessionStorePort } from './session-store.port'

@Injectable()
export class GetCsrfTokenQuery {
  public constructor(
    @Inject(SESSION_STORE) private readonly sessions: SessionStorePort,
  ) {}

  public async execute(
    rawToken: string,
    nowMs: number,
  ): Promise<{ readonly csrfToken: string }> {
    try {
      const record = await this.sessions.readAndTouch(rawToken, nowMs)
      if (record === undefined) throw new AuthenticationRequiredError()
      return Object.freeze({ csrfToken: this.sessions.csrfToken(record) })
    } catch (error: unknown) {
      return mapAuthDependencyFailure(error)
    }
  }
}
