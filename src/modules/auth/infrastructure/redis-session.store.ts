import type { AuthenticatedPrincipal } from '../application/auth.types'
import { AuthDependencyUnavailableError } from '../application/auth-errors'
import type {
  IssuedBrowserSession,
  SessionStorePort,
  StoredSessionRecord,
} from '../application/session-store.port'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisKeyBuilder } from '@/platform/redis/redis-key.builder'
import { RedisScriptRunner } from '@/platform/redis/redis-script.runner'

import type { NodeAuthCryptoAdapter } from './node-auth-crypto.adapter'
import { REDIS_SESSION_SCRIPTS } from './redis-session.scripts'
import { sessionRecordCodec } from './session-record.codec'

export interface RedisSessionStoreConfig {
  readonly keyPrefix: string
  readonly sessionKeySecret: Uint8Array
  readonly csrfSecret: Uint8Array
  readonly idleTimeoutMs: number
  readonly absoluteTimeoutMs: number
  readonly touchIntervalMs: number
}

export class RedisSessionStore implements SessionStorePort {
  private readonly keys: RedisKeyBuilder
  private readonly scripts: RedisScriptRunner

  public constructor(
    private readonly executor: RedisCommandExecutorPort,
    private readonly crypto: NodeAuthCryptoAdapter,
    private readonly config: RedisSessionStoreConfig,
  ) {
    if (
      config.idleTimeoutMs < 1 ||
      config.absoluteTimeoutMs < config.idleTimeoutMs ||
      config.touchIntervalMs < 1 ||
      config.touchIntervalMs >= config.idleTimeoutMs
    )
      throw new Error('Redis session expiry policy is invalid')
    this.keys = new RedisKeyBuilder([config.keyPrefix, 'auth'], 'v1')
    this.scripts = new RedisScriptRunner(executor)
    for (const script of REDIS_SESSION_SCRIPTS) this.scripts.register(script)
  }

  public async issue(
    userId: string,
    nowMs: number,
  ): Promise<IssuedBrowserSession> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawToken = this.crypto.generateSessionToken()
      const sessionId = this.crypto.generateSessionId()
      const absoluteExpiresAtMs = nowMs + this.config.absoluteTimeoutMs
      const record: StoredSessionRecord = Object.freeze({
        schema: 1,
        userId,
        sessionId,
        csrfSeed: this.crypto.generateCsrfSeed(),
        createdAtMs: nowMs,
        lastSeenAtMs: nowMs,
        absoluteExpiresAtMs,
      })
      try {
        const created = await this.scripts.run<number>(
          'planner-auth-session-create-v1',
          [this.sessionKey(rawToken)],
          [
            sessionRecordCodec.encode(record),
            String(this.config.idleTimeoutMs),
          ],
        )
        if (created !== 1) continue
        return Object.freeze({
          rawToken,
          sessionId,
          csrfToken: this.csrfToken(record),
          absoluteExpiresAt: new Date(absoluteExpiresAtMs),
        })
      } catch (error: unknown) {
        throw new AuthDependencyUnavailableError({ cause: error })
      }
    }
    throw new AuthDependencyUnavailableError()
  }

  public async readAndTouch(
    rawToken: string,
    nowMs: number,
  ): Promise<StoredSessionRecord | undefined> {
    try {
      const payload = await this.scripts.run<string | null>(
        'planner-auth-session-touch-v1',
        [this.sessionKey(rawToken)],
        [
          String(nowMs),
          String(this.config.idleTimeoutMs),
          String(this.config.touchIntervalMs),
        ],
      )
      if (payload === null) return undefined
      const decoded = sessionRecordCodec.decode(payload)
      if (decoded.ok) return decoded.value
      await this.executor.execute('session-delete-invalid', (client) =>
        client.sendCommand<number>(['DEL', this.sessionKey(rawToken)]),
      )
      return undefined
    } catch (error: unknown) {
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  public csrfToken(record: StoredSessionRecord): string {
    return this.crypto.hmac(
      this.config.csrfSecret,
      `${record.sessionId}.${record.csrfSeed}`,
    )
  }

  public async revoke(
    rawToken: string,
    principal: AuthenticatedPrincipal,
  ): Promise<boolean> {
    try {
      return (
        (await this.scripts.run<number>(
          'planner-auth-session-revoke-v1',
          [this.sessionKey(rawToken)],
          [principal.userId, principal.sessionId],
        )) === 1
      )
    } catch (error: unknown) {
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  private sessionKey(rawToken: string): string {
    return this.keys.build(
      'session',
      this.crypto.hmac(this.config.sessionKeySecret, rawToken),
    )
  }
}
