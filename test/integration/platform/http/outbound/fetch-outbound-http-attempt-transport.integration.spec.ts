import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import { FetchOutboundHttpAttemptTransport } from '@/platform/http/outbound/fetch-outbound-http-attempt-transport'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface StreamOverflowGate {
  readonly started: Deferred<void>
  readonly release: Deferred<void>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const sockets = new Set<Socket>()
const earlyCloseWaiters = new Map<string, Array<Deferred<void>>>()

let server: Server
let baseUrl: string
let streamOverflowGate: StreamOverflowGate | undefined

function expectEarlyClientClose(path: string): Promise<void> {
  const waiter = deferred<void>()
  const waiters = earlyCloseWaiters.get(path) ?? []
  waiters.push(waiter)
  earlyCloseWaiters.set(path, waiters)
  return waiter.promise
}

function observeEarlyClientClose(path: string, response: ServerResponse): void {
  response.once('close', () => {
    if (response.writableEnded) return
    earlyCloseWaiters.get(path)?.shift()?.resolve()
  })
}

function prepareStreamOverflow(): StreamOverflowGate {
  const gate = { started: deferred<void>(), release: deferred<void>() }
  streamOverflowGate = gate
  return gate
}

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function handleRequest(path: string, response: ServerResponse): void {
  if (path === '/small') {
    const bytes = Uint8Array.of(1, 2, 3, 4)
    response.writeHead(206, {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
      'x-loopback': 'small',
    })
    response.end(bytes)
    return
  }

  if (path === '/declared-overflow') {
    observeEarlyClientClose(path, response)
    response.writeHead(200, {
      'content-length': '1024',
      'content-type': 'application/octet-stream',
    })
    response.flushHeaders()
    response.write(Uint8Array.of(1))
    return
  }

  if (path === '/stream-overflow') {
    const gate = streamOverflowGate
    if (gate === undefined) {
      response.writeHead(500)
      response.end()
      return
    }
    observeEarlyClientClose(path, response)
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.flushHeaders()
    response.write(Uint8Array.of(1, 2, 3))
    gate.started.resolve()
    void gate.release.promise.then(() => {
      if (!response.destroyed) response.write(Uint8Array.of(4, 5, 6))
    })
    return
  }

  if (path === '/held-body') {
    observeEarlyClientClose(path, response)
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.flushHeaders()
    response.write(Uint8Array.of(7))
    return
  }

  if (path === '/provider-policy') {
    const bytes = Uint8Array.of(9, 8)
    response.writeHead(418, {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
    })
    response.end(bytes)
    return
  }

  response.writeHead(404)
  response.end()
}

beforeAll(async () => {
  server = createServer((request, response) => {
    handleRequest(request.url ?? '/', response)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Loopback server did not expose a TCP address')
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(() => {
  streamOverflowGate?.release.resolve()
  streamOverflowGate = undefined
  earlyCloseWaiters.clear()
})

afterAll(async () => {
  if (!server.listening) {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    return
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
  server.closeAllConnections()
  for (const socket of sockets) socket.destroy()
  await closed
  sockets.clear()
})

describe('FetchOutboundHttpAttemptTransport native fetch loopback', () => {
  it('buffers a small native response with status and real Headers', async () => {
    const transport = new FetchOutboundHttpAttemptTransport()

    const outcome = await transport.execute(
      {
        input: `${baseUrl}/small`,
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 4 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      status: 206,
      body: { type: 'buffered', bytes: Uint8Array.of(1, 2, 3, 4) },
    })
    if (outcome.type !== 'response') throw new Error('Expected a response')
    expect(outcome.headers).toBeInstanceOf(Headers)
    expect(outcome.headers.get('x-loopback')).toBe('small')
  })

  it('short-circuits Content-Length overflow and closes the native response', async () => {
    const closed = expectEarlyClientClose('/declared-overflow')
    const transport = new FetchOutboundHttpAttemptTransport()

    const outcome = await transport.execute(
      {
        input: `${baseUrl}/declared-overflow`,
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      type: 'response',
      status: 200,
      body: { type: 'limit_exceeded', maxBytes: 5 },
    })
    expect(outcome).not.toHaveProperty('body.bytes')
    await bounded(closed, 'Content-Length cancellation')
  })

  it('cancels a chunked native response on the first incremental overflow', async () => {
    const closed = expectEarlyClientClose('/stream-overflow')
    const gate = prepareStreamOverflow()
    const transport = new FetchOutboundHttpAttemptTransport()

    const executing = transport.execute(
      {
        input: `${baseUrl}/stream-overflow`,
        timeoutMs: 1_000,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )
    await bounded(gate.started.promise, 'first stream chunk')
    gate.release.resolve()
    const outcome = await executing

    expect(outcome).toMatchObject({
      type: 'response',
      status: 200,
      body: { type: 'limit_exceeded', maxBytes: 5 },
    })
    expect(outcome).not.toHaveProperty('body.bytes')
    await bounded(closed, 'stream overflow cancellation')
  })

  it('keeps the attempt timeout active after headers and through the held body', async () => {
    const closed = expectEarlyClientClose('/held-body')
    const transport = new FetchOutboundHttpAttemptTransport()

    const outcome = await transport.execute(
      {
        input: `${baseUrl}/held-body`,
        timeoutMs: 30,
        responseBody: { type: 'buffer', maxBytes: 5 },
      },
      new AbortController().signal,
    )

    expect(outcome.type).toBe('timeout')
    expect(Number.isFinite(outcome.durationMs)).toBe(true)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    await bounded(closed, 'body timeout cancellation')
  })
})
