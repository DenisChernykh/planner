import { AuthDependencyUnavailableError } from '@/modules/auth/application/auth-errors'
import { StartTelegramOidcLoginUseCase } from '@/modules/auth/application/start-telegram-oidc-login.use-case'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_CALLBACK_PATH,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_SCOPE,
  TELEGRAM_OIDC_TRANSACTION_TTL_MS,
  type OidcCryptoPort,
  type OidcTransaction,
  type OidcTransactionStorePort,
  type TelegramOidcFetch,
  type TelegramOidcProviderPort,
} from '@/modules/auth/application/telegram-oidc.ports'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { TelegramOidcProvider } from '@/modules/auth/infrastructure/telegram-oidc.provider'
import { OidcStateCookieAdapter } from '@/modules/auth/presentation/oidc-state-cookie.adapter'

const clientId = '123456789'
const callbackUrl = 'http://127.0.0.1:3000/auth/telegram/callback'
const state = Buffer.alloc(32, 1).toString('base64url')
const nonce = Buffer.alloc(32, 2).toString('base64url')
const verifier = Buffer.alloc(32, 3).toString('base64url')
const challenge = 'g77gcvvTQj90gfwWOCFjatjPtz-u8N0FgfOXnqDHMbk'
const nonCanonical43CharacterToken = `${'A'.repeat(42)}B`

interface OidcCryptoMock extends OidcCryptoPort {
  readonly generateOidcToken: jest.Mock<string, []>
  readonly sha256Base64Url: jest.Mock<string, [string]>
}

function transaction(
  overrides: Partial<OidcTransaction> = {},
): OidcTransaction {
  return Object.freeze({
    schema: 1,
    issuer: TELEGRAM_OIDC_ISSUER,
    clientId,
    nonce,
    codeVerifier: verifier,
    callbackUrl,
    returnTo: '/',
    ...overrides,
  })
}

function providerMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer: TELEGRAM_OIDC_ISSUER,
    authorization_endpoint: TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    token_endpoint: 'https://oauth.telegram.org/token',
    jwks_uri: 'https://oauth.telegram.org/.well-known/jwks.json',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'phone', 'telegram:bot_access'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  }
}

function metadataResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(providerMetadata(overrides)), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}

function metadataResponseWithExactSize(size: number): Response {
  const metadata = providerMetadata({ padding: '' })
  const emptyBody = JSON.stringify(metadata)
  const paddingSize = size - Buffer.byteLength(emptyBody)
  if (paddingSize < 0) throw new Error('metadata fixture exceeds target size')

  const body = JSON.stringify(
    providerMetadata({ padding: 'x'.repeat(paddingSize) }),
  )
  expect(Buffer.byteLength(body)).toBe(size)

  return new Response(body, {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })
}

function createStore(
  create: OidcTransactionStorePort['create'] = jest
    .fn()
    .mockResolvedValue('created'),
): OidcTransactionStorePort {
  return {
    create,
    consume: jest.fn().mockResolvedValue(undefined),
  }
}

function createCrypto(values: readonly string[]): OidcCryptoMock {
  let index = 0
  const generateOidcToken = jest.fn<string, []>(() => {
    const value = values[index]
    index += 1
    if (value === undefined) throw new Error('entropy fixture exhausted')
    return value
  })
  const sha256Base64Url = jest.fn<string, [string]>((value) =>
    new NodeAuthCryptoAdapter().sha256Base64Url(value),
  )
  return {
    generateOidcToken,
    sha256Base64Url,
  }
}

