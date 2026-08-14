import type { MemberContext } from '@/modules/workspace'

export const TELEGRAM_CALLBACKS = Object.freeze({
  menu: 'pl1:m',
  today: 'pl1:t',
  progress: 'pl1:p',
})

export type TelegramCallbackAction = keyof typeof TELEGRAM_CALLBACKS

type TelegramUpdateBase = {
  readonly updateId: bigint
}

export type NormalizedTelegramUpdate =
  | (TelegramUpdateBase & {
      readonly kind: 'ignored'
      readonly reason: 'unsupported' | 'malformed'
    })
  | (TelegramUpdateBase & {
      readonly kind: 'non_private'
      readonly chatId: bigint
      readonly callbackQueryId?: string
    })
  | (TelegramUpdateBase & {
      readonly kind: 'rejected_callback'
      readonly callbackQueryId: string
    })
  | (TelegramUpdateBase & {
      readonly kind: 'private_message'
      readonly chatId: bigint
      readonly telegramId: bigint
      readonly text: string
    })
  | (TelegramUpdateBase & {
      readonly kind: 'private_callback'
      readonly callbackQueryId: string
      readonly chatId: bigint
      readonly telegramId: bigint
      readonly callbackData: string
    })
  | (TelegramUpdateBase & {
      readonly kind: 'private_callback_stale'
      readonly callbackQueryId: string
      readonly chatId: bigint
      readonly telegramId: bigint
    })

export type TrustedTelegramPrincipal = {
  readonly telegramId: bigint
  readonly member: MemberContext
}

export type TelegramInlineButton =
  | { readonly text: string; readonly callback_data: string }
  | { readonly text: string; readonly url: string }

export type TelegramInlineKeyboard = {
  readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[]
}

export type TelegramSendMessage = {
  readonly chatId: bigint
  readonly text: string
  readonly replyMarkup?: TelegramInlineKeyboard
}

export type TelegramPreparedAttempt =
  | {
      readonly kind: 'answer_callback'
      readonly callbackQueryId: string
      readonly text?: string
    }
  | ({ readonly kind: 'send_message' } & TelegramSendMessage)

export type PreparedTelegramUpdate = {
  readonly updateId: bigint
  readonly attempts: readonly TelegramPreparedAttempt[]
}

export interface TelegramIngressStatePort {
  getNextUpdateId(): Promise<bigint>
  claim(updateId: bigint): Promise<boolean>
}

export interface TelegramBotApiPort {
  getUpdates(input: {
    readonly offset: bigint
    readonly timeoutSeconds: number
    readonly signal: AbortSignal
  }): Promise<readonly unknown[]>
  sendMessage(input: TelegramSendMessage, signal: AbortSignal): Promise<void>
  answerCallbackQuery(
    input: { readonly callbackQueryId: string; readonly text?: string },
    signal: AbortSignal,
  ): Promise<void>
}

export interface TelegramIngressLifecycle {
  start(signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
}

export const TELEGRAM_BOT_API: unique symbol = Symbol('TELEGRAM_BOT_API')
export const TELEGRAM_INGRESS_LIFECYCLE: unique symbol = Symbol(
  'TELEGRAM_INGRESS_LIFECYCLE',
)
