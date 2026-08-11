import type { ExecutionContext } from '@nestjs/common'
import { UnsupportedMediaTypeException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import {
  AuthCsrfRejectedError,
  AuthenticationRequiredError,
} from '@/modules/auth/application/auth-errors'
import { IssueSessionUseCase } from '@/modules/auth/application/issue-session.use-case'
import type { LocalUserPort } from '@/modules/auth/application/local-user.port'
import type {
  IssuedBrowserSession,
  SessionStorePort,
  StoredSessionRecord,
} from '@/modules/auth/application/session-store.port'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { AuthCookieAdapter } from '@/modules/auth/presentation/auth-cookie.adapter'
import { AuthenticationGuard } from '@/modules/auth/presentation/authentication.guard'
import { BrowserOriginGuard } from '@/modules/auth/presentation/browser-origin.guard'
import {
  constantTimeCsrfTokenEqual,
  SessionCsrfGuard,
} from '@/modules/auth/presentation/session-csrf.guard'
import { readCanonicalSessionToken } from '@/modules/auth/presentation/session-cookie'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import { PublicEndpoint } from '@/platform/http/policy/public-endpoint.decorator'
import type { RedisManagedClient } from '@/platform/redis/redis-client.factory'
import { RedisCommandExecutor } from '@/platform/redis/redis-command.executor'

const userId = '0f739752-52a2-45bc-aa9f-3de43f47f47b'
const sessionId = 'AQEBAQEBAQEBAQEBAQEBAQ'
const rawToken = Buffer.alloc(32, 2).toString('base64url')
const csrfToken = Buffer.alloc(32, 3).toString('base64url')

const issued: IssuedBrowserSession = Object.freeze({
  rawToken,
  sessionId,
  csrfToken,
  absoluteExpiresAt: new Date('2026-09-10T00:00:00.000Z'),
})

const record: StoredSessionRecord = Object.freeze({
  schema: 1,
  userId,
  sessionId,
  csrfSeed: Buffer.alloc(32, 4).toString('base64url'),
  createdAtMs: 1_000,
  lastSeenAtMs: 1_000,
  absoluteExpiresAtMs: 2_000,
})

function createStore(
  overrides: Partial<SessionStorePort> = {},
): SessionStorePort {
  return {
    issue: jest.fn().mockResolvedValue(issued),
    readAndTouch: jest.fn().mockResolvedValue(record),
    csrfToken: jest.fn().mockReturnValue(csrfToken),
    revoke: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function requestContext(
  request: object,
  handler: object,
  controller: object,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: <T>() => undefined as T,
      getNext: <T>() => undefined as T,
    }),
  } as ExecutionContext
}

function runtimeInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://planner:test@127.0.0.1:5432/planner',
    REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:6379',
    REDIS_KEY_PREFIX: 'planner',
    AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 5).toString('base64url'),
    AUTH_CSRF_SECRET: Buffer.alloc(32, 6).toString('base64url'),
    AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 7).toString('base64url'),
    AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CALLBACK_URL: 'http://127.0.0.1:3000/auth/telegram/callback',
    ...overrides,
  }
}

