import type {
  GetTodayQuery,
  TrackingTodayReadModelV1,
} from '@/modules/tracking'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace'

import { decodeTelegramCallback } from './telegram-callback.codec'
import type { TelegramActionIntentService } from './action-intent.service'
import type {
  TelegramActionButton,
  TelegramIntentOutcome,
} from './action-intent.types'
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
  telegramConfirmation,
  telegramIntentPreviewText,
  telegramMenu,
} from './telegram-today.renderer'

const privateOnly = 'Planner работает только в личном чате.'
const accessDenied = 'Доступ к Planner закрыт.'
const stale = 'Кнопка устарела. Открываю актуальное меню.'

type ActionIntentOperations = Pick<
  TelegramActionIntentService,
  'offerTodayActions' | 'select' | 'acceptValue' | 'confirm'
>

const disabledActionIntents: ActionIntentOperations = {
  offerTodayActions: () => Promise.resolve(Object.freeze([])),
  select: () => Promise.resolve({ kind: 'not_found' }),
  acceptValue: () => Promise.resolve(null),
  confirm: () => Promise.resolve({ kind: 'not_found' }),
}

function sendAttempts(
  chatId: bigint,
  messages: readonly string[],
  webLoginUrl: string,
  actions: readonly TelegramActionButton[] = [],
): readonly TelegramPreparedAttempt[] {
  return Object.freeze(
    messages.map((text, index) =>
      Object.freeze({
        kind: 'send_message' as const,
        chatId,
        text,
        ...(index === messages.length - 1
          ? { replyMarkup: telegramMenu(webLoginUrl, actions) }
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
    private readonly actionIntents: ActionIntentOperations = disabledActionIntents,
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
    if (typeof action === 'object') {
      const outcome =
        action.kind === 'select_intent'
          ? await this.actionIntents.select(
              principal.member,
              action.actionIntentId,
            )
          : await this.actionIntents.confirm(
              principal.member,
              action.actionIntentId,
            )
      return Object.freeze({
        updateId: update.updateId,
        attempts: Object.freeze([
          ...answer,
          ...this.intentAttempts(update.chatId, outcome),
        ]),
      })
    }
    if (update.kind === 'private_message') {
      const value = await this.actionIntents.acceptValue(
        principal.member,
        update.text,
      )
      if (value !== null) {
        return Object.freeze({
          updateId: update.updateId,
          attempts: this.intentAttempts(update.chatId, value),
        })
      }
    }
    const today =
      action === 'today' || action === 'progress'
        ? await this.today(principal)
        : null
    const actions =
      action === 'today' && today !== null
        ? await this.actionIntents.offerTodayActions(principal.member, today)
        : []
    const messages =
      action === 'today' && today !== null
        ? renderToday(today)
        : action === 'progress'
          ? renderProgress(today!)
          : renderMenu()
    return Object.freeze({
      updateId: update.updateId,
      attempts: Object.freeze([
        ...answer,
        ...sendAttempts(update.chatId, messages, this.webLoginUrl, actions),
      ]),
    })
  }

  private intentAttempts(
    chatId: bigint,
    outcome: TelegramIntentOutcome,
  ): readonly TelegramPreparedAttempt[] {
    const text = (() => {
      switch (outcome.kind) {
        case 'not_found':
        case 'expired':
          return 'Действие устарело. Откройте «Сегодня» ещё раз.'
        case 'awaiting_quantity':
          return `${outcome.title}\n\nВведите неотрицательное число.`
        case 'invalid_quantity':
          return `${outcome.title}\n\nЗначение некорректно. Введите число с допустимой точностью.`
        case 'awaiting_text':
          return `${outcome.title}\n\nВведите непустой текст.`
        case 'invalid_text':
          return `${outcome.title}\n\nТекст пустой или слишком длинный для подтверждения. Повторите ввод.`
        case 'awaiting_or_variant':
          return `${outcome.title}\n\nВведите неотрицательное число с допустимой точностью.`
        case 'invalid_or_variant':
          return `${outcome.title}\n\nЗначение некорректно. Введите число с допустимой точностью.`
        case 'awaiting_scalar':
          return outcome.inputKind === 'actual_time'
            ? `${outcome.title}\n\nВведите время в формате ЧЧ:ММ.`
            : `${outcome.title}\n\nВведите целую оценку.`
        case 'invalid_scalar':
          return outcome.inputKind === 'actual_time'
            ? `${outcome.title}\n\nВремя некорректно. Используйте формат ЧЧ:ММ.`
            : `${outcome.title}\n\nОценка должна быть целым безопасным числом.`
        case 'preview': {
          return telegramIntentPreviewText(outcome)
        }
        case 'completed':
          return `${outcome.title}\n\nСохранено.`
        case 'stale':
          return 'Состояние изменилось. Откройте «Сегодня» ещё раз.'
        case 'blocked':
          return 'Сохранение недоступно для текущего состояния плана.'
        case 'dependency_unavailable':
          return 'Planner временно недоступен. Попробуйте позже.'
      }
    })()
    return Object.freeze([
      Object.freeze({
        kind: 'send_message' as const,
        chatId,
        text,
        replyMarkup:
          outcome.kind === 'preview'
            ? telegramConfirmation(outcome.actionIntentId, this.webLoginUrl)
            : telegramMenu(this.webLoginUrl),
      }),
    ])
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
