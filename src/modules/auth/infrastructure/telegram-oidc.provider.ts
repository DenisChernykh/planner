import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from 'node:stream/web'

import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose'

import {
  AuthDependencyUnavailableError,
  AuthError,
  OidcLoginRejectedError,
} from '../application/auth-errors'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URL,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
  type TelegramOidcFetch,
  type TelegramOidcProviderConfig,
  type TelegramOidcProviderPort,
  type TelegramOidcVerificationInput,
  type VerifiedTelegramOidcIdentity,
} from '../application/telegram-oidc.ports'

import { isCanonicalBase64Url } from './node-auth-crypto.adapter'

const PROVIDER_TIMEOUT_MS = 2_000
const PROVIDER_BODY_LIMIT_BYTES = 16_384
const MAX_JWKS_KEYS = 16
const MAX_PROVIDER_USER_ID = 2 ** 52 - 1
const MAX_ACCESS_TOKEN_BYTES = 8_192
const MAX_ID_TOKEN_BYTES = 16_384

interface TelegramDiscoveryMetadata {
  readonly issuer: typeof TELEGRAM_OIDC_ISSUER
  readonly authorizationEndpoint: typeof TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT
}

interface TelegramCallbackMetadata extends TelegramDiscoveryMetadata {
  readonly tokenEndpoint: typeof TELEGRAM_OIDC_TOKEN_ENDPOINT
  readonly jwksUrl: typeof TELEGRAM_OIDC_JWKS_URL
}

interface CallbackConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly callbackUrl: string
}

interface TokenSuccess {
  readonly accessToken: string
  readonly idToken: string
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined
}

function includes(value: unknown, expected: string): boolean {
  return stringArray(value)?.includes(expected) === true
}

function decodeStartMetadata(
  value: unknown,
): TelegramDiscoveryMetadata | undefined {
  if (!isRecord(value)) return undefined
  if (
    value['issuer'] !== TELEGRAM_OIDC_ISSUER ||
    value['authorization_endpoint'] !== TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT ||
    !includes(value['response_types_supported'], 'code') ||
    !includes(value['code_challenge_methods_supported'], 'S256') ||
    !includes(value['scopes_supported'], 'openid') ||
    !includes(value['scopes_supported'], 'profile') ||
    !includes(value['scopes_supported'], 'telegram:bot_access')
  ) {
    return undefined
  }
  return Object.freeze({
    issuer: TELEGRAM_OIDC_ISSUER,
    authorizationEndpoint: TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  })
}

function decodeCallbackMetadata(
  value: unknown,
): TelegramCallbackMetadata | undefined {
  const start = decodeStartMetadata(value)
  if (
    start === undefined ||
    !isRecord(value) ||
    value['token_endpoint'] !== TELEGRAM_OIDC_TOKEN_ENDPOINT ||
    value['jwks_uri'] !== TELEGRAM_OIDC_JWKS_URL ||
    !includes(value['grant_types_supported'], 'authorization_code') ||
    !includes(
      value['token_endpoint_auth_methods_supported'],
      'client_secret_basic',
    ) ||
    !includes(value['id_token_signing_alg_values_supported'], 'RS256')
  ) {
    return undefined
  }
  return Object.freeze({
    ...start,
    tokenEndpoint: TELEGRAM_OIDC_TOKEN_ENDPOINT,
    jwksUrl: TELEGRAM_OIDC_JWKS_URL,
  })
}

function isJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type')
  return (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  )
}

async function readBoundedBody(
  response: Response,
  bodyLimitBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (/^(?:0|[1-9][0-9]*)$/u.test(contentLength) === false ||
      Number(contentLength) > bodyLimitBytes)
  ) {
    throw new Error('OIDC provider body rejected')
  }
  if (response.body === null) return ''

  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > bodyLimitBytes) {
        await reader.cancel()
        throw new Error('OIDC provider body rejected')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  )
}

async function readJson(
  response: Response,
  bodyLimitBytes: number,
): Promise<unknown> {
  if (!isJsonContentType(response)) {
    throw new Error('OIDC provider media type rejected')
  }
  return JSON.parse(await readBoundedBody(response, bodyLimitBytes)) as unknown
}

