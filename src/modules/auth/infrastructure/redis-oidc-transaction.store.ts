import { AuthDependencyUnavailableError } from '../application/auth-errors'
import type {
  OidcTransaction,
  OidcTransactionStorePort,
} from '../application/telegram-oidc.ports'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import type { RedisCodec } from '@/platform/redis/redis-codec'
import { RedisKeyBuilder } from '@/platform/redis/redis-key.builder'

import type { NodeAuthCryptoAdapter } from './node-auth-crypto.adapter'
import { createOidcTransactionCodec } from './oidc-transaction.codec'

export interface RedisOidcTransactionStoreConfig {
  readonly keyPrefix: string
  readonly stateKeySecret: Uint8Array
  readonly clientId: string
  readonly callbackUrl: string
}

export class RedisOidcTransactionStore implements OidcTransactionStorePort {
  private readonly keys: RedisKeyBuilder
  private readonly stateKeySecret: Uint8Array
  private readonly codec: RedisCodec<OidcTransaction>

  public constructor(
    private readonly executor: RedisCommandExecutorPort,
    private readonly crypto: NodeAuthCryptoAdapter,
    config: RedisOidcTransactionStoreConfig,
  ) {
    this.keys = new RedisKeyBuilder([config.keyPrefix, 'auth'], 'v1')
    this.stateKeySecret = new Uint8Array(config.stateKeySecret)
    this.codec = createOidcTransactionCodec({
      clientId: config.clientId,
      callbackUrl: config.callbackUrl,
    })
  }

  public async create(
    state: string,
    transaction: OidcTransaction,
    ttlMs: number,
  ): Promise<'created' | 'collision'> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new AuthDependencyUnavailableError()
    }
    try {
      const result = await this.executor.execute(
        'oidc-transaction-create',
        (client) =>
          client.sendCommand<string | null>([
            'SET',
            this.transactionKey(state),
            this.codec.encode(transaction),
            'NX',
            'PX',
            String(ttlMs),
          ]),
      )
      return result === 'OK' ? 'created' : 'collision'
    } catch (error: unknown) {
      if (error instanceof AuthDependencyUnavailableError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  public async consume(state: string): Promise<OidcTransaction | undefined> {
    try {
      const payload = await this.executor.execute(
        'oidc-transaction-consume',
        (client) =>
          client.sendCommand<string | null>([
            'GETDEL',
            this.transactionKey(state),
          ]),
      )
      if (payload === null) return undefined
      const decoded = this.codec.decode(payload)
      if (!decoded.ok) throw new AuthDependencyUnavailableError()
      return decoded.value
    } catch (error: unknown) {
      if (error instanceof AuthDependencyUnavailableError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }

  private transactionKey(state: string): string {
    return this.keys.build(
      'oidc-transaction',
      this.crypto.hmac(this.stateKeySecret, state),
    )
  }
}
