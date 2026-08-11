import type { RedisAuthConnectionManager } from './redis-auth.connection'

export interface RedisLifecyclePort {
  connect(signal: AbortSignal): Promise<void>
  close(signal: AbortSignal): Promise<void>
}

export class RedisLifecycle implements RedisLifecyclePort {
  private connectPromise?: Promise<void>
  private closePromise?: Promise<void>

  public constructor(
    private readonly connection: RedisAuthConnectionManager,
    private readonly shutdownTimeoutMs: number,
  ) {}

  public connect(signal: AbortSignal): Promise<void> {
    this.connectPromise ??= this.connection.connect(signal)
    return this.connectPromise
  }

  public close(signal: AbortSignal): Promise<void> {
    this.closePromise ??= this.connection.close(
      AbortSignal.any([signal, AbortSignal.timeout(this.shutdownTimeoutMs)]),
    )
    return this.closePromise
  }
}