function validClientSecret(value: string): boolean {
  const size = Buffer.byteLength(value, 'utf8')
  return (
    size >= 16 &&
    size <= 512 &&
    Buffer.from(value, 'utf8').toString('utf8') === value &&
    !containsControlCharacter(value)
  )
}

function callbackConfig(
  config: TelegramOidcProviderConfig,
): CallbackConfig | undefined {
  const values = [config.clientId, config.clientSecret, config.callbackUrl]
  if (values.every((value) => value === undefined)) return undefined
  if (
    typeof config.clientId !== 'string' ||
    !/^[1-9][0-9]*$/u.test(config.clientId) ||
    typeof config.clientSecret !== 'string' ||
    !validClientSecret(config.clientSecret) ||
    typeof config.callbackUrl !== 'string'
  ) {
    throw new Error('Telegram OIDC callback config rejected')
  }
  return Object.freeze({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    callbackUrl: config.callbackUrl,
  })
}

function validOpaque(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximumBytes &&
    /^[\x21-\x7e]+$/u.test(value)
  )
}

function decodeTokenSuccess(value: unknown): TokenSuccess | undefined {
  if (!isRecord(value)) return undefined
  const expiresIn = value['expires_in']
  if (
    !validOpaque(value['access_token'], MAX_ACCESS_TOKEN_BYTES) ||
    value['token_type'] !== 'Bearer' ||
    typeof value['id_token'] !== 'string' ||
    Buffer.byteLength(value['id_token'], 'ascii') > MAX_ID_TOKEN_BYTES ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
      value['id_token'],
    ) ||
    (expiresIn !== undefined &&
      (typeof expiresIn !== 'number' ||
        !Number.isSafeInteger(expiresIn) ||
        expiresIn <= 0))
  ) {
    return undefined
  }
  return Object.freeze({
    accessToken: value['access_token'],
    idToken: value['id_token'],
  })
}

function visibleAscii(value: string, maximum: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/u.test(value)
  )
}

function validProtectedHeader(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const kidValue = value['kid']
  if (
    value['alg'] !== 'RS256' ||
    typeof kidValue !== 'string' ||
    !visibleAscii(kidValue, 128) ||
    (value['typ'] !== undefined && value['typ'] !== 'JWT')
  ) {
    return false
  }
  return !['jku', 'x5u', 'jwk', 'x5c', 'crit', 'b64'].some(
    (field) => field in value,
  )
}

function base64UrlBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined
  }
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : undefined
}

function modulusBits(value: unknown): number | undefined {
  const bytes = base64UrlBytes(value)
  if (bytes === undefined || bytes.length === 0) return undefined
  let offset = 0
  while (offset < bytes.length && bytes[offset] === 0) offset += 1
  if (offset === bytes.length) return 0
  const first = bytes[offset]
  if (first === undefined) return undefined
  return (bytes.length - offset - 1) * 8 + (32 - Math.clz32(first))
}

function validRsaPublicExponent(value: unknown): boolean {
  const bytes = base64UrlBytes(value)
  if (
    bytes === undefined ||
    bytes.length === 0 ||
    bytes.length > 4 ||
    bytes[0] === 0
  ) {
    return false
  }
  let exponent = 0
  for (const byte of bytes) exponent = exponent * 256 + byte
  return exponent >= 3 && exponent % 2 === 1
}

