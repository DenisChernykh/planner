import {
  FetchOutboundHttpAttemptTransport,
  type OutboundHttpAttemptOutcome,
  type OutboundHttpAttemptRequest,
  type OutboundHttpFetch,
} from '@/platform/http/outbound/fetch-outbound-http-attempt-transport'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface StreamingResponseFixture {
  readonly response: Response
  readonly cancel: jest.Mock<void | PromiseLike<void>, [reason?: unknown]>
  readonly getReader: jest.SpiedFunction<
    ReadableStream<Uint8Array>['getReader']
  >
}

function streamingResponse(
  chunks: readonly Uint8Array[],
  init?: ResponseInit,
): StreamingResponseFixture {
  let nextChunk = 0
  const cancel = jest.fn<void | PromiseLike<void>, [reason?: unknown]>(
    (reason?: unknown): void => {
      void reason
    },
  )
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks[nextChunk]
      nextChunk += 1
      if (chunk === undefined) {
        controller.close()
      } else {
        controller.enqueue(chunk)
      }
    },
    cancel,
  })
  const getReader = jest.spyOn(stream, 'getReader')
  return { response: new Response(stream, init), cancel, getReader }
}

function assertDuration(outcome: OutboundHttpAttemptOutcome): void {
  expect(outcome.durationMs).toEqual(expect.any(Number))
  expect(Number.isFinite(outcome.durationMs)).toBe(true)
  expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
}

function compileTimeContract(): void {
  const fetch: OutboundHttpFetch = (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    void input
    void init
    return Promise.resolve(new Response())
  }
  const transport = new FetchOutboundHttpAttemptTransport(fetch)
  const request: OutboundHttpAttemptRequest = {
    input: new URL('https://example.test/resource'),
    init: { method: 'POST' },
    timeoutMs: 1,
    responseBody: { type: 'ignore' },
  }
  const execute: (
    request: OutboundHttpAttemptRequest,
    signal: AbortSignal,
  ) => Promise<OutboundHttpAttemptOutcome> = transport.execute.bind(transport)

  const invalidInit: NonNullable<OutboundHttpAttemptRequest['init']> = {
    // @ts-expect-error The transport owns the composed fetch signal.
    signal: new AbortController().signal,
  }
  // @ts-expect-error timeoutMs is required.
  const missingTimeout: OutboundHttpAttemptRequest = {
    input: 'https://example.test/resource',
    responseBody: { type: 'ignore' },
  }
  // @ts-expect-error responseBody is required.
  const missingBodyMode: OutboundHttpAttemptRequest = {
    input: 'https://example.test/resource',
    timeoutMs: 1,
  }
  // @ts-expect-error execute requires the caller signal.
  const missingSignal = transport.execute(request)

  void execute
  void invalidInit
  void missingTimeout
  void missingBodyMode
  void missingSignal
}

void compileTimeContract

