import { createHash } from 'node:crypto'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { ApiModule } from '@/bootstrap/api/api.module'
import { AuthDependencyUnavailableError } from '@/modules/auth/application/auth-errors'
import {
  OIDC_TRANSACTION_STORE,
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_PROVIDER,
  type OidcTransaction,
  type OidcTransactionStorePort,
  type TelegramOidcProviderPort,
} from '@/modules/auth/application/telegram-oidc.ports'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { RequestContext } from '@/platform/http/context/request-context'
import { createOpenApiDocument } from '@/platform/http/docs/openapi-document'
import { HttpProblemRegistry } from '@/platform/http/errors/http-problem.registry'
import type { ReadinessIndicator } from '@/platform/http/health/readiness-indicator'
import {
  STRUCTURED_LOGGER,
  type StructuredLogRecord,
} from '@/platform/logging/logging.contracts'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import type { DatabaseReadinessProbe } from '@/platform/database/database.contracts'
import { DATABASE_READINESS_PROBE } from '@/platform/database/database.tokens'
import { REDIS_READINESS_INDICATOR } from '@/platform/redis/redis.tokens'

const oidcStateSecret = Buffer.alloc(32, 73).toString('base64url')

function runtimeConfig(): ApplicationRuntimeConfig {
  return buildApiRuntimeConfig({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://planner:test@127.0.0.1:1/planner',
    REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
    REDIS_KEY_PREFIX: 'planner',
    AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 71).toString('base64url'),
    AUTH_CSRF_SECRET: Buffer.alloc(32, 72).toString('base64url'),
    AUTH_OIDC_STATE_KEY_SECRET: oidcStateSecret,
    AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CLIENT_SECRET: 'start-e2e-telegram-client-secret',
    TELEGRAM_OIDC_CALLBACK_URL: 'http://127.0.0.1:3000/auth/telegram/callback',
  })
}

function sensitiveValues(
  rawState: string,
  transaction: OidcTransaction,
): readonly string[] {
  const challenge = createHash('sha256')
    .update(transaction.codeVerifier, 'ascii')
    .digest('base64url')
  const location = new URL(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT)
  location.searchParams.set('client_id', transaction.clientId)
  location.searchParams.set('redirect_uri', transaction.callbackUrl)
  location.searchParams.set('response_type', 'code')
  location.searchParams.set('scope', 'openid profile telegram:bot_access')
  location.searchParams.set('state', rawState)
  location.searchParams.set('nonce', transaction.nonce)
  location.searchParams.set('code_challenge', challenge)
  location.searchParams.set('code_challenge_method', 'S256')
  return Object.freeze([
    rawState,
    transaction.nonce,
    transaction.codeVerifier,
    challenge,
    location.toString(),
  ])
}

