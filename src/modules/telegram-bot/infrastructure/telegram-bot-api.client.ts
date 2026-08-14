import type {
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from 'node:stream/web'

import type {
  TelegramBotApiPort,
  TelegramSendMessage,
} from '../application/telegram-bot.types'

type TelegramFetch = typeof globalThis.fetch

type ApiEnvelope = {
  readonly ok: boolean
  readonly result?: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function readBoundedBody(
  response: Response,
  limit: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > limit)
  ) {
    throw new Error('Telegram Bot API body rejected')
  }
  if (response.body === null) return ''
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error('Telegram Bot API body rejected')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  )
}

function envelope(value: unknown): ApiEnvelope {
  const candidate = object(value)
  if (candidate === undefined || typeof candidate['ok'] !== 'boolean') {
    throw new Error('Telegram Bot API response rejected')
  }
  return { ok: candidate['ok'], result: candidate['result'] }
}

export class TelegramBotApiClient implements TelegramBotApiPort {
  private readonly endpoint: string

  public constructor(
    token: string,
    private readonly config: {
      readonly requestTimeoutMs: number
      readonly responseBodyLimitBytes: number
    },
    private readonly fetcher: TelegramFetch = globalThis.fetch,
  ) {
    if (token.length < 20 || token.length > 256) {
      throw new Error('Telegram Bot API token rejected')
    }
    this.endpoint = `https://api.telegram.org/bot${token}/`
  }

  public async getUpdates(input: {
    readonly offset: bigint
    readonly timeoutSeconds: number
    readonly signal: AbortSignal
  }): Promise<readonly unknown[]> {
    const result = await this.request(
      'getUpdates',
      {
        offset: Number(input.offset),
        limit: 100,
        timeout: input.timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      input.signal,
      this.config.requestTimeoutMs + input.timeoutSeconds * 1_000,
    )
    if (!Array.isArray(result) || result.length > 100) {
      throw new Error('Telegram Bot API update batch rejected')
    }
    return Object.freeze(Array.from(result as Iterable<unknown>))
  }

  public async sendMessage(
    input: TelegramSendMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (input.text.length < 1 || input.text.length > 4_096) {
      throw new Error('Telegram message rejected')
    }
    await this.request(
      'sendMessage',
      {
        chat_id: input.chatId.toString(),
        text: input.text,
        ...(input.replyMarkup === undefined
          ? {}
          : { reply_markup: input.replyMarkup }),
      },
      signal,
      this.config.requestTimeoutMs,
    )
  }

  public async answerCallbackQuery(
    input: { readonly callbackQueryId: string; readonly text?: string },
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      'answerCallbackQuery',
      {
        callback_query_id: input.callbackQueryId,
        ...(input.text === undefined ? {} : { text: input.text }),
      },
      signal,
      this.config.requestTimeoutMs,
    )
  }

  private async request(
    method: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await this.fetcher(`${this.endpoint}${method}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    const mediaType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (mediaType !== 'application/json') {
      throw new Error('Telegram Bot API media type rejected')
    }
    const value = envelope(
      JSON.parse(
        await readBoundedBody(response, this.config.responseBodyLimitBytes),
      ) as unknown,
    )
    if (!response.ok || !value.ok) {
      throw new Error('Telegram Bot API request failed')
    }
    return value.result
  }
}
