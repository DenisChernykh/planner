import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:net'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import type { StartedRedisContainer } from '@testcontainers/redis'
import { Pool } from 'pg'
import request from 'supertest'

import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URL,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
} from '@/modules/auth/application/telegram-oidc.ports'
import {
  resumeRedis,
  suspendRedis,
} from '@test/integration/support/redis-outage'
import { startRedisContainer } from '@test/integration/support/redis-container'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const clientId = '123456789'
const clientSecret = '  callback client secret kept exact  '
const accessToken = 'telegram-access-token-for-e2e'
const userId = '11111111-1111-4111-8111-111111111111'
const spaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const memberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const telegramId = 4_503_599_627_370_495
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 })
const publicJwk = keyPair.publicKey.export({ format: 'jwk' })
const kid = 'telegram-e2e-key'

type ProviderMode = 'success' | 'invalid-grant' | 'offline'

function deployMigrations(databaseUrl: string): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`)
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Port reservation failed')
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
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

function signedIdToken(
  nonce: string,
  code: string,
  providerUserId: number,
): string {
  const now = Math.floor(Date.now() / 1_000)
  const header = base64UrlJson({ alg: 'RS256', kid, typ: 'JWT' })
  const payload = base64UrlJson({
    iss: TELEGRAM_OIDC_ISSUER,
    aud: clientId,
    sub: `opaque-subject-${providerUserId}`,
    iat: now,
    exp: now + 300,
    nonce,
    id: providerUserId,
    at_hash: oidcHash(accessToken),
    c_hash: oidcHash(code),
    name: 'never persist or log',
    preferred_username: 'never_persist',
    phone_number: '+000000000',
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), {
    key: keyPair.privateKey,
  }).toString('base64url')
  return `${signingInput}.${signature}`
}

function discovery(): Record<string, unknown> {
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
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? ''
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function formBody(body: RequestInit['body']): URLSearchParams {
  if (!(body instanceof URLSearchParams)) {
    throw new Error('Expected URLSearchParams request body')
  }
  return body
}

function expectStateClear(cookies: readonly string[] | undefined): void {
  expect(cookies).toEqual(
    expect.arrayContaining([expect.stringMatching(/^planner-oidc-state=;/u)]),
  )
}

describe('A03 public Telegram OIDC callback with real PostgreSQL and Redis', () => {
  let postgres: StartedPostgreSqlContainer
  let redis: StartedRedisContainer
  let admin: Pool
  let runtime: ApiRuntime
  let baseUrl: string
  let callbackUrl: string
  let realFetch: typeof globalThis.fetch
  let mode: ProviderMode
  let activeNonce: string
  let providerUserId: number
  let pauseRedisAfterJwks: boolean
  let redisSuspended = false
  let providerRequests: Array<{
    readonly url: string
    readonly init?: RequestInit
  }>

  beforeAll(async () => {
    ;[postgres, redis] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('planner_a03_callback')
        .withUsername('planner')
        .withPassword('planner-test-only')
        .start(),
      startRedisContainer(),
    ])
    deployMigrations(postgres.getConnectionUri())
    admin = new Pool({ connectionString: postgres.getConnectionUri() })
    await admin.query('INSERT INTO users (id) VALUES ($1)', [userId])
    await admin.query('INSERT INTO spaces (id, singleton_key) VALUES ($1, 1)', [
      spaceId,
    ])
    await admin.query(
      `INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ($1, $2, $3, 1)`,
      [memberId, spaceId, userId],
    )
    await admin.query(
      `INSERT INTO telegram_access_allowlist (space_id, user_id, telegram_id)
       VALUES ($1, $2, $3)`,
      [spaceId, userId, telegramId.toString()],
    )

    const port = await reservePort()
    baseUrl = `http://127.0.0.1:${port}`
    callbackUrl = `${baseUrl}/auth/telegram/callback`
    Object.assign(process.env, {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_AUTH_URL: redis.getConnectionUrl(),
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 91).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 92).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 93).toString('base64url'),
      AUTH_CSRF_ORIGINS: baseUrl,
      TELEGRAM_OIDC_CLIENT_ID: clientId,
      TELEGRAM_OIDC_CLIENT_SECRET: clientSecret,
      TELEGRAM_OIDC_CALLBACK_URL: callbackUrl,
    })

    realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (!url.startsWith('https://oauth.telegram.org/')) {
        return realFetch(input, init)
      }
      providerRequests.push(init === undefined ? { url } : { url, init })
      if (mode === 'offline') throw new Error('provider offline secret payload')
      if (url === TELEGRAM_OIDC_DISCOVERY_URL) {
        return jsonResponse(discovery())
      }
      if (url === TELEGRAM_OIDC_TOKEN_ENDPOINT) {
        if (mode === 'invalid-grant') {
          return jsonResponse(
            { error: 'invalid_grant', error_description: 'do not log me' },
            400,
          )
        }
        const form = formBody(init?.body)
        const code = form.get('code') ?? ''
        return jsonResponse({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signedIdToken(activeNonce, code, providerUserId),
          name: 'ignored provider response field',
        })
      }
      if (url === TELEGRAM_OIDC_JWKS_URL) {
        if (pauseRedisAfterJwks) {
          pauseRedisAfterJwks = false
          await suspendRedis(redis)
          redisSuspended = true
        }
        return jsonResponse({
          keys: [
            {
              ...publicJwk,
              kid,
              alg: 'RS256',
              use: 'sig',
              key_ops: ['verify'],
            },
          ],
        })
      }
      throw new Error('unexpected Telegram provider URL')
    }

    runtime = new ApiRuntime()
    await runtime.start()
  })

  afterAll(async () => {
    if (redisSuspended) await resumeRedis(redis)
    await runtime?.stop()
    globalThis.fetch = realFetch
    await admin?.end()
    await Promise.all([postgres?.stop(), redis?.stop()])
    for (const key of [
      'NODE_ENV',
      'API_HOST',
      'API_PORT',
      'DATABASE_URL',
      'REDIS_AUTH_URL',
      'REDIS_KEY_PREFIX',
      'AUTH_SESSION_KEY_SECRET',
      'AUTH_CSRF_SECRET',
      'AUTH_OIDC_STATE_KEY_SECRET',
      'AUTH_CSRF_ORIGINS',
      'TELEGRAM_OIDC_CLIENT_ID',
      'TELEGRAM_OIDC_CLIENT_SECRET',
      'TELEGRAM_OIDC_CALLBACK_URL',
    ]) {
      delete process.env[key]
    }
  })

  beforeEach(async () => {
    if (redisSuspended) {
      await resumeRedis(redis)
      redisSuspended = false
    }
    mode = 'success'
    activeNonce = ''
    providerUserId = telegramId
    pauseRedisAfterJwks = false
    providerRequests = []
    await admin.query('TRUNCATE telegram_external_identities')
  })

  async function startCeremony(): Promise<{
    readonly state: string
    readonly cookie: string
  }> {
    const response = await request(baseUrl)
      .get('/auth/telegram/start')
      .redirects(0)
      .expect(302)
    const location = new URL(response.headers['location'] as string)
    const state = location.searchParams.get('state') ?? ''
    activeNonce = location.searchParams.get('nonce') ?? ''
    const setCookie = response.headers['set-cookie'] as unknown as string[]
    return { state, cookie: cookiePair(setCookie[0] ?? '') }
  }

  it('consumes, verifies, binds and issues one bodyless 303 with exact cookies and headers', async () => {
    const usersBefore = await admin.query<{ xmin: string }>(
      'SELECT xmin::text FROM users WHERE id = $1',
      [userId],
    )
    const ceremony = await startCeremony()
    providerRequests = []
    const response = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: ceremony.state, code: 'visible-code' })
      .set('Cookie', ceremony.cookie)
      .set('X-Request-ID', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
      .redirects(0)
      .expect(303)

    expect(response.text).toBe('')
    expect(response.headers).toMatchObject({
      location: '/',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-request-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    const cookies = response.headers['set-cookie'] as unknown as string[]
    expectStateClear(cookies)
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^planner-session=[A-Za-z0-9_-]{43};/u),
      ]),
    )
    const sessionSetCookie = cookies.find((cookie) =>
      cookie.startsWith('planner-session='),
    )
    if (sessionSetCookie === undefined)
      throw new Error('missing session cookie')
    const principal = await request(baseUrl)
      .get('/auth/me')
      .set('Cookie', cookiePair(sessionSetCookie))
      .expect(200)
    const principalBody: unknown = principal.body
    expect(principalBody).toMatchObject({ userId })
    if (
      typeof principalBody !== 'object' ||
      principalBody === null ||
      !('sessionId' in principalBody)
    ) {
      throw new Error('missing session principal')
    }
    expect(principalBody.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    expect(providerRequests.map(({ url }) => url)).toEqual([
      TELEGRAM_OIDC_DISCOVERY_URL,
      TELEGRAM_OIDC_TOKEN_ENDPOINT,
      TELEGRAM_OIDC_JWKS_URL,
    ])
    const tokenRequest = providerRequests[1]?.init
    expect(tokenRequest?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
    })
    const tokenForm = Object.fromEntries(formBody(tokenRequest?.body))
    expect(tokenForm).toMatchObject({
      grant_type: 'authorization_code',
      code: 'visible-code',
      redirect_uri: callbackUrl,
      client_id: clientId,
    })
    expect(tokenForm['code_verifier']).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await expect(
      admin.query(
        `SELECT issuer, subject, provider_user_id::text, user_id::text
           FROM telegram_external_identities`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          issuer: TELEGRAM_OIDC_ISSUER,
          subject: `opaque-subject-${telegramId}`,
          provider_user_id: String(telegramId),
          user_id: userId,
        },
      ],
    })
    await expect(
      admin.query<{ xmin: string }>(
        'SELECT xmin::text FROM users WHERE id = $1',
        [userId],
      ),
    ).resolves.toMatchObject({ rows: usersBefore.rows })
  })

  it('rejects phase-one state failures without consume or cookie clear', async () => {
    const ceremony = await startCeremony()
    providerRequests = []
    const mismatched = Buffer.alloc(32, 17).toString('base64url')
    for (const path of [
      '/auth/telegram/callback?code=x',
      `/auth/telegram/callback?state=${mismatched}&code=x`,
      `/auth/telegram/callback?state=${ceremony.state}&state=${ceremony.state}&code=x`,
    ]) {
      const response = await request(baseUrl)
        .get(path)
        .set('Cookie', ceremony.cookie)
        .redirects(0)
        .expect(401)
      expect(response.body).toMatchObject({ code: 'OIDC_LOGIN_REJECTED' })
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    expect(providerRequests).toHaveLength(0)

    const valid = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: ceremony.state, code: 'after-mismatch' })
      .set('Cookie', ceremony.cookie)
      .redirects(0)
      .expect(303)
    expectStateClear(valid.headers['set-cookie'] as unknown as string[])
  })

  it('consumes matched invalid and OAuth-error candidates before fixed safe Problems', async () => {
    for (const [query, status, code] of [
      [{ unknown: 'x' }, 422, 'VALIDATION_FAILED'],
      [
        { error: 'access_denied', error_description: 'private value' },
        401,
        'OIDC_LOGIN_REJECTED',
      ],
      [{ code: 'x', error: 'access_denied' }, 422, 'VALIDATION_FAILED'],
    ] as const) {
      const ceremony = await startCeremony()
      providerRequests = []
      const response = await request(baseUrl)
        .get('/auth/telegram/callback')
        .query({ state: ceremony.state, ...query })
        .set('Cookie', ceremony.cookie)
        .redirects(0)
        .expect(status)
      const responseBody: unknown = response.body
      expect(responseBody).toMatchObject({ code, status })
      if (code === 'VALIDATION_FAILED') {
        expect(responseBody).toMatchObject({
          errors: [
            {
              pointer: '/query',
              code: 'invalid_value',
              detail: 'OIDC callback query is invalid.',
            },
          ],
        })
      }
      expectStateClear(response.headers['set-cookie'] as unknown as string[])
      expect(JSON.stringify(responseBody)).not.toMatch(
        /private value|access_denied/u,
      )
      expect(providerRequests).toHaveLength(0)

      await request(baseUrl)
        .get('/auth/telegram/callback')
        .query({ state: ceremony.state, code: 'replay' })
        .set('Cookie', ceremony.cookie)
        .redirects(0)
        .expect(401)
    }
  })

  it('keeps parser 400/413 and callback 422 body boundaries before ceremony I/O', async () => {
    const ceremony = await startCeremony()
    providerRequests = []
    for (const body of [{}, [], 'wire text']) {
      const response = await request(baseUrl)
        .get(`/auth/telegram/callback?state=${ceremony.state}&code=x`)
        .set('Cookie', ceremony.cookie)
        .set(
          'Content-Type',
          typeof body === 'string' ? 'text/plain' : 'application/json',
        )
        .send(body)
        .expect(422)
      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' })
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    for (const scalar of ['true', '42', '"wire"', '{']) {
      await request(baseUrl)
        .get(`/auth/telegram/callback?state=${ceremony.state}&code=x`)
        .set('Cookie', ceremony.cookie)
        .set('Content-Type', 'application/json')
        .send(scalar)
        .expect(400)
    }
    await request(baseUrl)
      .get(`/auth/telegram/callback?state=${ceremony.state}&code=x`)
      .set('Cookie', ceremony.cookie)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(1_048_577) }))
      .expect(413)
    expect(providerRequests).toHaveLength(0)

    await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: ceremony.state, code: 'still-not-consumed' })
      .set('Cookie', ceremony.cookie)
      .redirects(0)
      .expect(303)
  })

  it('pins code, duplicate-field and OAuth NQSCHAR query boundaries', async () => {
    for (const acceptedCode of ['x', 'x'.repeat(4_096)]) {
      const ceremony = await startCeremony()
      await request(baseUrl)
        .get('/auth/telegram/callback')
        .query({ state: ceremony.state, code: acceptedCode })
        .set('Cookie', ceremony.cookie)
        .redirects(0)
        .expect(303)
    }

    for (const path of [
      (state: string) =>
        `/auth/telegram/callback?state=${state}&code=${'x'.repeat(4_097)}`,
      (state: string) =>
        `/auth/telegram/callback?state=${state}&code=one&code=two`,
      (state: string) =>
        `/auth/telegram/callback?state=${state}&error=access_denied&error_description=one&error_description=two`,
      (state: string) =>
        `/auth/telegram/callback?state=${state}&error=${encodeURIComponent('invalid"error')}`,
    ]) {
      const ceremony = await startCeremony()
      providerRequests = []
      const response = await request(baseUrl)
        .get(path(ceremony.state))
        .set('Cookie', ceremony.cookie)
        .redirects(0)
        .expect(422)
      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' })
      expectStateClear(response.headers['set-cookie'] as unknown as string[])
      expect(providerRequests).toHaveLength(0)
    }

    const oauth = await startCeremony()
    providerRequests = []
    const cancelled = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({
        state: oauth.state,
        error: 'access_denied',
        error_description: 'd'.repeat(1_024),
        error_uri: 'u'.repeat(2_048),
      })
      .set('Cookie', oauth.cookie)
      .redirects(0)
      .expect(401)
    expect(cancelled.body).toMatchObject({ code: 'OIDC_LOGIN_REJECTED' })
    expectStateClear(cancelled.headers['set-cookie'] as unknown as string[])
    expect(providerRequests).toHaveLength(0)
  })

  it('maps invalid grant to 401 and verified unknown allowlist to 403 without session cookies', async () => {
    const invalidGrant = await startCeremony()
    mode = 'invalid-grant'
    const rejected = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: invalidGrant.state, code: 'invalid-code' })
      .set('Cookie', invalidGrant.cookie)
      .redirects(0)
      .expect(401)
    expect(rejected.body).toMatchObject({ code: 'OIDC_LOGIN_REJECTED' })
    expectStateClear(rejected.headers['set-cookie'] as unknown as string[])
    expect(
      (rejected.headers['set-cookie'] as unknown as string[]).join(';'),
    ).not.toContain('planner-session=')

    mode = 'success'
    providerUserId = 42
    const unknown = await startCeremony()
    providerUserId = 42
    const denied = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: unknown.state, code: 'verified-unknown' })
      .set('Cookie', unknown.cookie)
      .redirects(0)
      .expect(403)
    expect(denied.body).toMatchObject({ code: 'OIDC_ACCESS_DENIED' })
    expectStateClear(denied.headers['set-cookie'] as unknown as string[])
    expect(
      (denied.headers['set-cookie'] as unknown as string[]).join(';'),
    ).not.toContain('planner-session=')
  })

  it('keeps a committed binding across Redis session failure and recovers idempotently', async () => {
    const first = await startCeremony()
    pauseRedisAfterJwks = true
    const unavailable = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: first.state, code: 'session-fails' })
      .set('Cookie', first.cookie)
      .redirects(0)
      .expect(503)
    expect(unavailable.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    expectStateClear(unavailable.headers['set-cookie'] as unknown as string[])
    expect(
      (unavailable.headers['set-cookie'] as unknown as string[]).join(';'),
    ).not.toContain('planner-session=')
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM telegram_external_identities',
        )
      ).rows,
    ).toEqual([{ count: 1 }])

    await resumeRedis(redis)
    redisSuspended = false
    const recovery = await startCeremony()
    const recovered = await request(baseUrl)
      .get('/auth/telegram/callback')
      .query({ state: recovery.state, code: 'recovery' })
      .set('Cookie', recovery.cookie)
      .redirects(0)
      .expect(303)
    expect(
      (recovered.headers['set-cookie'] as unknown as string[]).join(';'),
    ).toContain('planner-session=')
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS count FROM telegram_external_identities',
        )
      ).rows,
    ).toEqual([{ count: 1 }])
  })

  it('keeps provider discovery and JWKS out of readiness', async () => {
    mode = 'offline'
    providerRequests = []
    await request(baseUrl).get('/health/ready').expect(200, { status: 'ok' })
    expect(providerRequests).toHaveLength(0)
  })
})
