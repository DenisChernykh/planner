import type { ReadinessIndicator } from '@/platform/http/health/readiness-indicator'

import type { RedisAuthConnectionManager } from './redis-auth.connection'

export class RedisReadinessIndicator implements ReadinessIndicator {
  public constructor(
    private readonly connection: RedisAuthConnectionManager,
    readonly timeoutMs: number,
  ) {}

  public async check(signal: AbortSignal): Promise<'up' | 'down'> {
    try {
      const response = await this.connection.commandExecutor.execute(
        'readiness-ping',
        (client) => client.ping(),
        signal,
      )
      return response === 'PONG' ? 'up' : 'down'
    } catch {
      return 'down'
    }
  }
}
