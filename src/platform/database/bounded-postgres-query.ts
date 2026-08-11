import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg'

interface TimedQueryConfig extends QueryConfig {
  readonly query_timeout: number
}

const interrupted = Symbol('interrupted')

export async function runBoundedPostgresQuery(
  pool: Pool,
  text: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<'up' | 'down'> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, Math.max(1, timeoutMs))
  const stopped = new Promise<typeof interrupted>((resolve) => {
    if (controller.signal.aborted) resolve(interrupted)
    else
      controller.signal.addEventListener('abort', () => resolve(interrupted), {
        once: true,
      })
  })
  const acquisition = pool.connect()
  let client: PoolClient | undefined
  try {
    const acquired = await Promise.race([acquisition, stopped])
    if (acquired === interrupted) {
      void acquisition.then((late) => late.release(true)).catch(() => undefined)
      return 'down'
    }
    client = acquired
    const queryConfig: TimedQueryConfig = {
      text,
      query_timeout: Math.max(1, timeoutMs),
    }
    const query: Promise<QueryResult> = client.query(queryConfig)
    const result = await Promise.race([query, stopped])
    if (result === interrupted) {
      client.release(true)
      void query.catch(() => undefined)
      return 'down'
    }
    client.release()
    return 'up'
  } catch {
    client?.release(true)
    return 'down'
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
