import { createClient } from 'redis'

export interface RedisManagedClient {
  readonly isOpen: boolean
  readonly isReady: boolean
  connect(): Promise<unknown>
  ping(): Promise<string>
  sendCommand<T>(command: readonly string[]): Promise<T>
  close(): Promise<unknown>
  destroy(): void
  onError(listener: (error: unknown) => void): void
}

export interface RedisClientFactoryConfig {
  readonly connectTimeoutMs: number
  readonly commandTimeoutMs: number
}

export interface RedisDriverCreateOptions {
  readonly url: string
  readonly connectTimeoutMs: number
  readonly commandTimeoutMs: number
}

export type RedisDriverCreator = (
  options: RedisDriverCreateOptions,
) => RedisManagedClient

function createNodeRedisDriver(
  options: RedisDriverCreateOptions,
): RedisManagedClient {
  const socket = {
    connectTimeout: options.connectTimeoutMs,
    reconnectStrategy: (retries: number) =>
      retries >= 5 ? false : Math.min(50 * 2 ** retries, 1_000),
  }
  const driver = createClient({
    url: options.url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1_000,
    commandOptions: { timeout: options.commandTimeoutMs },
    socket:
      new URL(options.url).protocol === 'rediss:'
        ? { ...socket, tls: true as const }
        : socket,
  })
  return {
    get isOpen() {
      return driver.isOpen
    },
    get isReady() {
      return driver.isReady
    },
    connect: () => driver.connect(),
    ping: () => driver.ping(),
    sendCommand: <T>(command: readonly string[]) =>
      driver.sendCommand<T>([...command]),
    close: () => driver.close(),
    destroy: () => {
      if (driver.isOpen) driver.destroy()
    },
    onError: (listener) => {
      driver.on('error', listener)
    },
  }
}

export class RedisClientFactory {
  public constructor(
    private readonly config: RedisClientFactoryConfig,
    private readonly createDriver: RedisDriverCreator = createNodeRedisDriver,
  ) {}

  public create(url: string): RedisManagedClient {
    const client = this.createDriver({ url, ...this.config })
    client.onError(() => undefined)
    return client
  }
}
