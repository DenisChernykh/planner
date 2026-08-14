import {
  TELEGRAM_CALLBACKS,
  type TelegramCallbackAction,
} from './telegram-bot.types'

export function decodeTelegramCallback(
  value: string,
): TelegramCallbackAction | 'stale' {
  const entry = Object.entries(TELEGRAM_CALLBACKS).find(
    ([, encoded]) => encoded === value,
  )
  return entry === undefined ? 'stale' : (entry[0] as TelegramCallbackAction)
}
