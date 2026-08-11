export const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org'
export const TELEGRAM_OIDC_DISCOVERY_URL =
  'https://oauth.telegram.org/.well-known/openid-configuration'
export const TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT =
  'https://oauth.telegram.org/auth'
export const TELEGRAM_OIDC_TOKEN_ENDPOINT = 'https://oauth.telegram.org/token'
export const TELEGRAM_OIDC_JWKS_URL =
  'https://oauth.telegram.org/.well-known/jwks.json'
export const TELEGRAM_OIDC_CALLBACK_PATH = '/auth/telegram/callback'
export const TELEGRAM_OIDC_SCOPE = 'openid profile telegram:bot_access'
export const TELEGRAM_OIDC_TRANSACTION_TTL_MS = 300_000

export interface OidcTransaction {
  readonly schema: 1
  readonly issuer: typeof TELEGRAM_OIDC_ISSUER
  readonly clientId: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly callbackUrl: string
  readonly returnTo: '/'
}

export interface OidcTransactionStorePort {
  create(
    state: string,
    transaction: OidcTransaction,
    ttlMs: number,
  ): Promise<'created' | 'collision'>
  consume(state: string): Promise<OidcTransaction | undefined>
}

export interface TelegramOidcProviderPort {
  resolveAuthorizationEndpoint(): Promise<string>
  verifyAuthorizationCode(
    input: TelegramOidcVerificationInput,
  ): Promise<VerifiedTelegramOidcIdentity>
}

export interface TelegramOidcVerificationInput {
  readonly code: string
  readonly transaction: OidcTransaction
  readonly nowMs: number
}

export interface VerifiedTelegramOidcIdentity {
  readonly issuer: typeof TELEGRAM_OIDC_ISSUER
  readonly subject: string
  readonly providerUserId: bigint
}

export interface OidcCryptoPort {
  generateOidcToken(): string
  sha256Base64Url(value: string): string
}

export interface TelegramOidcStartConfig {
  readonly clientId: string
  readonly callbackUrl: string
  readonly transactionTtlMs?: number
}

export interface TelegramOidcStartResult {
  readonly authorizationUrl: string
  readonly state: string
}

export type TelegramOidcFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface TelegramOidcProviderConfig {
  readonly timeoutMs: number
  readonly bodyLimitBytes: number
  readonly clientId?: string
  readonly clientSecret?: string
  readonly callbackUrl?: string
}

export const OIDC_TRANSACTION_STORE: unique symbol = Symbol(
  'OIDC_TRANSACTION_STORE',
)
export const TELEGRAM_OIDC_PROVIDER: unique symbol = Symbol(
  'TELEGRAM_OIDC_PROVIDER',
)
