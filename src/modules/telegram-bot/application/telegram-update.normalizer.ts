import type { NormalizedTelegramUpdate } from './telegram-bot.types'

const maxProviderInteger = 4_503_599_627_370_495
const maxCallbackBytes = 64

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function providerInteger(value: unknown): bigint | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= maxProviderInteger
    ? BigInt(value)
    : undefined
}

function positiveProviderInteger(value: unknown): bigint | undefined {
  const parsed = providerInteger(value)
  return parsed !== undefined && parsed > 0n ? parsed : undefined
}

function callbackString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes >= 1 && bytes <= maxCallbackBytes ? value : undefined
}

function privateIdentity(
  chat: Record<string, unknown>,
  from: Record<string, unknown>,
): { readonly chatId: bigint; readonly telegramId: bigint } | undefined {
  const chatId = positiveProviderInteger(chat['id'])
  const telegramId = positiveProviderInteger(from['id'])
  if (
    chat['type'] !== 'private' ||
    chatId === undefined ||
    telegramId === undefined ||
    chatId !== telegramId ||
    from['is_bot'] === true
  ) {
    return undefined
  }
  return { chatId, telegramId }
}

export function normalizeTelegramUpdate(
  value: unknown,
): NormalizedTelegramUpdate {
  const update = object(value)
  const updateId = positiveProviderInteger(update?.['update_id'])
  if (update === undefined || updateId === undefined) {
    throw new Error('Telegram update identifier is invalid')
  }

  const message = object(update['message'])
  if (message !== undefined) {
    const chat = object(message['chat'])
    if (chat === undefined) {
      return { kind: 'ignored', reason: 'malformed', updateId }
    }
    if (chat['type'] !== 'private') {
      const chatId = providerInteger(chat['id'])
      return chatId === undefined || chatId === 0n
        ? { kind: 'ignored', reason: 'malformed', updateId }
        : { kind: 'non_private', chatId, updateId }
    }
    const from = object(message['from'])
    const identity =
      from === undefined ? undefined : privateIdentity(chat, from)
    const text = message['text']
    return identity === undefined || typeof text !== 'string'
      ? { kind: 'ignored', reason: 'malformed', updateId }
      : { kind: 'private_message', ...identity, text, updateId }
  }

  const callback = object(update['callback_query'])
  if (callback !== undefined) {
    const callbackQueryId = callback['id']
    if (
      typeof callbackQueryId !== 'string' ||
      callbackQueryId.length < 1 ||
      callbackQueryId.length > 256
    ) {
      return { kind: 'ignored', reason: 'malformed', updateId }
    }
    const messageValue = object(callback['message'])
    const chat = object(messageValue?.['chat'])
    if (chat === undefined) {
      return { kind: 'rejected_callback', callbackQueryId, updateId }
    }
    if (chat['type'] !== 'private') {
      const chatId = providerInteger(chat['id'])
      return chatId === undefined || chatId === 0n
        ? { kind: 'rejected_callback', callbackQueryId, updateId }
        : { kind: 'non_private', chatId, callbackQueryId, updateId }
    }
    const from = object(callback['from'])
    const identity =
      from === undefined ? undefined : privateIdentity(chat, from)
    const callbackData = callbackString(callback['data'])
    if (identity === undefined) {
      return { kind: 'rejected_callback', callbackQueryId, updateId }
    }
    return callbackData === undefined
      ? {
          kind: 'private_callback_stale',
          ...identity,
          callbackQueryId,
          updateId,
        }
      : {
          kind: 'private_callback',
          ...identity,
          callbackQueryId,
          callbackData,
          updateId,
        }
  }

  return { kind: 'ignored', reason: 'unsupported', updateId }
}
