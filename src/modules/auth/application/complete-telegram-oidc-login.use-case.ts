import {
  AuthenticationRequiredError,
  AuthDependencyUnavailableError,
  AuthError,
  OidcCallbackValidationError,
  OidcLoginRejectedError,
} from './auth-errors'
import type { IssuedBrowserSession } from './session-store.port'
import type { TelegramIdentityBindingPort } from './telegram-identity-binding.port'
import type {
  OidcTransactionStorePort,
  TelegramOidcProviderPort,
} from './telegram-oidc.ports'

export type TelegramOidcCallbackCandidate =
  | Readonly<{ kind: 'success'; code: string }>
  | Readonly<{ kind: 'oauth-error' }>
  | Readonly<{ kind: 'invalid' }>

export type TelegramOidcCallbackCandidateFactory =
  () => TelegramOidcCallbackCandidate

export interface LocalSessionIssuerPort {
  execute(userId: string, nowMs: number): Promise<IssuedBrowserSession>
}

export interface CompleteTelegramOidcLoginResult {
  readonly session: IssuedBrowserSession
  readonly returnTo: '/'
}

export class CompleteTelegramOidcLoginUseCase {
  public constructor(
    private readonly transactions: OidcTransactionStorePort,
    private readonly provider: TelegramOidcProviderPort,
    private readonly identities: TelegramIdentityBindingPort,
    private readonly sessions: LocalSessionIssuerPort,
  ) {}

  public async execute(
    state: string,
    classifyCandidate: TelegramOidcCallbackCandidateFactory,
    nowMs: number,
  ): Promise<CompleteTelegramOidcLoginResult> {
    try {
      const transaction = await this.transactions.consume(state)
      if (transaction === undefined) throw new OidcLoginRejectedError()
      const candidate = classifyCandidate()
      if (candidate.kind === 'invalid') {
        throw new OidcCallbackValidationError()
      }
      if (candidate.kind === 'oauth-error') {
        throw new OidcLoginRejectedError()
      }
      const identity = await this.provider.verifyAuthorizationCode({
        code: candidate.code,
        transaction,
        nowMs,
      })
      const userId = await this.identities.bindVerifiedIdentity(identity)
      let session: IssuedBrowserSession
      try {
        session = await this.sessions.execute(userId, nowMs)
      } catch (error: unknown) {
        if (error instanceof AuthenticationRequiredError) {
          throw new AuthDependencyUnavailableError({ cause: error })
        }
        throw error
      }
      return Object.freeze({ session, returnTo: '/' })
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }
}
