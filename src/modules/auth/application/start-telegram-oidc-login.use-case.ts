import { AuthDependencyUnavailableError, AuthError } from './auth-errors'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_SCOPE,
  TELEGRAM_OIDC_TRANSACTION_TTL_MS,
  type OidcCryptoPort,
  type OidcTransaction,
  type OidcTransactionStorePort,
  type TelegramOidcProviderPort,
  type TelegramOidcStartConfig,
  type TelegramOidcStartResult,
} from './telegram-oidc.ports'

const canonicalToken = /^[A-Za-z0-9_-]{43}$/u

function isCanonicalOidcValue(value: string): boolean {
  if (!canonicalToken.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32 && decoded.toString('base64url') === value
}

export class StartTelegramOidcLoginUseCase {
  public constructor(
    private readonly provider: TelegramOidcProviderPort,
    private readonly transactions: OidcTransactionStorePort,
    private readonly crypto: OidcCryptoPort,
    private readonly config: TelegramOidcStartConfig,
  ) {}

  public async execute(): Promise<TelegramOidcStartResult> {
    try {
      const transactionTtlMs =
        this.config.transactionTtlMs ?? TELEGRAM_OIDC_TRANSACTION_TTL_MS
      if (transactionTtlMs !== TELEGRAM_OIDC_TRANSACTION_TTL_MS) {
        throw new AuthDependencyUnavailableError()
      }
      const authorizationEndpoint =
        await this.provider.resolveAuthorizationEndpoint()
      if (authorizationEndpoint !== TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT) {
        throw new AuthDependencyUnavailableError()
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = this.crypto.generateOidcToken()
        const nonce = this.crypto.generateOidcToken()
        const codeVerifier = this.crypto.generateOidcToken()
        if (!this.validTuple(state, nonce, codeVerifier)) continue

        const codeChallenge = this.crypto.sha256Base64Url(codeVerifier)
        if (!isCanonicalOidcValue(codeChallenge)) {
          throw new AuthDependencyUnavailableError()
        }
        const location = new URL(authorizationEndpoint)
        location.searchParams.set('client_id', this.config.clientId)
        location.searchParams.set('redirect_uri', this.config.callbackUrl)
        location.searchParams.set('response_type', 'code')
        location.searchParams.set('scope', TELEGRAM_OIDC_SCOPE)
        location.searchParams.set('state', state)
        location.searchParams.set('nonce', nonce)
        location.searchParams.set('code_challenge', codeChallenge)
        location.searchParams.set('code_challenge_method', 'S256')
        const authorizationUrl = location.toString()

        const transaction: OidcTransaction = Object.freeze({
          schema: 1,
          issuer: TELEGRAM_OIDC_ISSUER,
          clientId: this.config.clientId,
          nonce,
          codeVerifier,
          callbackUrl: this.config.callbackUrl,
          returnTo: '/',
        })
        const created = await this.transactions.create(
          state,
          transaction,
          transactionTtlMs,
        )
        if (created === 'collision') continue

        return Object.freeze({
          authorizationUrl,
          state,
        })
      }
      throw new AuthDependencyUnavailableError()
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  private validTuple(state: string, nonce: string, verifier: string): boolean {
    return (
      isCanonicalOidcValue(state) &&
      isCanonicalOidcValue(nonce) &&
      isCanonicalOidcValue(verifier) &&
      new Set([state, nonce, verifier]).size === 3
    )
  }
}