describe('A02 public Telegram OIDC start HTTP contract', () => {
  let app: NestExpressApplication
  let providerResolve: jest.MockedFunction<
    TelegramOidcProviderPort['resolveAuthorizationEndpoint']
  >
  let transactionCreate: jest.MockedFunction<OidcTransactionStorePort['create']>
  let redisStatus: 'up' | 'down'
  let logRecords: StructuredLogRecord[]
  const config = runtimeConfig()

  beforeAll(async () => {
    providerResolve = jest
      .fn<
        ReturnType<TelegramOidcProviderPort['resolveAuthorizationEndpoint']>,
        Parameters<TelegramOidcProviderPort['resolveAuthorizationEndpoint']>
      >()
      .mockResolvedValue(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT)
    transactionCreate = jest
      .fn<
        ReturnType<OidcTransactionStorePort['create']>,
        Parameters<OidcTransactionStorePort['create']>
      >()
      .mockResolvedValue('created')
    const database: DatabaseReadinessProbe = {
      check: jest.fn().mockResolvedValue('up'),
    }
    const redis: ReadinessIndicator = {
      timeoutMs: 100,
      check: jest.fn(() => Promise.resolve(redisStatus)),
    }
    logRecords = []
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(config)],
    })
      .overrideProvider(TELEGRAM_OIDC_PROVIDER)
      .useValue({ resolveAuthorizationEndpoint: providerResolve })
      .overrideProvider(OIDC_TRANSACTION_STORE)
      .useValue({
        create: transactionCreate,
        consume: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(DATABASE_READINESS_PROBE)
      .useValue(database)
      .overrideProvider(REDIS_READINESS_INDICATOR)
      .useValue(redis)
      .overrideProvider(STRUCTURED_LOGGER)
      .useValue({
        write: (record: StructuredLogRecord) => logRecords.push(record),
      })
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    })
    const lifecycle = app.get(ApplicationLifecycleState)
    lifecycle.markReady()
    configureHttpApplication(
      app,
      lifecycle,
      app.get(ActiveRequestTracker),
      app.get(RequestContext),
      app.get(STRUCTURED_LOGGER),
    )
    await app.init()
  })

  beforeEach(() => {
    redisStatus = 'up'
    logRecords = []
    providerResolve.mockReset()
    providerResolve.mockResolvedValue(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT)
    transactionCreate.mockReset()
    transactionCreate.mockResolvedValue('created')
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns a public bodyless 302 with exact security headers, browser binding and no session cookie', async () => {
    // Authentication-by-default, Express redirect bodies or a missing binding cookie must fail.
    const response = await request(app.getHttpServer())
      .get('/auth/telegram/start')
      .set('X-Request-ID', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
      .expect(302)
    const location = new URL(response.headers['location'] as string)
    const cookies = response.headers['set-cookie'] as unknown as
      readonly string[] | undefined

    expect(response.text).toBe('')
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-request-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
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
    expect(location.searchParams.get('scope')).toBe(
      'openid profile telegram:bot_access',
    )
    expect(location.searchParams.has('phone')).toBe(false)
    expect(cookies).toHaveLength(1)
    const cookie = cookies?.[0] ?? ''
    expect(cookie).toContain(
      `planner-oidc-state=${location.searchParams.get('state') ?? ''}`,
    )
    expect(cookie).toContain('Max-Age=300')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Domain=')
    expect(cookie).not.toContain('Secure')
    expect(cookie).not.toContain('planner-session')
    expect(providerResolve).toHaveBeenCalledTimes(1)
    expect(transactionCreate).toHaveBeenCalledTimes(1)
    const createCall = transactionCreate.mock.calls[0]
    expect(createCall).toBeDefined()
    if (createCall === undefined) throw new Error('missing transaction call')
    const [storedState, storedTransaction] = createCall
    const values = sensitiveValues(storedState, storedTransaction)
    expect(response.headers['location']).toBe(values.at(-1))
    const responseBody: unknown = response.body
    const evidence = JSON.stringify({ body: responseBody, logs: logRecords })
    for (const value of values) expect(evidence).not.toContain(value)
  })

  it('returns 422 for query and parser-accepted object, array or text bodies before provider and Redis', async () => {
    // Ignoring any parser-accepted wire body or caller-controlled returnTo must fail.
    const responses = [
      await request(app.getHttpServer())
        .get('/auth/telegram/start')
        .query({ returnTo: '/evil' }),
      await request(app.getHttpServer())
        .get('/auth/telegram/start')
        .set('Content-Type', 'application/json')
        .send({}),
      await request(app.getHttpServer())
        .get('/auth/telegram/start')
        .set('Content-Type', 'application/json')
        .send([]),
      await request(app.getHttpServer())
        .get('/auth/telegram/start')
        .set('Content-Type', 'text/plain')
        .send('wire text'),
    ]
    for (const response of responses) {
      expect(response.status).toBe(422)
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      )
      expect(response.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
      })
      expect(response.headers['location']).toBeUndefined()
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    expect(providerResolve).not.toHaveBeenCalled()
    expect(transactionCreate).not.toHaveBeenCalled()
  })

  it('leaves strict scalar and malformed JSON at the existing global 400 parser boundary', async () => {
    // Converting parser failures to the A02 422 contract would hide rejected transport.
    for (const payload of ['true', '42', '"wire text"', '{']) {
      const response = await request(app.getHttpServer())
        .get('/auth/telegram/start')
        .set('Content-Type', 'application/json')
        .send(payload)
        .expect(400)
      expect(response.body).toMatchObject({
        code: 'MALFORMED_REQUEST',
        status: 400,
      })
    }
    expect(providerResolve).not.toHaveBeenCalled()
    expect(transactionCreate).not.toHaveBeenCalled()
  })

  it('leaves a valid JSON body above one MiB at the existing global 413 parser boundary', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/telegram/start')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(1_048_577) }))
      .expect(413)
    expect(response.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    })
    expect(providerResolve).not.toHaveBeenCalled()
    expect(transactionCreate).not.toHaveBeenCalled()
  })

  it('returns a redacted 503 without redirect or cookie for provider and Redis failures', async () => {
    // Leaking error causes or setting browser state before the failing dependency must fail.
    providerResolve.mockRejectedValueOnce(
      new Error('provider-payload=private authorization=secret'),
    )
    const providerFailure = await request(app.getHttpServer())
      .get('/auth/telegram/start')
      .expect(503)
    expect(providerFailure.body).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    })
    expect(providerFailure.headers['location']).toBeUndefined()
    expect(providerFailure.headers['set-cookie']).toBeUndefined()
    expect(transactionCreate).not.toHaveBeenCalled()

    providerResolve.mockClear()
    transactionCreate.mockRejectedValueOnce(
      new AuthDependencyUnavailableError({
        cause: new Error(`redis=${oidcStateSecret}`),
      }),
    )
    const redisFailure = await request(app.getHttpServer())
      .get('/auth/telegram/start')
      .expect(503)
    expect(redisFailure.body).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    })
    expect(redisFailure.headers['location']).toBeUndefined()
    expect(redisFailure.headers['set-cookie']).toBeUndefined()
    expect(providerResolve).toHaveBeenCalledTimes(1)
    expect(transactionCreate).toHaveBeenCalledTimes(1)

    const createCall = transactionCreate.mock.calls[0]
    expect(createCall).toBeDefined()
    if (createCall === undefined) throw new Error('missing transaction call')
    const evidence = JSON.stringify({
      bodies: [providerFailure.body, redisFailure.body],
      logs: logRecords,
    })
    for (const value of sensitiveValues(createCall[0], createCall[1])) {
      expect(evidence).not.toContain(value)
    }
    expect(evidence).not.toMatch(
      /provider-payload|authorization=secret|redis=|private|oauth\.telegram\.org\/auth\?/u,
    )
    expect(evidence).not.toContain(oidcStateSecret)
  })

  it('keeps provider discovery out of readiness while auth Redis remains required', async () => {
    // Adding Telegram discovery to readiness or dropping Redis from it must fail.
    providerResolve.mockRejectedValue(new Error('provider offline'))
    await request(app.getHttpServer()).get('/health/ready').expect(200, {
      status: 'ok',
    })
    expect(providerResolve).not.toHaveBeenCalled()

    redisStatus = 'down'
    await request(app.getHttpServer()).get('/health/ready').expect(503, {
      status: 'unavailable',
    })
    expect(providerResolve).not.toHaveBeenCalled()
  })

  it('publishes exact redirect headers and only 302, 400, 413, 422 and 503 responses', () => {
    // Stale auth security or an undocumented parser/dependency response must fail.
    const document = createOpenApiDocument(
      app,
      config,
      app.get(HttpProblemRegistry).definitions,
    )
    const operation = document.paths['/auth/telegram/start']?.get
    expect(operation?.security).toEqual([])
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '302',
      '400',
      '413',
      '422',
      '503',
    ])
    const redirect = operation?.responses['302']
    expect(redirect).toBeDefined()
    if (redirect === undefined || '$ref' in redirect) {
      throw new Error('missing inline redirect response')
    }
    expect(redirect).not.toHaveProperty('content')
    expect(Object.keys(redirect.headers ?? {}).sort()).toEqual([
      'Cache-Control',
      'Location',
      'Pragma',
      'Referrer-Policy',
      'Set-Cookie',
      'X-Request-ID',
    ])
    expect(redirect.headers).toEqual({
      'Cache-Control': {
        schema: { enum: ['no-store'], type: 'string' },
      },
      Location: {
        description: 'Verified Telegram authorization URL.',
        schema: { format: 'uri', type: 'string' },
      },
      Pragma: {
        schema: { enum: ['no-cache'], type: 'string' },
      },
      'Referrer-Policy': {
        schema: { enum: ['no-referrer'], type: 'string' },
      },
      'Set-Cookie': {
        description: 'Short-lived browser OIDC state binding.',
        schema: { type: 'string' },
      },
      'X-Request-ID': {
        description: 'Trusted request correlation ID.',
        schema: { type: 'string' },
      },
    })
    expect(operation?.responses['400']).toBeDefined()
    expect(operation?.responses['413']).toBeDefined()
    expect(operation?.responses['422']).toBeDefined()
    expect(operation?.responses['503']).toBeDefined()
  })
})
