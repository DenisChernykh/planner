import { Inject, Injectable } from '@nestjs/common'

import type { AuthenticatedPrincipal } from './auth.types'
import { mapAuthDependencyFailure } from './auth-errors'
import { SESSION_STORE, type SessionStorePort } from './session-store.port'

@Injectable()
export class RevokeSessionUseCase {
  public constructor(
    @Inject(SESSION_STORE) private readonly sessions: SessionStorePort,
  ) {}

  public async execute(
    principal: AuthenticatedPrincipal,
    rawToken: string,
  ): Promise<void> {
    try {
      await this.sessions.revoke(rawToken, principal)
    } catch (error: unknown) {
      mapAuthDependencyFailure(error)
    }
  }
}