describe('A02 Telegram OIDC ceremony contract', () => {
  it('pins the public provider constants and never broadens the requested scope', () => {
    // A provider-host, callback-path, TTL or scope drift breaks the closed-login contract.
    expect({
      issuer: TELEGRAM_OIDC_ISSUER,
      discovery: TELEGRAM_OIDC_DISCOVERY_URL,
      authorization: TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
      callbackPath: TELEGRAM_OIDC_CALLBACK_PATH,
      scope: TELEGRAM_OIDC_SCOPE,
      ttlMs: TELEGRAM_OIDC_TRANSACTION_TTL_MS,
    }).toEqual({
      issuer: 'https://oauth.telegram.org',
      discovery: 'https://oauth.telegram.org/.well-known/openid-configuration',
      authorization: 'https://oauth.telegram.org/auth',
      callbackPath: '/auth/telegram/callback',
      scope: 'openid profile telegram:bot_access',
      ttlMs: 300_000,
    })
  })

  it('resolves the provider before persisting one exact transaction and returns an eight-key authorization URL', async () => {
    // Reordering provider validation after Redis or leaking an extra query key must fail.
    const order: string[] = []
    const provider: TelegramOidcProviderPort = {
      resolveAuthorizationEndpoint: jest.fn(() => {
        order.push('provider')
        return Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT)
      }),
    }
    const create = jest.fn<
      ReturnType<OidcTransactionStorePort['create']>,
      Parameters<OidcTransactionStorePort['create']>
    >((stateArgument, transactionArgument, ttlArgument) => {
      void stateArgument
      void transactionArgument
      void ttlArgument
      order.push('store')
      return Promise.resolve('created')
    })
    const useCase = new StartTelegramOidcLoginUseCase(
      provider,
      createStore(create),
      createCrypto([state, nonce, verifier]),
      { clientId, callbackUrl },
    )

    const result = await useCase.execute()
    const location = new URL(result.authorizationUrl)

    expect(order).toEqual(['provider', 'store'])
    expect(result.state).toBe(state)
    expect(location.origin + location.pathname).toBe(
      TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    )
    expect([...location.searchParams.keys()].sort()).toEqual(
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'nonce',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ].sort(),
    )
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid profile telegram:bot_access',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    expect(location.searchParams.has('phone')).toBe(false)
    expect(location.search).not.toContain(verifier)
    expect(create).toHaveBeenCalledWith(
      state,
      transaction(),
      TELEGRAM_OIDC_TRANSACTION_TTL_MS,
    )
  })

  it('regenerates the full entropy tuple for duplicate values and Redis collisions while resolving metadata once', async () => {
    // Reusing nonce/verifier or retrying provider discovery during NX collision must fail.
    const duplicate = Buffer.alloc(32, 4).toString('base64url')
    const collisionState = Buffer.alloc(32, 5).toString('base64url')
    const collisionNonce = Buffer.alloc(32, 6).toString('base64url')
    const collisionVerifier = Buffer.alloc(32, 7).toString('base64url')
    const finalState = Buffer.alloc(32, 8).toString('base64url')
    const finalNonce = Buffer.alloc(32, 9).toString('base64url')
    const finalVerifier = Buffer.alloc(32, 10).toString('base64url')
    const resolve = jest
      .fn<
        ReturnType<TelegramOidcProviderPort['resolveAuthorizationEndpoint']>,
        Parameters<TelegramOidcProviderPort['resolveAuthorizationEndpoint']>
      >()
      .mockResolvedValue(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT)
    const create = jest
      .fn<
        ReturnType<OidcTransactionStorePort['create']>,
        Parameters<OidcTransactionStorePort['create']>
      >()
      .mockResolvedValueOnce('collision')
      .mockResolvedValueOnce('created')
    const crypto = createCrypto([
      duplicate,
      duplicate,
      Buffer.alloc(32, 11).toString('base64url'),
      collisionState,
      collisionNonce,
      collisionVerifier,
      finalState,
      finalNonce,
      finalVerifier,
    ])
    const useCase = new StartTelegramOidcLoginUseCase(
      { resolveAuthorizationEndpoint: resolve },
      createStore(create),
      crypto,
      { clientId, callbackUrl },
    )

    await expect(useCase.execute()).resolves.toMatchObject({
      state: finalState,
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(crypto.generateOidcToken).toHaveBeenCalledTimes(9)
    expect(create).toHaveBeenNthCalledWith(
      1,
      collisionState,
      transaction({ nonce: collisionNonce, codeVerifier: collisionVerifier }),
      300_000,
    )
    expect(create).toHaveBeenNthCalledWith(
      2,
      finalState,
      transaction({ nonce: finalNonce, codeVerifier: finalVerifier }),
      300_000,
    )
  })

  it.each([
    ['state equals nonce', [state, state, verifier]],
    ['state equals verifier', [state, nonce, state]],
    ['nonce equals verifier', [state, nonce, nonce]],
  ] as const)(
    'redraws all three values when %s',
    async (_name, duplicateTuple) => {
      const finalState = Buffer.alloc(32, 12).toString('base64url')
      const finalNonce = Buffer.alloc(32, 13).toString('base64url')
      const finalVerifier = Buffer.alloc(32, 14).toString('base64url')
      const create = jest
        .fn<
          ReturnType<OidcTransactionStorePort['create']>,
          Parameters<OidcTransactionStorePort['create']>
        >()
        .mockResolvedValue('created')
      const crypto = createCrypto([
        ...duplicateTuple,
        finalState,
        finalNonce,
        finalVerifier,
      ])
      const useCase = new StartTelegramOidcLoginUseCase(
        {
          resolveAuthorizationEndpoint: () =>
            Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT),
        },
        createStore(create),
        crypto,
        { clientId, callbackUrl },
      )

      await expect(useCase.execute()).resolves.toMatchObject({
        state: finalState,
      })
      expect(crypto.generateOidcToken).toHaveBeenCalledTimes(6)
      expect(create).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledWith(
        finalState,
        transaction({ nonce: finalNonce, codeVerifier: finalVerifier }),
        300_000,
      )
    },
  )

  it('rejects a decode/re-encode non-canonical 43-character token without writing a transaction', async () => {
    const create = jest.fn<
      ReturnType<OidcTransactionStorePort['create']>,
      Parameters<OidcTransactionStorePort['create']>
    >()
    const crypto = createCrypto([
      nonCanonical43CharacterToken,
      nonce,
      verifier,
      nonCanonical43CharacterToken,
      Buffer.alloc(32, 15).toString('base64url'),
      Buffer.alloc(32, 16).toString('base64url'),
      nonCanonical43CharacterToken,
      Buffer.alloc(32, 17).toString('base64url'),
      Buffer.alloc(32, 18).toString('base64url'),
    ])
    const useCase = new StartTelegramOidcLoginUseCase(
      {
        resolveAuthorizationEndpoint: () =>
          Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT),
      },
      createStore(create),
      crypto,
      { clientId, callbackUrl },
    )

    await expect(useCase.execute()).rejects.toBeInstanceOf(
      AuthDependencyUnavailableError,
    )
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    [
      'throws',
      (): never => {
        throw new Error('private PKCE failure')
      },
    ],
    ['returns a non-canonical challenge', (): string => 'not-canonical'],
  ] as const)(
    'derives and validates the complete authorization URL before Redis when PKCE %s',
    async (_name, deriveChallenge) => {
      const create = jest.fn<
        ReturnType<OidcTransactionStorePort['create']>,
        Parameters<OidcTransactionStorePort['create']>
      >()
      const crypto = createCrypto([state, nonce, verifier])
      crypto.sha256Base64Url.mockImplementation(deriveChallenge)
      const useCase = new StartTelegramOidcLoginUseCase(
        {
          resolveAuthorizationEndpoint: () =>
            Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT),
        },
        createStore(create),
        crypto,
        { clientId, callbackUrl },
      )

      await expect(useCase.execute()).rejects.toMatchObject({
        name: 'AuthDependencyUnavailableError',
        message: 'Authentication dependency unavailable',
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('fails closed after three complete tuple attempts and does not accept a malicious provider endpoint', async () => {
    // A fourth Redis attempt or redirect to an adapter-supplied foreign host must fail.
    const values = Array.from({ length: 9 }, (_, index) =>
      Buffer.alloc(32, index + 20).toString('base64url'),
    )
    const create = jest
      .fn<
        ReturnType<OidcTransactionStorePort['create']>,
        Parameters<OidcTransactionStorePort['create']>
      >()
      .mockResolvedValue('collision')
    const collided = new StartTelegramOidcLoginUseCase(
      {
        resolveAuthorizationEndpoint: () =>
          Promise.resolve(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT),
      },
      createStore(create),
      createCrypto(values),
      { clientId, callbackUrl },
    )

    await expect(collided.execute()).rejects.toBeInstanceOf(
      AuthDependencyUnavailableError,
    )
    expect(create).toHaveBeenCalledTimes(3)

    const foreignCreate = jest.fn<
      ReturnType<OidcTransactionStorePort['create']>,
      Parameters<OidcTransactionStorePort['create']>
    >()
    const foreign = new StartTelegramOidcLoginUseCase(
      {
        resolveAuthorizationEndpoint: () =>
          Promise.resolve('https://evil.example/auth'),
      },
      createStore(foreignCreate),
      createCrypto([state, nonce, verifier]),
      { clientId, callbackUrl },
    )
    await expect(foreign.execute()).rejects.toBeInstanceOf(
      AuthDependencyUnavailableError,
    )
    expect(foreignCreate).not.toHaveBeenCalled()
  })

  it('uses the RFC 7636 S256 vector and produces canonical independent 32-byte values', () => {
    // Hashing decoded bytes, retaining padding or drawing fewer bytes must fail.
    const requestedSizes: number[] = []
    let draw = 36
    const crypto = new NodeAuthCryptoAdapter((size) => {
      requestedSizes.push(size)
      draw += 1
      return Buffer.alloc(size, draw)
    })
    const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

    expect(crypto.sha256Base64Url(rfcVerifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
    const values = [
      crypto.generateOidcToken(),
      crypto.generateOidcToken(),
      crypto.generateOidcToken(),
    ]
    expect(requestedSizes).toEqual([32, 32, 32])
    expect(values).toEqual([
      Buffer.alloc(32, 37).toString('base64url'),
      Buffer.alloc(32, 38).toString('base64url'),
      Buffer.alloc(32, 39).toString('base64url'),
    ])
    expect(new Set(values).size).toBe(3)
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    }
  })

  it('fetches only fixed redirect-free bounded discovery and accepts required metadata independent of phone', async () => {
    // Following redirects, trusting discovered endpoints or requiring phone must fail.
    const fetcher = jest
      .fn<ReturnType<TelegramOidcFetch>, Parameters<TelegramOidcFetch>>()
      .mockResolvedValue(metadataResponse())
    const provider = new TelegramOidcProvider(fetcher)

    await expect(provider.resolveAuthorizationEndpoint()).resolves.toBe(
      TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      TELEGRAM_OIDC_DISCOVERY_URL,
      expect.objectContaining({ redirect: 'error' }),
    )
    const init = fetcher.mock.calls[0]?.[1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['foreign issuer', { issuer: 'https://evil.example' }],
    [
      'foreign authorization endpoint',
      { authorization_endpoint: 'https://evil.example/auth' },
    ],
    ['missing code response', { response_types_supported: ['token'] }],
    ['missing S256', { code_challenge_methods_supported: ['plain'] }],
    [
      'missing openid',
      { scopes_supported: ['profile', 'telegram:bot_access'] },
    ],
    [
      'missing profile',
      { scopes_supported: ['openid', 'telegram:bot_access'] },
    ],
    ['missing bot access', { scopes_supported: ['openid', 'profile'] }],
  ])(
    'rejects %s metadata before any transaction write',
    async (_name, overrides) => {
      // Relaxing any pinned provider capability must fail this table.
      const provider = new TelegramOidcProvider(
        jest
          .fn<ReturnType<TelegramOidcFetch>, Parameters<TelegramOidcFetch>>()
          .mockResolvedValue(metadataResponse(overrides)),
      )
      const create = jest.fn<
        ReturnType<OidcTransactionStorePort['create']>,
        Parameters<OidcTransactionStorePort['create']>
      >()
      const useCase = new StartTelegramOidcLoginUseCase(
        provider,
        createStore(create),
        createCrypto([state, nonce, verifier]),
        { clientId, callbackUrl },
      )

      await expect(useCase.execute()).rejects.toMatchObject({
        name: 'AuthDependencyUnavailableError',
        message: 'Authentication dependency unavailable',
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('aborts discovery at two seconds and rejects a body above 16 KiB without exposing provider detail', async () => {
    // Removing either network bound or surfacing provider text must fail.
    jest.useFakeTimers()
    try {
      const hangingFetch: TelegramOidcFetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('provider marker must stay private')),
            { once: true },
          )
        })
      const pending = new TelegramOidcProvider(
        hangingFetch,
      ).resolveAuthorizationEndpoint()
      await jest.advanceTimersByTimeAsync(1_999)
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await Promise.resolve()
      expect(settled).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      await expect(pending).rejects.toMatchObject({
        name: 'AuthDependencyUnavailableError',
        message: 'Authentication dependency unavailable',
      })
    } finally {
      jest.useRealTimers()
    }

    const oversized = new TelegramOidcProvider(
      jest
        .fn<ReturnType<TelegramOidcFetch>, Parameters<TelegramOidcFetch>>()
        .mockResolvedValue(
          new Response('x'.repeat(16_385), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        ),
    )
    await expect(
      oversized.resolveAuthorizationEndpoint(),
    ).rejects.toMatchObject({
      name: 'AuthDependencyUnavailableError',
      message: 'Authentication dependency unavailable',
    })
  })

  it('accepts an otherwise valid discovery body at the inclusive 16 KiB limit', async () => {
    const provider = new TelegramOidcProvider(
      jest
        .fn<ReturnType<TelegramOidcFetch>, Parameters<TelegramOidcFetch>>()
        .mockResolvedValue(metadataResponseWithExactSize(16_384)),
    )

    await expect(provider.resolveAuthorizationEndpoint()).resolves.toBe(
      TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    )
  })

  it('sets, reads and clears only the browser-binding cookie with environment-specific host controls', () => {
    // Dropping HttpOnly/Lax/host-only controls or accepting duplicate state cookies must fail.
    const response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    }
    const development = new OidcStateCookieAdapter(false)
    development.set(response as never, state)
    expect(response.cookie).toHaveBeenCalledWith('planner-oidc-state', state, {
      httpOnly: true,
      maxAge: 300_000,
      path: '/',
      sameSite: 'lax',
      secure: false,
    })
    expect(development.read(`other=x; planner-oidc-state=${state}`)).toBe(state)
    expect(
      development.read(
        `planner-oidc-state=${state}; planner-oidc-state=${state}`,
      ),
    ).toBeUndefined()
    expect(development.matches(`planner-oidc-state=${state}`, state)).toBe(true)
    expect(
      development.matches(
        `planner-oidc-state=${state}`,
        Buffer.alloc(32, 99).toString('base64url'),
      ),
    ).toBe(false)

    const production = new OidcStateCookieAdapter(true)
    production.set(response as never, state)
    expect(production.read(`__Host-planner-oidc-state=${state}`)).toBe(state)
    expect(
      production.matches(`__Host-planner-oidc-state=${state}`, state),
    ).toBe(true)
    expect(
      production.matches(
        `__Host-planner-oidc-state=${state}`,
        Buffer.alloc(32, 99).toString('base64url'),
      ),
    ).toBe(false)
    expect(response.clearCookie).not.toHaveBeenCalled()
    production.clear(response as never)
    expect(response.cookie).toHaveBeenLastCalledWith(
      '__Host-planner-oidc-state',
      state,
      {
        httpOnly: true,
        maxAge: 300_000,
        path: '/',
        sameSite: 'lax',
        secure: true,
      },
    )
    expect(response.clearCookie).toHaveBeenCalledWith(
      '__Host-planner-oidc-state',
      {
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: true,
      },
    )
  })
})