describe('FetchOutboundHttpAttemptTransport', () => {
  it('passes the declared input and init with one transport-owned signal', async () => {
    const input = new URL('https://example.test/resource')
    const caller = new AbortController()
    const smuggled = new AbortController()
    let receivedInput: string | URL | undefined
    let receivedInit: RequestInit | undefined
    const fetch: OutboundHttpFetch = (actualInput, actualInit) => {
      receivedInput = actualInput
      receivedInit = actualInit
      return Promise.resolve(
        new Response(null, { status: 202, headers: { 'x-provider': 'ok' } }),
      )
    }
    const transport = new FetchOutboundHttpAttemptTransport(fetch)

    const outcome = await transport.execute(
      {
        input,
        init: {
          headers: { authorization: 'Bearer secret' },
          method: 'POST',
          signal: smuggled.signal,
        } as RequestInit,
        timeoutMs: 1_000,
        responseBody: { type: 'ignore' },
      },
      caller.signal,
    )

    expect(transport.execute.bind(transport)).toHaveLength(2)
    expect(receivedInput).toBe(input)
    expect(receivedInit).toMatchObject({
      headers: { authorization: 'Bearer secret' },
      method: 'POST',
    })
    expect(receivedInit?.signal).toBeInstanceOf(AbortSignal)
    expect(receivedInit?.signal).not.toBe(caller.signal)
    expect(receivedInit?.signal).not.toBe(smuggled.signal)
    expect(outcome).toMatchObject({
      type: 'response',
      status: 202,
      body: { type: 'ignored' },
    })
    assertDuration(outcome)
  })

  it('uses globalThis.fetch when the constructor argument is omitted', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))

    try {
      const transport = new FetchOutboundHttpAttemptTransport()
      const outcome = await transport.execute(
        {
          input: 'https://example.test/default-fetch',
          timeoutMs: 1_000,
          responseBody: { type: 'ignore' },
        },
        new AbortController().signal,
      )

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[0]).toBe(
        'https://example.test/default-fetch',
      )
      expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
      expect(outcome).toMatchObject({ type: 'response', status: 204 })
      assertDuration(outcome)
    } finally {
      fetch.mockRestore()
    }
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2_147_483_648])(
    'rejects invalid timeoutMs %p before calling fetch',
    async (timeoutMs) => {
      const fetch = jest.fn<
        ReturnType<OutboundHttpFetch>,
        Parameters<OutboundHttpFetch>
      >()
      const transport = new FetchOutboundHttpAttemptTransport(fetch)

      await expect(
        transport.execute(
          {
            input: 'https://example.test/resource',
            timeoutMs,
            responseBody: { type: 'ignore' },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(RangeError)

      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid maxBytes %p before calling fetch', async (maxBytes) => {
    const fetch = jest.fn<
      ReturnType<OutboundHttpFetch>,
      Parameters<OutboundHttpFetch>
    >()
    const transport = new FetchOutboundHttpAttemptTransport(fetch)

    await expect(
      transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 1_000,
          responseBody: { type: 'buffer', maxBytes },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(RangeError)

    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    new Error('connection refused'),
    new DOMException('foreign cancellation', 'AbortError'),
  ])(
    'preserves a non-owned fetch rejection as transport_error',
    async (error) => {
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.reject(error),
      )

      const outcome = await transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 1_000,
          responseBody: { type: 'ignore' },
        },
        new AbortController().signal,
      )

      expect(outcome).toMatchObject({ type: 'transport_error', error })
      assertDuration(outcome)
    },
  )

  it('returns aborted without fetching when the caller is already aborted', async () => {
    const fetch = jest.fn<
      ReturnType<OutboundHttpFetch>,
      Parameters<OutboundHttpFetch>
    >()
    const caller = new AbortController()
    caller.abort(new Error('stop before admission'))
    const transport = new FetchOutboundHttpAttemptTransport(fetch)

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'ignore' },
      },
      caller.signal,
    )

    expect(outcome.type).toBe('aborted')
    assertDuration(outcome)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('settles as aborted promptly and consumes a late fetch rejection', async () => {
    const pending = deferred<Response>()
    const caller = new AbortController()
    let attemptSignal: AbortSignal | undefined
    const transport = new FetchOutboundHttpAttemptTransport((_input, init) => {
      attemptSignal = init?.signal ?? undefined
      return pending.promise
    })
    const lateError = new Error('late rejection after abort')

    const executing = transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 60_000,
        responseBody: { type: 'ignore' },
      },
      caller.signal,
    )
    let observed: OutboundHttpAttemptOutcome | undefined
    void executing.then((outcome) => {
      observed = outcome
    })
    await Promise.resolve()
    caller.abort(new Error('caller stopped'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    pending.reject(lateError)
    await executing

    expect(observed).toMatchObject({ type: 'aborted' })
    expect(attemptSignal?.aborted).toBe(true)
  })

  it('settles as timeout at the owned deadline and consumes a late fetch rejection', async () => {
    jest.useFakeTimers()
    const pending = deferred<Response>()
    try {
      let attemptSignal: AbortSignal | undefined
      const transport = new FetchOutboundHttpAttemptTransport(
        (_input, init) => {
          attemptSignal = init?.signal ?? undefined
          return pending.promise
        },
      )

      const executing = transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 50,
          responseBody: { type: 'ignore' },
        },
        new AbortController().signal,
      )
      let settled = false
      void executing.then(() => {
        settled = true
      })

      await jest.advanceTimersByTimeAsync(49)
      expect(settled).toBe(false)

      await jest.advanceTimersByTimeAsync(1)
      const observed = settled ? await executing : undefined

      expect(observed).toMatchObject({ type: 'timeout', durationMs: 50 })
      if (observed !== undefined) assertDuration(observed)
      expect(attemptSignal?.aborted).toBe(true)

      pending.reject(new Error('late rejection after timeout'))
      await executing
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      pending.resolve(new Response())
      jest.useRealTimers()
    }
  })

  it('cancels an ignored response body without acquiring a reader', async () => {
    const fixture = streamingResponse([Uint8Array.of(1, 2, 3)])
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(fixture.response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'ignore' },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'ignored' },
    })
    expect(fixture.cancel).toHaveBeenCalledTimes(1)
    expect(fixture.getReader).not.toHaveBeenCalled()
  })

  it('returns ignored when response-body cancellation rejects', async () => {
    const cancellationError = new Error('response cancellation rejected')
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (error: unknown): void => {
      unhandledRejections.push(error)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const fixture = streamingResponse([Uint8Array.of(1)])
      fixture.cancel.mockImplementation(() => Promise.reject(cancellationError))
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.resolve(fixture.response),
      )

      const outcome = await transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 1_000,
          responseBody: { type: 'ignore' },
        },
        new AbortController().signal,
      )
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(outcome).toMatchObject({
        type: 'response',
        body: { type: 'ignored' },
      })
      expect(unhandledRejections).not.toContain(cancellationError)
      expect(fixture.getReader).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('returns ignored without awaiting a never-settling cancellation', async () => {
    jest.useFakeTimers()
    const cancellation = deferred<void>()
    try {
      const fixture = streamingResponse([Uint8Array.of(1)])
      fixture.cancel.mockImplementation(() => cancellation.promise)
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.resolve(fixture.response),
      )
      const executing = transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 50,
          responseBody: { type: 'ignore' },
        },
        new AbortController().signal,
      )
      let observed: OutboundHttpAttemptOutcome | undefined
      void executing.then((outcome) => {
        observed = outcome
      })

      await jest.advanceTimersByTimeAsync(0)
      const outcomeWithoutAdvancingTimeout = observed
      const timersWithoutAdvancingTimeout = jest.getTimerCount()

      cancellation.resolve()
      await executing

      expect(outcomeWithoutAdvancingTimeout).toMatchObject({
        type: 'response',
        body: { type: 'ignored' },
      })
      expect(timersWithoutAdvancingTimeout).toBe(0)
      expect(fixture.getReader).not.toHaveBeenCalled()
    } finally {
      cancellation.resolve()
      jest.useRealTimers()
    }
  })

  it('buffers incremental chunks at the exact byte limit', async () => {
    const fixture = streamingResponse([
      Uint8Array.of(1, 2),
      Uint8Array.of(3, 4, 5),
    ])
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(fixture.response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'buffered', bytes: Uint8Array.of(1, 2, 3, 4, 5) },
    })
    expect(fixture.cancel).not.toHaveBeenCalled()
    expect(fixture.getReader).toHaveBeenCalledTimes(1)
  })

  it('buffers an empty stream when maxBytes is zero', async () => {
    const fixture = streamingResponse([])
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(fixture.response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 0 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'buffered', bytes: new Uint8Array() },
    })
    expect(fixture.cancel).not.toHaveBeenCalled()
  })

  it.each(['6', '999999999999999999999999999999999999999999'])(
    'short-circuits a valid Content-Length %s above the limit',
    async (contentLength) => {
      const fixture = streamingResponse([Uint8Array.of(1)], {
        headers: { 'content-length': contentLength },
        status: 206,
      })
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.resolve(fixture.response),
      )

      const outcome = await transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 1_000,
          responseBody: { type: 'buffer', maxBytes: 5 },
        },
        new AbortController().signal,
      )

      expect(outcome).toMatchObject({
        type: 'response',
        status: 206,
        headers: fixture.response.headers,
        body: { type: 'limit_exceeded', maxBytes: 5 },
      })
      expect(fixture.cancel).toHaveBeenCalledTimes(1)
      expect(fixture.getReader).not.toHaveBeenCalled()
      expect(outcome).not.toHaveProperty('body.bytes')
    },
  )

  it.each(['-1', '1.5', '1e3', '+6', 'six'])(
    'does not trust malformed Content-Length %s as an overflow proof',
    async (contentLength) => {
      const fixture = streamingResponse([Uint8Array.of(9)], {
        headers: { 'content-length': contentLength },
      })
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.resolve(fixture.response),
      )

      const outcome = await transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 1_000,
          responseBody: { type: 'buffer', maxBytes: 1 },
        },
        new AbortController().signal,
      )

      expect(outcome).toMatchObject({
        type: 'response',
        body: { type: 'buffered', bytes: Uint8Array.of(9) },
      })
      expect(fixture.getReader).toHaveBeenCalledTimes(1)
    },
  )

  it('allows Content-Length equal to maxBytes and verifies the body incrementally', async () => {
    const fixture = streamingResponse([Uint8Array.of(1, 2, 3)], {
      headers: { 'content-length': '3' },
    })
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(fixture.response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 3 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'buffered', bytes: Uint8Array.of(1, 2, 3) },
    })
    expect(fixture.getReader).toHaveBeenCalledTimes(1)
  })

  it('cancels on the first incremental overflow and returns no partial bytes', async () => {
    const fixture = streamingResponse([
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4, 5, 6),
      Uint8Array.of(7),
    ])
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(fixture.response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'limit_exceeded', maxBytes: 5 },
    })
    expect(outcome).not.toHaveProperty('body.bytes')
    expect(fixture.cancel).toHaveBeenCalledTimes(1)
  })

  it('applies the same cap to a non-stream response body', async () => {
    const response = new Response(Uint8Array.of(1, 2, 3, 4, 5, 6))
    Object.defineProperty(response, 'body', { configurable: true, value: null })
    const transport = new FetchOutboundHttpAttemptTransport(() =>
      Promise.resolve(response),
    )

    const outcome = await transport.execute(
      {
        input: 'https://example.test/resource',
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      body: { type: 'limit_exceeded', maxBytes: 5 },
    })
    expect(outcome).not.toHaveProperty('body.bytes')
  })

  it('keeps the timeout active through body reads and cancels without awaiting cleanup', async () => {
    jest.useFakeTimers()
    const cancellation = deferred<void>()
    try {
      const cancel = jest.fn(() => cancellation.promise)
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(Uint8Array.of(1))
        },
        cancel,
      })
      const getReader = jest.spyOn(stream, 'getReader')
      const transport = new FetchOutboundHttpAttemptTransport(() =>
        Promise.resolve(new Response(stream)),
      )

      const executing = transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 25,
          responseBody: { type: 'buffer', maxBytes: 10 },
        },
        new AbortController().signal,
      )
      let observed: OutboundHttpAttemptOutcome | undefined
      void executing.then((outcome) => {
        observed = outcome
      })

      await jest.advanceTimersByTimeAsync(0)
      expect(getReader).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(25)

      expect(observed).toMatchObject({ type: 'timeout', durationMs: 25 })
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      cancellation.resolve()
      await Promise.resolve()
      jest.useRealTimers()
    }
  })

  it('does not read a late response body after timeout and consumes cancellation rejection', async () => {
    jest.useFakeTimers()
    const pending = deferred<Response>()
    try {
      const transport = new FetchOutboundHttpAttemptTransport(
        () => pending.promise,
      )
      const executing = transport.execute(
        {
          input: 'https://example.test/resource',
          timeoutMs: 10,
          responseBody: { type: 'buffer', maxBytes: 10 },
        },
        new AbortController().signal,
      )

      await jest.advanceTimersByTimeAsync(10)
      await expect(executing).resolves.toMatchObject({ type: 'timeout' })

      const fixture = streamingResponse([Uint8Array.of(1)])
      fixture.cancel.mockImplementation(() =>
        Promise.reject(new Error('late cancellation failed')),
      )
      pending.resolve(fixture.response)
      await Promise.resolve()
      await Promise.resolve()

      expect(fixture.cancel).toHaveBeenCalledTimes(1)
      expect(fixture.getReader).not.toHaveBeenCalled()
    } finally {
      pending.reject(new Error('test cleanup'))
      jest.useRealTimers()
    }
  })
})
