import type {
  GetTodayQuery,
  TrackingTodayReadModelV1,
} from '@/modules/tracking'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace'

import { decodeTelegramCallback } from './telegram-callback.codec'
import type {
  NormalizedTelegramUpdate,
  PreparedTelegramUpdate,
  TelegramPreparedAttempt,
  TrustedTelegramPrincipal,
} from './telegram-bot.types'
import {
  renderMenu,
  renderProgress,
  renderToday,
  telegramMenu,
} from './telegram-today.renderer'

const privateOnly = 'Planner работает только в личном чате.'
const accessDenied = 'Доступ к Planner закрыт.'
const stale = 'Кнопка устарела. Открываю актуальное меню.'

function sendAttempts(
  chatId: bigint,
  messages: readonly string[],
  webLoginUrl: string,
): readonly TelegramPreparedAttempt[] {
  return Object.freeze(
    messages.map((text, index) =>
      Object.freeze({
        kind: 'send_message' as const,
        chatId,
        text,
        ...(index === messages.length - 1
          ? { replyMarkup: telegramMenu(webLoginUrl) }
          : {}),
      }),
    ),
  )
}

export class TelegramUpdateHandler {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly getToday: GetTodayQuery,
    private readonly webLoginUrl: string,
  ) {}

  public async prepare(
    update: NormalizedTelegramUpdate,
  ): Promise<PreparedTelegramUpdate> {
    if (update.kind === 'ignored') {
      return Object.freeze({ updateId: update.updateId, attempts: [] })
    }
    if (update.kind === 'rejected_callback') {
      return Object.freeze({
        updateId: update.updateId,
        attempts: Object.freeze([
          Object.freeze({
            kind: 'answer_callback' as const,
            callbackQueryId: update.callbackQueryId,
            text: accessDenied,
          }),
        ]),
      })
    }
    if (update.kind === 'non_private') {
      const answer =
        update.callbackQueryId === undefined
          ? []
          : [
              Object.freeze({
                kind: 'answer_callback' as const,
                callbackQueryId: update.callbackQueryId,
                text: privateOnly,
              }),
            ]
      return Object.freeze({
        updateId: update.updateId,
        attempts: Object.freeze([
          ...answer,
          ...sendAttempts(update.chatId, [privateOnly], this.webLoginUrl),
        ]),
      })
    }

    let principal: TrustedTelegramPrincipal
    try {
      principal = Object.freeze({
        telegramId: update.telegramId,
        member: await this.workspaceMembers.resolveTelegramId(
          update.telegramId,
        ),
      })
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceMemberNotFoundError)) throw error
      const answer =
        update.kind === 'private_callback' ||
        update.kind === 'private_callback_stale'
          ? [
              Object.freeze({
                kind: 'answer_callback' as const,
                callbackQueryId: update.callbackQueryId,
                text: accessDenied,
              }),
            ]
          : []
      return Object.freeze({
        updateId: update.updateId,
        attempts: Object.freeze([
          ...answer,
          ...sendAttempts(update.chatId, [accessDenied], this.webLoginUrl),
        ]),
      })
    }

    const action =
      update.kind === 'private_callback'
        ? decodeTelegramCallback(update.callbackData)
        : update.kind === 'private_callback_stale'
          ? 'stale'
          : this.messageAction(update.text)
    const answer =
      update.kind === 'private_callback' ||
      update.kind === 'private_callback_stale'
        ? [
            Object.freeze({
              kind: 'answer_callback' as const,
              callbackQueryId: update.callbackQueryId,
              ...(action === 'stale' ? { text: stale } : {}),
            }),
          ]
        : []
    if (action === 'stale') {
      return Object.freeze({
        updateId: update.updateId,
        attempts: Object.freeze([
          ...answer,
          ...sendAttempts(
            update.chatId,
            [stale, ...renderMenu()],
            this.webLoginUrl,
          ),
        ]),
      })
    }
    const messages =
      action === 'today'
        ? renderToday(await this.today(principal))
        : action === 'progress'
          ? renderProgress(await this.today(principal))
          : renderMenu()
    return Object.freeze({
      updateId: update.updateId,
      attempts: Object.freeze([
        ...answer,
        ...sendAttempts(update.chatId, messages, this.webLoginUrl),
      ]),
    })
  }

  private messageAction(text: string): 'menu' | 'today' | 'progress' {
    switch (text.trim()) {
      case 'Сегодня':
        return 'today'
      case 'Месяц':
      case 'Статистика':
        return 'progress'
      case '/start':
      case '/menu':
      default:
        return 'menu'
    }
  }

  private today(
    principal: TrustedTelegramPrincipal,
  ): Promise<TrackingTodayReadModelV1> {
    return this.getToday.execute({
      trustedActor: { kind: 'member', id: principal.member.memberId },
    })
  }
}
