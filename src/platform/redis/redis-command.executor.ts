import type { RedisManagedClient } from './redis-client.factory'

export class RedisCommandTimeoutError extends Error {
  public constructor() {
    super('Redis command deadline exceeded')
    this.name = 'RedisCommandTimeoutError'
  }
}

export interface RedisCommandExecutorPort {
  execute<T>(
    operationName: string,
    operation: (client: RedisManagedClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
}

export class RedisCommandExecutor implements RedisCommandExecutorPort {
  public constructor(
    private readonly client: RedisManagedClient,
    private readonly timeoutMs: number,
  ) {}

  public execute<T>(
    operationName: string,
    operation: (client: RedisManagedClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    void operationName
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        callback()
      }
      const abort = (): void => {
        try {
          this.client.destroy()
        } catch {
          // A concurrent close may already own the transition.
        }
        finish(() => reject(new RedisCommandTimeoutError()))
      }
      const timer = setTimeout(abort, this.timeoutMs)
      if (signal?.aborted === true) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      void Promise.resolve()
        .then(() => operation(this.client))
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) =>
            finish(() =>
              reject(
                error instanceof Error
                  ? error
                  : new Error('Redis command failed'),
              ),
            ),
        )
    })
  }
}