describe('S04 local User and opaque session foundation', () => {
  it('cleans the Redis watchdog when an operation throws synchronously', async () => {
    jest.useFakeTimers()
    const destroy = jest.fn()
    const client: RedisManagedClient = {
      isOpen: true,
      isReady: true,
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      sendCommand: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      destroy,
      onError: jest.fn(),
    }
    const executor = new RedisCommandExecutor(client, 100)
    const operationFailure = new Error('synchronous operation failure')

    try {
      await expect(
        executor.execute('sync-failure', () => {
          throw operationFailure
        }),
      ).rejects.toBe(operationFailure)
      await jest.advanceTimersByTimeAsync(100)
      expect(destroy).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('checks a pre-existing User before issuing and never writes a session for an unknown User', async () => {
    const userExists = jest.fn().mockResolvedValue(false)
    const issueSession = jest.fn().mockResolvedValue(issued)
    const users: LocalUserPort = {
      exists: userExists,
    }
    const sessions = createStore({ issue: issueSession })
    const useCase = new IssueSessionUseCase(users, sessions)

    await expect(useCase.execute(userId, 1_000)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    )
    expect(userExists).toHaveBeenCalledWith(userId)
    expect(issueSession).not.toHaveBeenCalled()
  })

  it('creates independent canonical token, public ID and CSRF seed values', () => {
    let next = 0
    const crypto = new NodeAuthCryptoAdapter((size) => {
      next += 1
      return Buffer.alloc(size, next)
    })

    const first = {
      raw: crypto.generateSessionToken(),
      publicId: crypto.generateSessionId(),
      csrfSeed: crypto.generateCsrfSeed(),
    }
    const second = {
      raw: crypto.generateSessionToken(),
      publicId: crypto.generateSessionId(),
      csrfSeed: crypto.generateCsrfSeed(),
    }

    expect(first.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    expect(first.csrfSeed).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(
      new Set([...Object.values(first), ...Object.values(second)]).size,
    ).toBe(6)
  })

  it('accepts exactly one canonical session cookie and rejects ambiguity', () => {
    expect(
      readCanonicalSessionToken(
        `other=x; planner-session=${rawToken}`,
        'planner-session',
      ),
    ).toBe(rawToken)
    expect(
      readCanonicalSessionToken(
        `planner-session=${rawToken}; planner-session=${rawToken}`,
        'planner-session',
      ),
    ).toBeUndefined()
    expect(
      readCanonicalSessionToken(
        'planner-session=not-canonical',
        'planner-session',
      ),
    ).toBeUndefined()
  })

  it('uses host-only cookie attributes and clears with matching transport attributes', () => {
    const response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    }
    const adapter = new AuthCookieAdapter('planner-session', false)

    adapter.set(response as never, issued)
    adapter.clear(response as never)

    expect(response.cookie).toHaveBeenCalledWith('planner-session', rawToken, {
      expires: issued.absoluteExpiresAt,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: false,
    })
    expect(response.clearCookie).toHaveBeenCalledWith('planner-session', {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: false,
    })
  })

  it('requires authentication by default and bypasses only explicit public metadata', async () => {
    class PrivateController {}
    class PublicController {}
    PublicEndpoint()(PublicController)
    const reflector = new Reflector()
    const authenticate = { execute: jest.fn() }
    const authContext = { prepare: jest.fn() }
    const guard = new AuthenticationGuard(
      reflector,
      authenticate as never,
      authContext as never,
      'planner-session',
      () => 1_000,
    )
    const handler = (): void => undefined

    await expect(
      guard.canActivate(
        requestContext({ headers: {} }, handler, PrivateController),
      ),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError)
    await expect(
      guard.canActivate(
        requestContext({ headers: {} }, handler, PublicController),
      ),
    ).resolves.toBe(true)
    expect(authenticate.execute).not.toHaveBeenCalled()
  })

  it('requires JSON and an exact same-site origin only for unsafe methods', () => {
    const guard = new BrowserOriginGuard(['https://planner.example'])
    const handler = (): void => undefined
    const controller = class {}
    const context = (
      method: string,
      headers: Record<string, string | readonly string[]>,
    ): ExecutionContext =>
      requestContext({ method, headers }, handler, controller)

    expect(guard.canActivate(context('GET', {}))).toBe(true)
    expect(() =>
      guard.canActivate(context('POST', { origin: 'https://planner.example' })),
    ).toThrow(UnsupportedMediaTypeException)
    expect(() =>
      guard.canActivate(
        context('POST', {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        }),
      ),
    ).toThrow(AuthCsrfRejectedError)
    expect(() =>
      guard.canActivate(
        context('POST', {
          'content-type': 'application/json',
          origin: ['https://evil.example', 'https://planner.example'],
          referer: 'https://planner.example/path',
        }),
      ),
    ).toThrow(AuthCsrfRejectedError)
    expect(
      guard.canActivate(
        context('POST', {
          'content-type': 'application/json; charset=utf-8',
          referer: 'https://planner.example/path',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true)
  })

  it('compares only canonical session-bound CSRF tokens', () => {
    expect(constantTimeCsrfTokenEqual(csrfToken, csrfToken)).toBe(true)
    expect(
      constantTimeCsrfTokenEqual(
        Buffer.alloc(32, 7).toString('base64url'),
        csrfToken,
      ),
    ).toBe(false)
    expect(constantTimeCsrfTokenEqual('not-canonical', csrfToken)).toBe(false)
  })

  it('rejects missing CSRF on unsafe requests and skips it for safe methods', async () => {
    const guard = new SessionCsrfGuard(
      new Reflector(),
      { preparedState: jest.fn().mockReturnValue({ rawToken }) } as never,
      { execute: jest.fn().mockResolvedValue({ csrfToken }) } as never,
    )
    const handler = (): void => undefined
    const controller = class {}

    await expect(
      guard.canActivate(
        requestContext({ method: 'POST', headers: {} }, handler, controller),
      ),
    ).rejects.toBeInstanceOf(AuthCsrfRejectedError)
    await expect(
      guard.canActivate(
        requestContext({ method: 'OPTIONS', headers: {} }, handler, controller),
      ),
    ).resolves.toBe(true)
  })

  it('validates exact secrets, defensive copies, production origins and runtime bounds', () => {
    const config = buildApiRuntimeConfig(runtimeInput())
    const firstSecret = config.auth.sessionKeySecret
    firstSecret[0] = 255

    expect(config.auth.sessionKeySecret[0]).toBe(5)
    expect(config.auth.csrfSecret[0]).toBe(6)
    const firstOidcSecret = config.auth.telegramOidc.stateKeySecret
    firstOidcSecret[0] = 255
    expect(config.auth.telegramOidc.stateKeySecret[0]).toBe(7)
    const runtimeService = new RuntimeConfigService(config)
    const firstServiceOidcSecret =
      runtimeService.auth.telegramOidc.stateKeySecret
    firstServiceOidcSecret[0] = 255
    expect(runtimeService.auth.telegramOidc.stateKeySecret[0]).toBe(7)
    expect(config.auth.telegramOidc).toMatchObject({
      clientId: '123456789',
      callbackUrl: 'http://127.0.0.1:3000/auth/telegram/callback',
    })
    expect(config.auth.sessionCookieName).toBe('planner-session')
    expect(config.auth).toMatchObject({
      idleTimeoutMs: 604_800_000,
      absoluteTimeoutMs: 2_592_000_000,
      touchIntervalMs: 300_000,
    })
    expect(config.redis).toMatchObject({
      connectTimeoutMs: 2_000,
      commandTimeoutMs: 2_000,
      healthTimeoutMs: 2_500,
      shutdownTimeoutMs: 1_000,
    })
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({
          AUTH_CSRF_SECRET: runtimeInput()['AUTH_SESSION_KEY_SECRET'],
        }),
      ),
    ).toThrow()
    for (const collision of [
      { AUTH_OIDC_STATE_KEY_SECRET: runtimeInput()['AUTH_SESSION_KEY_SECRET'] },
      { AUTH_OIDC_STATE_KEY_SECRET: runtimeInput()['AUTH_CSRF_SECRET'] },
      { AUTH_CSRF_SECRET: runtimeInput()['AUTH_OIDC_STATE_KEY_SECRET'] },
    ]) {
      expect(() => buildApiRuntimeConfig(runtimeInput(collision))).toThrow()
    }
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({ AUTH_CSRF_ORIGINS: 'ftp://planner.example' }),
      ),
    ).toThrow()
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({
          AUTH_SESSION_KEY_SECRET: Buffer.alloc(31).toString('base64url'),
        }),
      ),
    ).toThrow()
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({
          AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(31).toString('base64url'),
        }),
      ),
    ).toThrow()
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({
          NODE_ENV: 'production',
          AUTH_CSRF_ORIGINS: 'http://planner.example',
        }),
      ),
    ).toThrow()
    expect(
      buildApiRuntimeConfig(
        runtimeInput({
          TELEGRAM_OIDC_CALLBACK_URL:
            'http://[::1]:3000/auth/telegram/callback',
        }),
      ).auth.telegramOidc.callbackUrl,
    ).toBe('http://[::1]:3000/auth/telegram/callback')
    for (const invalidOidc of [
      { TELEGRAM_OIDC_CLIENT_ID: '0' },
      { TELEGRAM_OIDC_CLIENT_ID: '0123' },
      { TELEGRAM_OIDC_CLIENT_ID: ' 123' },
      {
        TELEGRAM_OIDC_CALLBACK_URL:
          'http://evil.example/auth/telegram/callback',
      },
      {
        TELEGRAM_OIDC_CALLBACK_URL:
          'http://localhost:3000/auth/telegram/callback',
      },
      { TELEGRAM_OIDC_CALLBACK_URL: 'http://127.0.0.1:3000/other' },
      {
        TELEGRAM_OIDC_CALLBACK_URL:
          'http://127.0.0.1:3000/auth/telegram/callback?returnTo=/evil',
      },
    ]) {
      expect(() => buildApiRuntimeConfig(runtimeInput(invalidOidc))).toThrow()
    }
    expect(() =>
      buildApiRuntimeConfig(
        runtimeInput({
          NODE_ENV: 'production',
          AUTH_CSRF_ORIGINS: 'https://planner.example',
          TELEGRAM_OIDC_CALLBACK_URL:
            'http://127.0.0.1:3000/auth/telegram/callback',
        }),
      ),
    ).toThrow()
    expect(
      buildApiRuntimeConfig(
        runtimeInput({
          NODE_ENV: 'production',
          AUTH_CSRF_ORIGINS: 'https://planner.example',
          TELEGRAM_OIDC_CALLBACK_URL:
            'https://planner.example/auth/telegram/callback',
        }),
      ).auth.sessionCookieName,
    ).toBe('__Host-planner-session')
  })
})
