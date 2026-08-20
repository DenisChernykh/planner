import { TelegramOutboundTransport } from '@/modules/telegram-bot/infrastructure/telegram-outbound.transport'

const token = '12345678901234567890'
const chatId = 123456789n

function response(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Telegram outbound transport contract', () => {
  it('maps accepted responses and keeps the request bounded', async () => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>
    fetcher.mockResolvedValue(response(200, '{"ok":true,"result":{}}'))
    const transport = new TelegramOutboundTransport(
      token,
      {
        requestTimeoutMs: 100,
      },
      fetcher,
    )

    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'accepted' })
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
      }),
    )
  })

  it('maps retry-after, provider errors and terminal chat failures', async () => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>
    fetcher
      .mockResolvedValueOnce(
        response(429, '{"ok":false,"parameters":{"retry_after":7}}'),
      )
      .mockResolvedValueOnce(response(503, '{"ok":false}'))
      .mockResolvedValueOnce(
        response(
          403,
          '{"ok":false,"description":"Forbidden: bot was blocked by the user"}',
        ),
      )
      .mockResolvedValueOnce(
        response(
          400,
          '{"ok":false,"description":"Bad Request: chat not found"}',
        ),
      )
    const transport = new TelegramOutboundTransport(
      token,
      {
        requestTimeoutMs: 100,
      },
      fetcher,
    )
    const input = {
      chatId,
      text: 'hello',
      signal: new AbortController().signal,
    }

    await expect(transport.send(input)).resolves.toEqual({
      kind: 'retryable',
      reason: 'rate_limited',
      retryAfterSeconds: 7,
    })
    await expect(transport.send(input)).resolves.toEqual({
      kind: 'retryable',
      reason: 'provider_error',
      retryAfterSeconds: null,
    })
    await expect(transport.send(input)).resolves.toEqual({
      kind: 'terminal',
      reason: 'blocked',
    })
    await expect(transport.send(input)).resolves.toEqual({
      kind: 'terminal',
      reason: 'chat_not_found',
    })
  })

  it('keeps malformed rate-limit responses retryable without a delay', async () => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>
    fetcher.mockResolvedValue(response(429, 'not-json'))
    const transport = new TelegramOutboundTransport(
      token,
      { requestTimeoutMs: 100 },
      fetcher,
    )

    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'retryable',
      reason: 'rate_limited',
      retryAfterSeconds: null,
    })
  })

  it('keeps oversized rate-limit responses retryable without a delay', async () => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>
    fetcher.mockResolvedValue(response(429, '12345678901234567'))
    const transport = new TelegramOutboundTransport(
      token,
      { requestTimeoutMs: 100, responseBodyLimitBytes: 16 },
      fetcher,
    )

    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'retryable',
      reason: 'rate_limited',
      retryAfterSeconds: null,
    })
  })

  it('fails closed for ambiguous timeout, malformed and oversized responses', async () => {
    const fetcher = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>
    fetcher
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(response(200, 'not-json'))
      .mockResolvedValueOnce(response(200, '12345678901234567'))
    const transport = new TelegramOutboundTransport(
      token,
      {
        requestTimeoutMs: 5,
        responseBodyLimitBytes: 16,
      },
      fetcher,
    )

    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'ambiguous', reason: 'timeout' })
    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'ambiguous', reason: 'malformed_response' })
    await expect(
      transport.send({
        chatId,
        text: 'hello',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'ambiguous', reason: 'oversized_response' })
  })
})
