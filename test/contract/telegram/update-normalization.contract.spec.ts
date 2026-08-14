import {
  TELEGRAM_CALLBACKS,
  TelegramBotApiClient,
  decodeTelegramCallback,
  encodeTelegramIntentCallback,
  normalizeTelegramUpdate,
} from '@/modules/telegram-bot'

describe('G01 Telegram update normalization contract', () => {
  it('exact-projects a private message while tolerating provider extensions', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 41,
        provider_extension: true,
        message: {
          text: '/start',
          chat: { id: 123, type: 'private', title: 'ignored' },
          from: { id: 123, is_bot: false, username: 'ignored' },
        },
      }),
    ).toEqual({
      kind: 'private_message',
      updateId: 41n,
      chatId: 123n,
      telegramId: 123n,
      text: '/start',
    })
  })

  it('separates non-private chat without trusting its sender', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 42,
        message: {
          chat: { id: -500, type: 'supergroup' },
          from: { id: 123, is_bot: false },
          text: '/start',
        },
      }),
    ).toEqual({ kind: 'non_private', updateId: 42n, chatId: -500n })
  })

  it('rejects mismatched private chat/from identity and bot senders', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 43,
        message: {
          chat: { id: 123, type: 'private' },
          from: { id: 124, is_bot: false },
          text: '/start',
        },
      }),
    ).toEqual({ kind: 'ignored', reason: 'malformed', updateId: 43n })
    expect(
      normalizeTelegramUpdate({
        update_id: 44,
        message: {
          chat: { id: 123, type: 'private' },
          from: { id: 123, is_bot: true },
          text: '/start',
        },
      }),
    ).toEqual({ kind: 'ignored', reason: 'malformed', updateId: 44n })
  })

  it('normalizes callback data within the Bot API UTF-8 byte limit', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 45,
        callback_query: {
          id: 'callback-1',
          data: TELEGRAM_CALLBACKS.today,
          from: { id: 123, is_bot: false },
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    ).toEqual({
      kind: 'private_callback',
      updateId: 45n,
      callbackQueryId: 'callback-1',
      callbackData: 'pl1:t',
      chatId: 123n,
      telegramId: 123n,
    })
    expect(
      normalizeTelegramUpdate({
        update_id: 46,
        callback_query: {
          id: 'callback-2',
          data: 'я'.repeat(33),
          from: { id: 123, is_bot: false },
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    ).toEqual({
      kind: 'private_callback_stale',
      updateId: 46n,
      callbackQueryId: 'callback-2',
      chatId: 123n,
      telegramId: 123n,
    })
  })

  it('retains a callback acknowledgement handle for unsafe chat identities', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 47,
        callback_query: {
          id: 'callback-group',
          data: TELEGRAM_CALLBACKS.today,
          from: { id: 123, is_bot: false },
          message: { chat: { id: -500, type: 'supergroup' } },
        },
      }),
    ).toEqual({
      kind: 'non_private',
      updateId: 47n,
      chatId: -500n,
      callbackQueryId: 'callback-group',
    })
    expect(
      normalizeTelegramUpdate({
        update_id: 48,
        callback_query: {
          id: 'callback-mismatch',
          data: TELEGRAM_CALLBACKS.today,
          from: { id: 124, is_bot: false },
          message: { chat: { id: 123, type: 'private' } },
        },
      }),
    ).toEqual({
      kind: 'rejected_callback',
      updateId: 48n,
      callbackQueryId: 'callback-mismatch',
    })
  })

  it('keeps callback schema finite and treats other versions as stale', () => {
    expect(decodeTelegramCallback('pl1:m')).toBe('menu')
    expect(decodeTelegramCallback('pl1:t')).toBe('today')
    expect(decodeTelegramCallback('pl1:p')).toBe('progress')
    expect(decodeTelegramCallback('pl2:t')).toBe('stale')
    expect(decodeTelegramCallback('pl1:a:unowned')).toBe('stale')
    const actionIntentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    expect(
      decodeTelegramCallback(
        encodeTelegramIntentCallback('select', actionIntentId),
      ),
    ).toEqual({ kind: 'select_intent', actionIntentId })
    expect(
      decodeTelegramCallback(
        encodeTelegramIntentCallback('confirm', actionIntentId),
      ),
    ).toEqual({ kind: 'confirm_intent', actionIntentId })
    expect(
      decodeTelegramCallback('pl1:s:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    ).toBe('stale')
    expect(
      Buffer.byteLength(
        encodeTelegramIntentCallback('confirm', actionIntentId),
        'utf8',
      ),
    ).toBeLessThanOrEqual(64)
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER, 1.5])(
    'rejects invalid update_id %s',
    (updateId) => {
      expect(() => normalizeTelegramUpdate({ update_id: updateId })).toThrow(
        'Telegram update identifier is invalid',
      )
    },
  )

  it('uses bounded exact getUpdates and acknowledges callbacks once', async () => {
    const requests: {
      readonly url: string
      readonly body: unknown
      readonly redirect: RequestInit['redirect']
    }[] = []
    const fetcher: typeof globalThis.fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (typeof init?.body !== 'string') {
        return Promise.reject(new Error('Expected a JSON request body'))
      }
      requests.push({
        url,
        body: JSON.parse(init.body) as unknown,
        redirect: init.redirect,
      })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: url.endsWith('/getUpdates') ? [] : true,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    }
    const client = new TelegramBotApiClient(
      '123456789:contract-test-token-value',
      { requestTimeoutMs: 100, responseBodyLimitBytes: 4_096 },
      fetcher,
    )
    await client.getUpdates({
      offset: 77n,
      timeoutSeconds: 25,
      signal: AbortSignal.timeout(100),
    })
    await client.answerCallbackQuery(
      { callbackQueryId: 'callback-1' },
      AbortSignal.timeout(100),
    )
    expect(requests[0]?.url.endsWith('/getUpdates')).toBe(true)
    expect(requests[1]?.url.endsWith('/answerCallbackQuery')).toBe(true)
    expect(requests.map((request) => request.redirect)).toEqual([
      'error',
      'error',
    ])
    expect(requests.map((request) => request.body)).toEqual([
      {
        offset: 77,
        limit: 100,
        timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      },
      { callback_query_id: 'callback-1' },
    ])
    expect(
      JSON.stringify(requests.map((request) => request.body)),
    ).not.toContain('contract-test-token-value')
  })

  it('forbids provider redirects without a second outbound request', async () => {
    const requests: RequestInit[] = []
    const fetcher: typeof globalThis.fetch = (_input, init) => {
      requests.push(init ?? {})
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 307,
          headers: {
            'content-type': 'application/json',
            location: 'https://redirect.invalid/collect',
          },
        }),
      )
    }
    const client = new TelegramBotApiClient(
      '123456789:redirect-test-token-value',
      { requestTimeoutMs: 100, responseBodyLimitBytes: 4_096 },
      fetcher,
    )
    await expect(
      client.getUpdates({
        offset: 0n,
        timeoutSeconds: 0,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow('Telegram Bot API request failed')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ redirect: 'error' })
  })
})
