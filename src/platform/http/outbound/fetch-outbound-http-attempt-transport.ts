export type OutboundHttpResponseBodyMode =
  | { readonly type: 'ignore' }
  | { readonly type: 'buffer'; readonly maxBytes: number }

export interface OutboundHttpAttemptRequest {
  readonly input: string | URL
  readonly init?: Omit<RequestInit, 'signal'>
  readonly timeoutMs: number
  readonly responseBody: OutboundHttpResponseBodyMode
}

export type OutboundHttpFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export type OutboundHttpResponseBody =
  | { readonly type: 'ignored' }
  | { readonly type: 'buffered'; readonly bytes: Uint8Array }
  | { readonly type: 'limit_exceeded'; readonly maxBytes: number }

export type OutboundHttpAttemptOutcome =
  | {
      readonly type: 'response'
      readonly status: number
      readonly headers: Headers
      readonly body: OutboundHttpResponseBody
      readonly durationMs: number
    }
  | { readonly type: 'timeout'; readonly durationMs: number }
  | {
      readonly type: 'transport_error'
      readonly error: unknown
      readonly durationMs: number
    }
  | { readonly type: 'aborted'; readonly durationMs: number }

const maximumTimerDelayMs = 2_147_483_647
const ownedInterruption = new Error('Owned outbound HTTP attempt interruption')

type AttemptPipelineOutcome = Extract<
  OutboundHttpAttemptOutcome,
  { readonly type: 'response' }
>

type PipelineSettlement =
  | {
      readonly type: 'response'
      readonly outcome: Omit<AttemptPipelineOutcome, 'durationMs'>
    }
  | { readonly type: 'error'; readonly error: unknown }

type Interruption = {
  readonly type: 'interrupted'
  readonly source: 'aborted' | 'timeout'
}

export class FetchOutboundHttpAttemptTransport {
  private readonly fetch: OutboundHttpFetch

  public constructor(fetch: OutboundHttpFetch = globalThis.fetch) {
    this.fetch = fetch
  }

  public async execute(
    request: OutboundHttpAttemptRequest,
    signal: AbortSignal,
  ): Promise<OutboundHttpAttemptOutcome> {
    assertPositiveTimerDelay(request.timeoutMs)
    if (request.responseBody.type === 'buffer') {
      assertBufferLimit(request.responseBody.maxBytes)
    }

    const startedAt = performance.now()
    if (signal.aborted) {
      return { type: 'aborted', durationMs: elapsedMilliseconds(startedAt) }
    }

    const controller = new AbortController()
    let interruptionSource: Interruption['source'] | undefined
    let resolveInterruption!: (interruption: Interruption) => void
    const interruption = new Promise<Interruption>((resolve) => {
      resolveInterruption = resolve
    })
    const interrupt = (
      source: Interruption['source'],
      reason?: unknown,
    ): void => {
      if (interruptionSource !== undefined) return
      interruptionSource = source
      resolveInterruption({ type: 'interrupted', source })
      controller.abort(reason)
    }
    const onAbort = (): void => interrupt('aborted', signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => interrupt('timeout'), request.timeoutMs)
    const pipeline = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw ownedInterruption
        return this.fetch(request.input, {
          ...request.init,
          signal: controller.signal,
        })
      })
      .then(async (response) => {
        if (controller.signal.aborted) {
          cancelResponseBodyBestEffort(response)
          throw ownedInterruption
        }
        const body = await readResponseBody(
          response,
          request.responseBody,
          controller.signal,
        )
        if (controller.signal.aborted) throw ownedInterruption
        return {
          type: 'response',
          status: response.status,
          headers: response.headers,
          body,
        } satisfies Omit<AttemptPipelineOutcome, 'durationMs'>
      })
    const settlement = pipeline.then<PipelineSettlement, PipelineSettlement>(
      (outcome) => ({ type: 'response', outcome }),
      (error: unknown) => ({ type: 'error', error }),
    )

    try {
      const winner = await Promise.race([settlement, interruption])
      if (winner.type === 'interrupted') {
        return {
          type: winner.source,
          durationMs: elapsedMilliseconds(startedAt),
        }
      }
      if (winner.type === 'response') {
        return {
          ...winner.outcome,
          durationMs: elapsedMilliseconds(startedAt),
        }
      }
      return {
        type: 'transport_error',
        error: winner.error,
        durationMs: elapsedMilliseconds(startedAt),
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

async function readResponseBody(
  response: Response,
  mode: OutboundHttpResponseBodyMode,
  signal: AbortSignal,
): Promise<OutboundHttpResponseBody> {
  if (mode.type === 'ignore') {
    if (signal.aborted) {
      cancelResponseBodyBestEffort(response)
      throw ownedInterruption
    }
    cancelResponseBodyBestEffort(response)
    return { type: 'ignored' }
  }

  if (contentLengthExceeds(response.headers, mode.maxBytes)) {
    cancelResponseBodyBestEffort(response)
    return { type: 'limit_exceeded', maxBytes: mode.maxBytes }
  }

  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (signal.aborted) throw ownedInterruption
    if (bytes.byteLength > mode.maxBytes) {
      return { type: 'limit_exceeded', maxBytes: mode.maxBytes }
    }
    return { type: 'buffered', bytes }
  }

  return readStreamBody(response.body, mode.maxBytes, signal)
}

async function readStreamBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<OutboundHttpResponseBody> {
  const reader = body.getReader()
  const cancelReader = (): void => {
    consumeBestEffort(() => reader.cancel(signal.reason))
  }
  if (signal.aborted) {
    cancelReader()
    throw ownedInterruption
  }
  signal.addEventListener('abort', cancelReader, { once: true })
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const result = await reader.read()
      if (signal.aborted) throw ownedInterruption
      if (result.done) break
      const chunk = result.value
      if (chunk.byteLength > maxBytes - totalBytes) {
        cancelReader()
        return { type: 'limit_exceeded', maxBytes }
      }
      totalBytes += chunk.byteLength
      chunks.push(chunk)
    }
  } finally {
    signal.removeEventListener('abort', cancelReader)
    consumeBestEffort(() => reader.releaseLock())
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { type: 'buffered', bytes }
}

function contentLengthExceeds(headers: Headers, maxBytes: number): boolean {
  const value = headers.get('content-length')
  if (value === null || !/^\d+$/.test(value)) return false
  return BigInt(value) > BigInt(maxBytes)
}

function cancelResponseBodyBestEffort(response: Response): void {
  if (response.body === null) return
  consumeBestEffort(() => response.body?.cancel())
}

function consumeBestEffort(operation: () => unknown): void {
  try {
    const result = operation()
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Cancellation cannot delay or replace the owned interruption outcome.
  }
}

function assertPositiveTimerDelay(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximumTimerDelayMs) {
    throw new RangeError('timeoutMs is outside the supported timer range')
  }
}

function assertBufferLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }
}

function elapsedMilliseconds(startedAt: number): number {
  const elapsed = performance.now() - startedAt
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
}