function selectVerificationJwk(
  value: unknown,
  expectedKid: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value['keys'])) return undefined
  const keys = value['keys']
  if (keys.length < 1 || keys.length > MAX_JWKS_KEYS) return undefined
  const unique = new Set<string>()
  const matching: Record<string, unknown>[] = []
  for (const item of keys) {
    if (!isRecord(item)) return undefined
    const itemKid = item['kid']
    const itemAlg = item['alg']
    if (
      typeof itemKid !== 'string' ||
      !visibleAscii(itemKid, 128) ||
      typeof itemAlg !== 'string'
    ) {
      return undefined
    }
    const identity = `${itemKid}\u0000${itemAlg}`
    if (unique.has(identity)) return undefined
    unique.add(identity)
    if (itemKid !== expectedKid || itemAlg !== 'RS256') continue
    const keyOps = item['key_ops']
    if (
      item['kty'] !== 'RSA' ||
      (item['use'] !== undefined && item['use'] !== 'sig') ||
      (keyOps !== undefined &&
        (!Array.isArray(keyOps) ||
          !keyOps.every((operation) => typeof operation === 'string') ||
          !keyOps.includes('verify'))) ||
      modulusBits(item['n']) === undefined ||
      (modulusBits(item['n']) ?? 0) < 2_048 ||
      !validRsaPublicExponent(item['e']) ||
      ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(
        (privateField) => privateField in item,
      )
    ) {
      return undefined
    }
    matching.push(item)
  }
  return matching.length === 1 ? matching[0] : undefined
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

function oidcHash(value: string): string {
  return createHash('sha256')
    .update(value, 'ascii')
    .digest()
    .subarray(0, 16)
    .toString('base64url')
}

function validSubject(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 255 &&
    Buffer.from(value, 'utf8').toString('utf8') === value &&
    !containsControlCharacter(value)
  )
}

export class TelegramOidcProvider implements TelegramOidcProviderPort {
  private readonly callback: CallbackConfig | undefined

  public constructor(
    private readonly fetcher: TelegramOidcFetch = globalThis.fetch,
    private readonly config: TelegramOidcProviderConfig = {
      timeoutMs: PROVIDER_TIMEOUT_MS,
      bodyLimitBytes: PROVIDER_BODY_LIMIT_BYTES,
    },
  ) {
    if (
      config.timeoutMs !== PROVIDER_TIMEOUT_MS ||
      config.bodyLimitBytes !== PROVIDER_BODY_LIMIT_BYTES
    ) {
      throw new Error('Telegram OIDC provider bounds rejected')
    }
    this.callback = callbackConfig(config)
  }

  public async resolveAuthorizationEndpoint(): Promise<string> {
    try {
      const metadata = decodeStartMetadata(await this.fetchDiscovery())
      if (metadata === undefined) {
        throw new Error('OIDC discovery metadata rejected')
      }
      return metadata.authorizationEndpoint
    } catch (error: unknown) {
      return this.mapDependency(error)
    }
  }

