import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import {
  AuthenticationRequiredError,
  OidcAccessDeniedError,
  OidcCallbackValidationError,
  OidcLoginRejectedError,
} from '@/modules/auth/application/auth-errors'
import {
  CompleteTelegramOidcLoginUseCase,
  type LocalSessionIssuerPort,
  type TelegramOidcCallbackCandidate,
} from '@/modules/auth/application/complete-telegram-oidc-login.use-case'
import type { TelegramIdentityBindingPort } from '@/modules/auth/application/telegram-identity-binding.port'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URL,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
  type OidcTransaction,
  type OidcTransactionStorePort,
  type TelegramOidcFetch,
  type TelegramOidcProviderPort,
  type VerifiedTelegramOidcIdentity,
} from '@/modules/auth/application/telegram-oidc.ports'
import { AuthDependencyUnavailableError } from '@/modules/auth/application/auth-errors'
import type { IssuedBrowserSession } from '@/modules/auth/application/session-store.port'
import { TelegramOidcProvider } from '@/modules/auth/infrastructure/telegram-oidc.provider'

const clientId = '123456789'
const clientSecret = 'telegram-client-secret-for-tests'
const callbackUrl = 'http://127.0.0.1:3000/auth/telegram/callback'
const state = Buffer.alloc(32, 41).toString('base64url')
const nonce = Buffer.alloc(32, 42).toString('base64url')
const verifier = Buffer.alloc(32, 43).toString('base64url')
const code = 'telegram-visible-code'
const accessToken = 'telegram-access-token-for-contract'
const nowMs = Date.UTC(2026, 7, 11, 8, 0, 0)
const nowSeconds = Math.floor(nowMs / 1_000)
const providerUserId = 4_503_599_627_370_495
const userId = '11111111-1111-4111-8111-111111111111'

const oidcTransaction: OidcTransaction = Object.freeze({
  schema: 1,
  issuer: TELEGRAM_OIDC_ISSUER,
  clientId,
  nonce,
  codeVerifier: verifier,
  callbackUrl,
  returnTo: '/',
})

const verifiedIdentity: VerifiedTelegramOidcIdentity = Object.freeze({
  issuer: TELEGRAM_OIDC_ISSUER,
  subject: 'opaque-Telegram-subject',
  providerUserId: BigInt(providerUserId),
})

const issuedSession: IssuedBrowserSession = Object.freeze({
  rawToken: Buffer.alloc(32, 44).toString('base64url'),
  sessionId: Buffer.alloc(16, 45).toString('base64url'),
  csrfToken: Buffer.alloc(32, 46).toString('base64url'),
  absoluteExpiresAt: new Date(nowMs + 60_000),
})

function successCandidate(value = code): TelegramOidcCallbackCandidate {
  return Object.freeze({ kind: 'success', code: value })
}

