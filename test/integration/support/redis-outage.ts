import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { StartedRedisContainer } from '@testcontainers/redis'

const execFileAsync = promisify(execFile)

export async function suspendRedis(
  container: StartedRedisContainer,
): Promise<void> {
  await execFileAsync('docker', ['pause', container.getId()])
}

export async function resumeRedis(
  container: StartedRedisContainer,
): Promise<void> {
  await execFileAsync('docker', ['unpause', container.getId()])
}