  public async verifyAuthorizationCode(
    input: TelegramOidcVerificationInput,
  ): Promise<VerifiedTelegramOidcIdentity> {
    try {
      const config = this.requireCallbackConfig(input)
      const metadata = decodeCallbackMetadata(await this.fetchDiscovery())
      if (metadata === undefined) {
        throw new Error('OIDC callback discovery metadata rejected')
      }
      const token = await this.exchangeCode(input, config, metadata)
      let protectedHeader: unknown
      try {
        protectedHeader = decodeProtectedHeader(token.idToken)
      } catch {
        throw new OidcLoginRejectedError()
      }
      if (!validProtectedHeader(protectedHeader)) {
        throw new OidcLoginRejectedError()
      }
      const kid = protectedHeader['kid'] as string
      const jwksValue = await this.fetchJson(metadata.jwksUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      const verificationJwk = selectVerificationJwk(jwksValue, kid)
      if (verificationJwk === undefined) {
        throw new Error('OIDC JWKS rejected')
      }
      const verificationKey = await importJWK(verificationJwk, 'RS256')
      let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
      try {
        ;({ payload } = await jwtVerify(token.idToken, verificationKey, {
          algorithms: ['RS256'],
          audience: config.clientId,
          issuer: TELEGRAM_OIDC_ISSUER,
          requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'id'],
          clockTolerance: 30,
          currentDate: new Date(input.nowMs),
        }))
      } catch {
        throw new OidcLoginRejectedError()
      }
      return this.projectIdentity(payload, token, input, config)
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  private async fetchDiscovery(): Promise<unknown> {
    return this.fetchJson(TELEGRAM_OIDC_DISCOVERY_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
  }

  private async fetchJson(input: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(input, init)
    if (input !== TELEGRAM_OIDC_TOKEN_ENDPOINT && response.status !== 200) {
      throw new Error('OIDC provider response rejected')
    }
    return readJson(response, this.config.bodyLimitBytes)
  }

  private async exchangeCode(
    input: TelegramOidcVerificationInput,
    config: CallbackConfig,
    metadata: TelegramCallbackMetadata,
  ): Promise<TokenSuccess> {
    const body = new URLSearchParams()
    body.set('grant_type', 'authorization_code')
    body.set('code', input.code)
    body.set('redirect_uri', config.callbackUrl)
    body.set('client_id', config.clientId)
    body.set('code_verifier', input.transaction.codeVerifier)
    const response = await this.fetcher(metadata.tokenEndpoint, {
      method: 'POST',
      body,
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    const value = await readJson(response, this.config.bodyLimitBytes)
    if (response.status === 400) {
      if (isRecord(value) && value['error'] === 'invalid_grant') {
        throw new OidcLoginRejectedError()
      }
      throw new Error('OIDC token error rejected')
    }
    if (response.status !== 200) throw new Error('OIDC token status rejected')
    const token = decodeTokenSuccess(value)
    if (token === undefined) throw new Error('OIDC token response rejected')
    return token
  }

  private requireCallbackConfig(
    input: TelegramOidcVerificationInput,
  ): CallbackConfig {
    const config = this.callback
    if (
      config === undefined ||
      !visibleAscii(input.code, 4_096) ||
      !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < 0 ||
      input.transaction.issuer !== TELEGRAM_OIDC_ISSUER ||
      input.transaction.clientId !== config.clientId ||
      input.transaction.callbackUrl !== config.callbackUrl ||
      input.transaction.returnTo !== '/' ||
      !isCanonicalBase64Url(input.transaction.nonce, 32) ||
      !isCanonicalBase64Url(input.transaction.codeVerifier, 32)
    ) {
      throw new Error('OIDC callback input rejected')
    }
    return config
  }

  private projectIdentity(
    payload: Awaited<ReturnType<typeof jwtVerify>>['payload'],
    token: TokenSuccess,
    input: TelegramOidcVerificationInput,
    config: CallbackConfig,
  ): VerifiedTelegramOidcIdentity {
    const nowSeconds = Math.floor(input.nowMs / 1_000)
    const issuedAt = payload.iat
    const expiresAt = payload.exp
    const nonce = payload['nonce']
    const providerId = payload['id']
    if (
      payload.iss !== TELEGRAM_OIDC_ISSUER ||
      payload.aud !== config.clientId ||
      (payload['azp'] !== undefined && payload['azp'] !== config.clientId) ||
      !validSubject(payload.sub) ||
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      (issuedAt as number) < nowSeconds - 330 ||
      (issuedAt as number) > nowSeconds + 30 ||
      (expiresAt as number) <= (issuedAt as number) ||
      (expiresAt as number) <= nowSeconds - 30 ||
      !isCanonicalBase64Url(nonce, 32) ||
      !constantTimeStringEqual(nonce, input.transaction.nonce) ||
      typeof providerId !== 'number' ||
      !Number.isInteger(providerId) ||
      providerId < 1 ||
      providerId > MAX_PROVIDER_USER_ID ||
      (payload['at_hash'] !== undefined &&
        (typeof payload['at_hash'] !== 'string' ||
          !constantTimeStringEqual(
            payload['at_hash'],
            oidcHash(token.accessToken),
          ))) ||
      (payload['c_hash'] !== undefined &&
        (typeof payload['c_hash'] !== 'string' ||
          !constantTimeStringEqual(payload['c_hash'], oidcHash(input.code))))
    ) {
      throw new OidcLoginRejectedError()
    }
    return Object.freeze({
      issuer: TELEGRAM_OIDC_ISSUER,
      subject: payload.sub,
      providerUserId: BigInt(providerId),
    })
  }

  private mapDependency(error: unknown): never {
    if (error instanceof AuthDependencyUnavailableError) throw error
    throw new AuthDependencyUnavailableError({ cause: error })
  }
}