function createUseCase(
  overrides: {
    readonly consume?: OidcTransactionStorePort['consume']
    readonly verify?: TelegramOidcProviderPort['verifyAuthorizationCode']
    readonly bind?: TelegramIdentityBindingPort['bindVerifiedIdentity']
    readonly issue?: LocalSessionIssuerPort['execute']
  } = {},
): {
  readonly useCase: CompleteTelegramOidcLoginUseCase
  readonly consume: jest.MockedFunction<OidcTransactionStorePort['consume']>
  readonly verify: jest.MockedFunction<
    TelegramOidcProviderPort['verifyAuthorizationCode']
  >
  readonly bind: jest.MockedFunction<
    TelegramIdentityBindingPort['bindVerifiedIdentity']
  >
  readonly issue: jest.MockedFunction<LocalSessionIssuerPort['execute']>
} {
  const consume = jest
    .fn<
      ReturnType<OidcTransactionStorePort['consume']>,
      Parameters<OidcTransactionStorePort['consume']>
    >()
    .mockImplementation(
      overrides.consume ?? (() => Promise.resolve(oidcTransaction)),
    )
  const verify = jest
    .fn<
      ReturnType<TelegramOidcProviderPort['verifyAuthorizationCode']>,
      Parameters<TelegramOidcProviderPort['verifyAuthorizationCode']>
    >()
    .mockImplementation(
      overrides.verify ?? (() => Promise.resolve(verifiedIdentity)),
    )
  const bind = jest
    .fn<
      ReturnType<TelegramIdentityBindingPort['bindVerifiedIdentity']>,
      Parameters<TelegramIdentityBindingPort['bindVerifiedIdentity']>
    >()
    .mockImplementation(overrides.bind ?? (() => Promise.resolve(userId)))
  const issue = jest
    .fn<
      ReturnType<LocalSessionIssuerPort['execute']>,
      Parameters<LocalSessionIssuerPort['execute']>
    >()
    .mockImplementation(
      overrides.issue ?? (() => Promise.resolve(issuedSession)),
    )

  return {
    consume,
    verify,
    bind,
    issue,
    useCase: new CompleteTelegramOidcLoginUseCase(
      { create: jest.fn(), consume },
      {
        resolveAuthorizationEndpoint: () =>
          Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT),
        verifyAuthorizationCode: verify,
      },
      { bindVerifiedIdentity: bind },
      { execute: issue },
    ),
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function oidcHash(value: string): string {
  return createHash('sha256')
    .update(value, 'ascii')
    .digest()
    .subarray(0, 16)
    .toString('base64url')
}

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 })
const publicJwk = keyPair.publicKey.export({ format: 'jwk' })
const privateJwk = keyPair.privateKey.export({ format: 'jwk' })
const weakPublicJwk = generateKeyPairSync('rsa', {
  modulusLength: 1_024,
}).publicKey.export({ format: 'jwk' })
const kid = 'telegram-contract-key'

function idToken(
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = base64UrlJson({
    alg: 'RS256',
    kid,
    typ: 'JWT',
    ...headerOverrides,
  })
  const payload = base64UrlJson({
    iss: TELEGRAM_OIDC_ISSUER,
    aud: clientId,
    sub: 'opaque-Telegram-subject',
    iat: nowSeconds,
    exp: nowSeconds + 300,
    nonce,
    id: providerUserId,
    at_hash: oidcHash(accessToken),
    c_hash: oidcHash(code),
    name: 'must-not-be-projected',
    preferred_username: 'must_not_link',
    phone_number: '+000000000',
    ...claimOverrides,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), {
    key: keyPair.privateKey,
  }).toString('base64url')
  return `${signingInput}.${signature}`
}

function discoveryMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer: TELEGRAM_OIDC_ISSUER,
    authorization_endpoint: TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    token_endpoint: TELEGRAM_OIDC_TOKEN_ENDPOINT,
    jwks_uri: TELEGRAM_OIDC_JWKS_URL,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'telegram:bot_access'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function exactJsonResponse(
  body: Record<string, unknown>,
  bytes: number,
  status = 200,
): Response {
  const empty = JSON.stringify({ ...body, padding: '' })
  const padding = bytes - Buffer.byteLength(empty, 'utf8')
  if (padding < 0) throw new Error('JSON fixture exceeds requested size')
  const serialized = JSON.stringify({ ...body, padding: 'x'.repeat(padding) })
  if (Buffer.byteLength(serialized, 'utf8') !== bytes) {
    throw new Error('JSON fixture size mismatch')
  }
  return new Response(serialized, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function providerFixture(
  options: {
    readonly claims?: Record<string, unknown>
    readonly header?: Record<string, unknown>
    readonly tokenResponse?: Record<string, unknown>
    readonly tokenStatus?: number
    readonly discovery?: Record<string, unknown>
    readonly jwks?: Record<string, unknown>
    readonly configuredClientSecret?: string
    readonly discoveryResponse?: Response
    readonly tokenRawResponse?: Response
    readonly jwksResponse?: Response
  } = {},
): {
  readonly provider: TelegramOidcProvider
  readonly fetcher: jest.MockedFunction<TelegramOidcFetch>
} {
  const token = idToken(options.claims, options.header)
  const fetcher = jest
    .fn<ReturnType<TelegramOidcFetch>, Parameters<TelegramOidcFetch>>()
    .mockImplementation((input) => {
      if (input === TELEGRAM_OIDC_DISCOVERY_URL) {
        if (options.discoveryResponse !== undefined) {
          return Promise.resolve(options.discoveryResponse)
        }
        return Promise.resolve(
          jsonResponse(discoveryMetadata(options.discovery)),
        )
      }
      if (input === TELEGRAM_OIDC_TOKEN_ENDPOINT) {
        if (options.tokenRawResponse !== undefined) {
          return Promise.resolve(options.tokenRawResponse)
        }
        return Promise.resolve(
          jsonResponse(
            options.tokenResponse ?? {
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 300,
              id_token: token,
            },
            options.tokenStatus ?? 200,
          ),
        )
      }
      if (input === TELEGRAM_OIDC_JWKS_URL) {
        if (options.jwksResponse !== undefined) {
          return Promise.resolve(options.jwksResponse)
        }
        return Promise.resolve(
          jsonResponse(
            options.jwks ?? {
              keys: [
                {
                  ...publicJwk,
                  kid,
                  alg: 'RS256',
                  use: 'sig',
                  key_ops: ['verify'],
                },
              ],
            },
          ),
        )
      }
      return Promise.reject(new Error('unexpected provider URL'))
    })
  return {
    fetcher,
    provider: new TelegramOidcProvider(fetcher, {
      timeoutMs: 2_000,
      bodyLimitBytes: 16_384,
      clientId,
      clientSecret: options.configuredClientSecret ?? clientSecret,
      callbackUrl,
    }),
  }
}

describe('A03 complete Telegram OIDC application contract', () => {
  it('consumes before provider, commits binding before session and passes one now value', async () => {
    const order: string[] = []
    const stack = createUseCase({
      consume: () => {
        order.push('consume')
        return Promise.resolve(oidcTransaction)
      },
      verify: () => {
        order.push('provider')
        return Promise.resolve(verifiedIdentity)
      },
      bind: () => {
        order.push('binder')
        return Promise.resolve(userId)
      },
      issue: () => {
        order.push('session')
        return Promise.resolve(issuedSession)
      },
    })
    const classify = jest.fn(() => {
      order.push('classify')
      return successCandidate()
    })

    await expect(
      stack.useCase.execute(state, classify, nowMs),
    ).resolves.toEqual({ session: issuedSession, returnTo: '/' })
    expect(order).toEqual([
      'consume',
      'classify',
      'provider',
      'binder',
      'session',
    ])
    expect(classify).toHaveBeenCalledTimes(1)
    expect(stack.consume).toHaveBeenCalledTimes(1)
    expect(stack.consume).toHaveBeenCalledWith(state)
    expect(stack.verify).toHaveBeenCalledWith({
      code,
      transaction: oidcTransaction,
      nowMs,
    })
    expect(stack.bind).toHaveBeenCalledWith(verifiedIdentity)
    expect(stack.issue).toHaveBeenCalledWith(userId, nowMs)
  })

  it.each([
    ['invalid', Object.freeze({ kind: 'invalid' })],
    ['OAuth error', Object.freeze({ kind: 'oauth-error' })],
  ] as const)(
    'consumes before rejecting a matched %s candidate',
    async (_name, candidate) => {
      const stack = createUseCase()

      const expected =
        candidate.kind === 'invalid'
          ? OidcCallbackValidationError
          : OidcLoginRejectedError
      await expect(
        stack.useCase.execute(state, () => candidate, nowMs),
      ).rejects.toBeInstanceOf(expected)
      expect(stack.consume).toHaveBeenCalledTimes(1)
      expect(stack.verify).not.toHaveBeenCalled()
      expect(stack.bind).not.toHaveBeenCalled()
      expect(stack.issue).not.toHaveBeenCalled()
    },
  )

  it('rejects missing/replayed transaction after one consume and performs no downstream I/O', async () => {
    const stack = createUseCase({ consume: () => Promise.resolve(undefined) })
    const classify = jest.fn(successCandidate)

    await expect(
      stack.useCase.execute(state, classify, nowMs),
    ).rejects.toBeInstanceOf(OidcLoginRejectedError)
    expect(stack.consume).toHaveBeenCalledTimes(1)
    expect(classify).not.toHaveBeenCalled()
    expect(stack.verify).not.toHaveBeenCalled()
    expect(stack.bind).not.toHaveBeenCalled()
    expect(stack.issue).not.toHaveBeenCalled()
  })

  it.each([
    ['provider rejection', 'verify', new OidcLoginRejectedError()],
    ['identity denial', 'bind', new OidcAccessDeniedError()],
    ['dependency outage', 'verify', new AuthDependencyUnavailableError()],
  ] as const)(
    'preserves typed %s and never reaches later effects',
    async (_name, failingStep, error) => {
      const stack = createUseCase({
        ...(failingStep === 'verify'
          ? { verify: () => Promise.reject(error) }
          : { bind: () => Promise.reject(error) }),
      })

      await expect(
        stack.useCase.execute(state, successCandidate, nowMs),
      ).rejects.toBe(error)
      if (failingStep === 'verify') expect(stack.bind).not.toHaveBeenCalled()
      expect(stack.issue).not.toHaveBeenCalled()
    },
  )

  it('does not attempt to compensate a committed binding when session issuance fails', async () => {
    const sessionFailure = new AuthDependencyUnavailableError()
    const stack = createUseCase({
      issue: () => Promise.reject(sessionFailure),
    })

    await expect(
      stack.useCase.execute(state, successCandidate, nowMs),
    ).rejects.toBe(sessionFailure)
    expect(stack.bind).toHaveBeenCalledTimes(1)
    expect(stack.issue).toHaveBeenCalledTimes(1)
  })

  it('maps an impossible missing bound User at session issuance to dependency failure', async () => {
    const invariantFailure = new AuthenticationRequiredError()
    const stack = createUseCase({
      issue: () => Promise.reject(invariantFailure),
    })

    await expect(
      stack.useCase.execute(state, successCandidate, nowMs),
    ).rejects.toMatchObject({
      name: 'AuthDependencyUnavailableError',
      code: 'AUTH_DEPENDENCY_UNAVAILABLE',
      cause: invariantFailure,
    })
    expect(stack.bind).toHaveBeenCalledTimes(1)
    expect(stack.issue).toHaveBeenCalledTimes(1)
  })
})

describe('A03 Telegram provider callback contract', () => {
  it('preserves an opaque client secret including surrounding spaces in Basic auth', async () => {
    const configuredClientSecret = '  opaque secret kept exactly  '
    const { provider, fetcher } = providerFixture({ configuredClientSecret })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).resolves.toEqual(verifiedIdentity)
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(`${clientId}:${configuredClientSecret}`, 'utf8').toString('base64')}`,
    })
  })

  it('pins callback provider constants and performs exact discovery, token and JWKS requests once', async () => {
    const { provider, fetcher } = providerFixture()

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).resolves.toEqual(verifiedIdentity)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      TELEGRAM_OIDC_DISCOVERY_URL,
      TELEGRAM_OIDC_TOKEN_ENDPOINT,
      TELEGRAM_OIDC_JWKS_URL,
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    const tokenInit = fetcher.mock.calls[1]?.[1]
    expect(tokenInit?.method).toBe('POST')
    expect(tokenInit?.headers).toMatchObject({
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(tokenInit?.body).toBeInstanceOf(URLSearchParams)
    const form = tokenInit?.body as URLSearchParams
    expect([...form.keys()]).toEqual([
      'grant_type',
      'code',
      'redirect_uri',
      'client_id',
      'code_verifier',
    ])
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: clientId,
      code_verifier: verifier,
    })
  })

  it('maps only token invalid_grant to login rejection and skips JWKS', async () => {
    const { provider, fetcher } = providerFixture({
      tokenStatus: 400,
      tokenResponse: { error: 'invalid_grant', error_description: code },
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).rejects.toBeInstanceOf(OidcLoginRejectedError)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      TELEGRAM_OIDC_DISCOVERY_URL,
      TELEGRAM_OIDC_TOKEN_ENDPOINT,
    ])
  })

  it.each([
    ['wrong issuer', { iss: 'https://evil.invalid' }],
    ['array audience', { aud: [clientId] }],
    ['wrong audience', { aud: '987654321' }],
    ['wrong azp', { azp: '987654321' }],
    ['missing subject', { sub: undefined }],
    ['control subject', { sub: 'opaque\u0000subject' }],
    ['malformed Unicode subject', { sub: '\ud800' }],
    ['old iat', { iat: nowSeconds - 331 }],
    ['future iat', { iat: nowSeconds + 31 }],
    ['unsafe integer iat', { iat: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe integer exp', { exp: Number.MAX_SAFE_INTEGER + 1 }],
    ['exp before iat', { exp: nowSeconds }],
    ['wrong nonce', { nonce: Buffer.alloc(32, 99).toString('base64url') }],
    ['zero provider ID', { id: 0 }],
    ['fraction provider ID', { id: 1.5 }],
    ['string provider ID', { id: String(providerUserId) }],
    ['provider ID at 2^52', { id: 2 ** 52 }],
    ['wrong at_hash', { at_hash: 'wrong' }],
    ['wrong c_hash', { c_hash: 'wrong' }],
  ])(
    'rejects invalid %s claims without returning provider payload',
    async (_name, claims) => {
      const { provider } = providerFixture({ claims })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toMatchObject({
        name: 'OidcLoginRejectedError',
        message: 'Telegram login rejected',
      })
    },
  )

  it('rejects a non-ASCII access token before fetching JWKS', async () => {
    const { provider, fetcher } = providerFixture({
      tokenResponse: {
        access_token: 'telegram-access-token-é',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken({ at_hash: undefined }),
      },
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      TELEGRAM_OIDC_DISCOVERY_URL,
      TELEGRAM_OIDC_TOKEN_ENDPOINT,
    ])
  })

  it('accepts exact provider ID and time boundaries and ignores profile claims', async () => {
    const { provider } = providerFixture({
      claims: {
        iat: nowSeconds - 330,
        exp: nowSeconds + 1,
        id: 2 ** 52 - 1,
        name: { malicious: true },
        preferred_username: ['malicious'],
        phone_number: { malicious: true },
      },
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).resolves.toEqual({
      issuer: TELEGRAM_OIDC_ISSUER,
      subject: 'opaque-Telegram-subject',
      providerUserId: BigInt(2 ** 52 - 1),
    })
  })

  it.each([
    ['none alg', { alg: 'none' }],
    ['wrong alg', { alg: 'ES256' }],
    ['missing kid', { kid: undefined }],
    ['remote jku', { jku: 'https://evil.invalid/jwks' }],
    ['embedded jwk', { jwk: publicJwk }],
    ['x5u', { x5u: 'https://evil.invalid/key' }],
    ['x5c', { x5c: ['private'] }],
    ['crit', { crit: ['exp'] }],
    ['unencoded payload', { b64: false }],
    ['wrong typ', { typ: 'application/jwt' }],
  ])(
    'rejects protected header with %s before identity projection',
    async (_name, header) => {
      const { provider } = providerFixture({ header })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toBeInstanceOf(OidcLoginRejectedError)
    },
  )

  it('accepts an inclusive 16384-byte discovery document', async () => {
    const { provider } = providerFixture({
      discoveryResponse: exactJsonResponse(discoveryMetadata(), 16_384),
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).resolves.toEqual(verifiedIdentity)
  })

  it.each([
    ['16385-byte discovery', exactJsonResponse(discoveryMetadata(), 16_385)],
    [
      'wrong discovery media type',
      new Response(JSON.stringify(discoveryMetadata()), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'malformed discovery JSON',
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    ['non-200 discovery status', jsonResponse(discoveryMetadata(), 500)],
  ])('fails closed for %s without retry', async (_name, discoveryResponse) => {
    const { provider, fetcher } = providerFixture({ discoveryResponse })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid_client', jsonResponse({ error: 'invalid_client' }, 400)],
    ['non-200 status', jsonResponse({ error: 'server_error' }, 500)],
    [
      'wrong media type',
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'malformed JSON',
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'oversized body',
      exactJsonResponse(
        {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken(),
        },
        16_385,
      ),
    ],
    [
      'empty access token',
      jsonResponse({
        access_token: '',
        token_type: 'Bearer',
        id_token: idToken(),
      }),
    ],
    [
      'wrong token type',
      jsonResponse({
        access_token: accessToken,
        token_type: 'bearer',
        id_token: idToken(),
      }),
    ],
    [
      'nonpositive expires_in',
      jsonResponse({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 0,
        id_token: idToken(),
      }),
    ],
    [
      'noncompact id_token',
      jsonResponse({
        access_token: accessToken,
        token_type: 'Bearer',
        id_token: 'not-compact',
      }),
    ],
  ])(
    'maps token response %s to dependency failure without JWKS',
    async (_name, tokenRawResponse) => {
      const { provider, fetcher } = providerFixture({ tokenRawResponse })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it('maps a valid-key invalid signature to login rejection', async () => {
    const signed = idToken()
    const [header, payload, encodedSignature] = signed.split('.')
    if (
      header === undefined ||
      payload === undefined ||
      encodedSignature === undefined
    ) {
      throw new Error('invalid signed-token fixture')
    }
    const signature = Buffer.from(encodedSignature, 'base64url')
    const first = signature[0]
    if (first === undefined) throw new Error('empty signature fixture')
    signature[0] = first ^ 1
    const corrupted = `${header}.${payload}.${signature.toString('base64url')}`
    const { provider } = providerFixture({
      tokenResponse: {
        access_token: accessToken,
        token_type: 'Bearer',
        id_token: corrupted,
      },
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).rejects.toBeInstanceOf(OidcLoginRejectedError)
  })

  it('accepts exact azp and omitted optional token hashes', async () => {
    const { provider } = providerFixture({
      claims: { azp: clientId, at_hash: undefined, c_hash: undefined },
    })

    await expect(
      provider.verifyAuthorizationCode({
        code,
        transaction: oidcTransaction,
        nowMs,
      }),
    ).resolves.toEqual(verifiedIdentity)
  })

  it.each([
    [
      '17 keys',
      {
        keys: Array.from({ length: 17 }, (_value, index) => ({
          kid: `other-${index}`,
          alg: 'RS256',
        })),
      },
    ],
    [
      'duplicate kid and alg',
      {
        keys: [
          { ...publicJwk, kid, alg: 'RS256' },
          { ...publicJwk, kid, alg: 'RS256' },
        ],
      },
    ],
    ['wrong kid', { keys: [{ ...publicJwk, kid: 'other', alg: 'RS256' }] }],
    ['weak modulus', { keys: [{ ...weakPublicJwk, kid, alg: 'RS256' }] }],
    ['private material', { keys: [{ ...privateJwk, kid, alg: 'RS256' }] }],
    ['wrong use', { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'enc' }] }],
  ])(
    'maps malformed JWKS with %s to dependency failure',
    async (_name, jwks) => {
      const { provider } = providerFixture({ jwks })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    },
  )

  it.each([
    [
      'foreign token endpoint',
      { token_endpoint: 'https://evil.invalid/token' },
    ],
    ['foreign JWKS', { jwks_uri: 'https://evil.invalid/jwks' }],
    [
      'missing authorization-code grant',
      { grant_types_supported: ['refresh_token'] },
    ],
    [
      'missing Basic auth',
      { token_endpoint_auth_methods_supported: ['client_secret_post'] },
    ],
    ['missing RS256', { id_token_signing_alg_values_supported: ['ES256'] }],
  ])(
    'rejects discovery with %s before token exchange',
    async (_name, discovery) => {
      const { provider, fetcher } = providerFixture({ discovery })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['invalid RSA exponent', { ...publicJwk, e: 'AA' }],
    ['non-verifying key_ops', { ...publicJwk, key_ops: ['sign'] }],
  ])(
    'maps malformed JWKS %s to dependency failure, not login rejection',
    async (_name, key) => {
      const { provider } = providerFixture({
        jwks: {
          keys: [
            {
              ...key,
              kid,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        },
      })

      await expect(
        provider.verifyAuthorizationCode({
          code,
          transaction: oidcTransaction,
          nowMs,
        }),
      ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
    },
  )
})
