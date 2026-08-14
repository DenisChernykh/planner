import {
  TELEGRAM_CALLBACKS,
  type DecodedTelegramCallback,
} from './telegram-bot.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function decodeTelegramCallback(value: string): DecodedTelegramCallback {
  const entry = Object.entries(TELEGRAM_CALLBACKS).find(
    ([, encoded]) => encoded === value,
  )
  if (entry !== undefined) return entry[0] as keyof typeof TELEGRAM_CALLBACKS
  const match = /^pl1:([sc]):(.+)$/u.exec(value)
  if (match === null || !UUID.test(match[2] ?? '')) return 'stale'
  return {
    kind: match[1] === 's' ? 'select_intent' : 'confirm_intent',
    actionIntentId: match[2]!,
  }
}

export function encodeTelegramIntentCallback(
  action: 'select' | 'confirm',
  actionIntentId: string,
): string {
  if (!UUID.test(actionIntentId)) {
    throw new Error('Telegram action intent identifier is invalid')
  }
  return `pl1:${action === 'select' ? 's' : 'c'}:${actionIntentId}`
}
