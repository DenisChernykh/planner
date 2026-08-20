import { FetchOutboundHttpAttemptTransport } from '@/platform/http/outbound/fetch-outbound-http-attempt-transport'
import type {
  ReminderDeliveryTransportPort,
  TelegramAttemptOutcome,
} from '@/modules/reminders/application/reminder.types'

type TelegramFetch = typeof globalThis.fetch

type TelegramEnvelope = {
  readonly ok: boolean
  readonly errorCode?: number
  readonly description?: string
  readonly retryAfterSeconds?: number
}

const MAX_TEXT_LENGTH = 4_096
const MAX_RESPONSE_BYTES = 1_048_576

function validRetryAfter(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  )
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseEnvelope(bytes: Uint8Array): TelegramEnvelope | undefined {
  try {
    const value = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
    if (value === undefined || typeof value['ok'] !== 'boolean')
      return undefined
    const parameters = object(value['parameters'])
    const retryAfter = parameters?.['retry_after']
    return {
      ok: value['ok'],
      ...(typeof value['error_code'] === 'number'
        ? { errorCode: value['error_code'] }
        : {}),
      ...(typeof value['description'] === 'string'
        ? { description: value['description'] }
        : {}),
      ...(validRetryAfter(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
    }
  } catch {
    return undefined
  }
}

function isJsonResponse(headers: Headers): boolean {
  const contentType = headers.get('content-type')
  if (contentType === null) return false
  return (
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  )
}

function terminalReason(
  description: string | undefined,
): Extract<TelegramAttemptOutcome, { readonly kind: 'terminal' }>['reason'] {
  const normalized = description?.toLowerCase() ?? ''
  if (normalized.includes('chat not found')) return 'chat_not_found'
  if (
    normalized.includes('bot was blocked') ||
    normalized.includes('user is deactivated') ||
    normalized.includes('bot was kicked')
  ) {
    return 'blocked'
  }
  return 'provider_rejected'
}

export class TelegramOutboundTransport implements ReminderDeliveryTransportPort {
  private readonly endpoint: string
  private readonly transport: FetchOutboundHttpAttemptTransport

  public constructor(
    token: string,
    private readonly config: {
      readonly requestTimeoutMs: number
      readonly responseBodyLimitBytes?: number
    },
    fetcher: TelegramFetch = globalThis.fetch,
  ) {
    if (token.length < 20 || token.length > 256) {
      throw new Error('Telegram Bot API token rejected')
    }
    this.endpoint = `https://api.telegram.org/bot${token}/sendMessage`
    this.transport = new FetchOutboundHttpAttemptTransport(fetcher)
  }

  public async send(input: {
    readonly chatId: bigint
    readonly text: string
    readonly signal: AbortSignal
  }): Promise<TelegramAttemptOutcome> {
    if (input.chatId <= 0n || input.text.length < 1) {
      return { kind: 'terminal', reason: 'provider_rejected' }
    }
    if (input.text.length > MAX_TEXT_LENGTH) {
      return { kind: 'terminal', reason: 'provider_rejected' }
    }

    const outcome = await this.transport.execute(
      {
        input: this.endpoint,
        init: {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: input.chatId.toString(),
            text: input.text,
          }),
        },
        timeoutMs: this.config.requestTimeoutMs,
        responseBody: {
          type: 'buffer',
          maxBytes: this.config.responseBodyLimitBytes ?? MAX_RESPONSE_BYTES,
        },
      },
      input.signal,
    )

    if (outcome.type === 'timeout') {
      return { kind: 'ambiguous', reason: 'timeout' }
    }
    if (outcome.type === 'aborted') {
      return { kind: 'ambiguous', reason: 'aborted' }
    }
    if (outcome.type === 'transport_error') {
      return { kind: 'ambiguous', reason: 'transport_error' }
    }
    if (outcome.body.type === 'limit_exceeded') {
      if (outcome.status === 429) {
        return {
          kind: 'retryable',
          reason: 'rate_limited',
          retryAfterSeconds: null,
        }
      }
      return outcome.status >= 500
        ? {
            kind: 'retryable',
            reason: 'provider_error',
            retryAfterSeconds: null,
          }
        : { kind: 'ambiguous', reason: 'oversized_response' }
    }

    const envelope =
      outcome.body.type === 'buffered'
        ? parseEnvelope(outcome.body.bytes)
        : undefined
    if (outcome.status === 429) {
      return {
        kind: 'retryable',
        reason: 'rate_limited',
        retryAfterSeconds: envelope?.retryAfterSeconds ?? null,
      }
    }
    if (outcome.status >= 500) {
      return {
        kind: 'retryable',
        reason: 'provider_error',
        retryAfterSeconds: null,
      }
    }
    if (!isJsonResponse(outcome.headers) || envelope === undefined) {
      return { kind: 'ambiguous', reason: 'malformed_response' }
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      return { kind: 'terminal', reason: terminalReason(envelope.description) }
    }
    if (envelope.ok) return { kind: 'accepted' }
    return {
      kind: 'terminal',
      reason: terminalReason(envelope.description),
    }
  }
}
