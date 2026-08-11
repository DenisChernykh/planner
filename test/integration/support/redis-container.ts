import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis'
import { createClient } from 'redis'

export const REDIS_AUTH_IMAGE =
  'redis:8.8.0-trixie@sha256:234c902a2db49461a129e2d4aeff85b28cf20187ed274a67f6e50995fa713c7b'

const redisTestPassword = 'planner-session-test-only'

export async function startRedisContainer(): Promise<StartedRedisContainer> {
  const container = await new RedisContainer(REDIS_AUTH_IMAGE)
    .withPassword(redisTestPassword)
    .start()
  const client = createClient({
    url: container.getConnectionUrl(),
    disableOfflineQueue: true,
    commandOptions: { timeout: 5_000 },
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  })
  client.on('error', () => undefined)
  try {
    await client.connect()
    if ((await client.ping()) !== 'PONG')
      throw new Error('Redis test startup failed')
    return container
  } catch (error: unknown) {
    await container.stop()
    throw error
  } finally {
    client.destroy()
  }
}
