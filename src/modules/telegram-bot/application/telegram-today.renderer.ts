import type {
  TrackingDayGoalV1,
  TrackingGoalReadV1,
  TrackingTodayReadModelV1,
} from '@/modules/tracking'
import type { GoalProgressResult } from '@/modules/progress'

import {
  TELEGRAM_CALLBACKS,
  type TelegramInlineKeyboard,
} from './telegram-bot.types'
import type { TelegramActionButton } from './action-intent.types'
import { encodeTelegramIntentCallback } from './telegram-callback.codec'

const messageLimit = 4_000

const dayStateLabels = Object.freeze({
  future: 'ещё не наступило',
  not_applicable: 'не применяется',
  no_data: 'нет данных',
  partial: 'частично',
  filled: 'заполнено',
})
const expectationStateLabels = Object.freeze({
  no_data: 'нет данных',
  partial: 'частично',
  done: 'выполнено',
  not_done: 'не выполнено',
})

function metric(progress: GoalProgressResult): string {
  const value = progress.progress
  if (!value.available) {
    return value.reason === 'informational' ? 'информационная' : 'нет нормы'
  }
  const basisPoints = BigInt(value.basisPoints)
  const whole = basisPoints / 100n
  const fraction = (basisPoints % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}%`
}

function chunks(lines: readonly string[]): readonly string[] {
  const result: string[] = []
  let current = ''
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > messageLimit) {
      throw new Error('Telegram rendered line exceeds the message limit')
    }
    const next = current === '' ? line : `${current}\n${line}`
    if (next.length <= messageLimit) {
      current = next
      continue
    }
    result.push(current)
    current = line
  }
  if (current !== '') result.push(current)
  return Object.freeze(result)
}

export function telegramMenu(
  webLoginUrl: string,
  actions: readonly TelegramActionButton[] = [],
): TelegramInlineKeyboard {
  return Object.freeze({
    inline_keyboard: Object.freeze([
      ...actions.map((action) =>
        Object.freeze([
          Object.freeze({
            text: action.text,
            callback_data: encodeTelegramIntentCallback(
              'select',
              action.actionIntentId,
            ),
          }),
        ]),
      ),
      Object.freeze([
        Object.freeze({
          text: 'Сегодня',
          callback_data: TELEGRAM_CALLBACKS.today,
        }),
      ]),
      Object.freeze([
        Object.freeze({
          text: 'Месяц',
          callback_data: TELEGRAM_CALLBACKS.progress,
        }),
        Object.freeze({
          text: 'Статистика',
          callback_data: TELEGRAM_CALLBACKS.progress,
        }),
      ]),
      Object.freeze([
        Object.freeze({ text: 'План', url: webLoginUrl }),
        Object.freeze({ text: 'Настройки', url: webLoginUrl }),
      ]),
    ]),
  })
}

export function telegramConfirmation(
  actionIntentId: string,
  webLoginUrl: string,
): TelegramInlineKeyboard {
  const menu = telegramMenu(webLoginUrl)
  return Object.freeze({
    inline_keyboard: Object.freeze([
      Object.freeze([
        Object.freeze({
          text: 'Подтвердить',
          callback_data: encodeTelegramIntentCallback(
            'confirm',
            actionIntentId,
          ),
        }),
      ]),
      ...menu.inline_keyboard,
    ]),
  })
}

export function renderMenu(): readonly string[] {
  return Object.freeze([
    'Planner\n\nВыберите действие. Создание и настройка плана доступны в вебе.',
  ])
}

function unavailableLines(
  model: TrackingTodayReadModelV1,
  title: 'Сегодня' | 'Прогресс',
): readonly string[] {
  if (model.state === 'no_plan') {
    return Object.freeze([
      title,
      '',
      'На текущий месяц плана нет. Создайте и опубликуйте его в вебе.',
    ])
  }
  if (model.state === 'draft') {
    return Object.freeze([
      title,
      '',
      `Фокус: ${model.focus}`,
      'План пока остаётся черновиком. Опубликуйте его в вебе.',
    ])
  }
  return Object.freeze([])
}

function visibleGoals(
  model: Extract<TrackingTodayReadModelV1, { readonly state: 'published' }>,
): readonly {
  readonly goal: TrackingGoalReadV1
  readonly day: TrackingDayGoalV1
}[] {
  const days = new Map(
    model.day.goals.map((goal) => [goal.planGoalSnapshotId, goal]),
  )
  return Object.freeze(
    model.goals.flatMap((goal) => {
      const day = days.get(goal.planGoalSnapshotId)
      return goal.viewerAccess === 'partner_read_only' || day === undefined
        ? []
        : [{ goal, day }]
    }),
  )
}

export function renderToday(
  model: TrackingTodayReadModelV1,
): readonly string[] {
  if (model.state !== 'published')
    return chunks(unavailableLines(model, 'Сегодня'))
  if (model.phase === 'future' || model.day.state === 'future') {
    return chunks([
      `Сегодня · ${model.queryLocalDate}`,
      '',
      `Фокус: ${model.focus}`,
      `План начнёт действовать ${model.activeLocalDate}.`,
    ])
  }
  const lines: string[] = [
    `Сегодня · ${model.queryLocalDate}`,
    '',
    `Фокус: ${model.focus}`,
    `Статус дня: ${dayStateLabels[model.day.state]}`,
    '',
  ]
  const goals = visibleGoals(model)
  if (goals.length === 0) lines.push('На сегодня применимых действий нет.')
  for (const { goal, day } of goals) {
    const access = goal.viewerAccess === 'shared' ? 'общее' : 'личное'
    lines.push(
      `• ${goal.title} — ${dayStateLabels[day.state]}, ${metric(day.progress)} (${access})`,
    )
    for (const expectation of day.fixedExpectations) {
      const label =
        expectation.componentKind === 'goal'
          ? 'основное ожидание'
          : expectation.componentKind === 'checkpoint'
            ? 'этап'
            : 'пункт списка'
      lines.push(`  ↳ ${label}: ${expectationStateLabels[expectation.state]}`)
    }
    for (const period of day.flexiblePeriods.filter(
      (value) => value.eligibleOnDate,
    )) {
      const actual = period.actualProgress
      const actualValue =
        actual === null
          ? 'нет данных'
          : actual.denominator === '1'
            ? actual.numerator
            : `${actual.numerator}/${actual.denominator}`
      const label =
        period.periodKind === 'weekly_planned_task'
          ? 'задача недели'
          : period.periodKind === 'weekly'
            ? 'неделя'
            : 'месяц'
      const expected =
        period.expectedProgress === null
          ? ''
          : `, план к дате ${period.expectedProgress}`
      lines.push(
        `  ↳ ${label}: факт ${actualValue}${expected}, цель периода ${period.periodTarget}`,
      )
    }
  }
  return chunks(lines)
}

export function renderProgress(
  model: TrackingTodayReadModelV1,
): readonly string[] {
  if (model.state !== 'published')
    return chunks(unavailableLines(model, 'Прогресс'))
  if (model.phase === 'future') {
    return chunks([
      `Прогресс · ${model.targetMonth}`,
      '',
      `План начнёт действовать ${model.activeLocalDate}.`,
    ])
  }
  const visible = model.goals.filter(
    (goal) => goal.viewerAccess !== 'partner_read_only',
  )
  const lines: string[] = [
    `Прогресс · ${model.targetMonth}`,
    '',
    `Фокус: ${model.focus}`,
    `Состояние месяца: ${model.phase}`,
  ]
  for (const access of ['personal_owner', 'shared'] as const) {
    const goals = visible.filter((goal) => goal.viewerAccess === access)
    if (goals.length === 0) continue
    lines.push('', access === 'shared' ? 'Общие цели' : 'Личные цели')
    for (const goal of goals) {
      lines.push(`• ${goal.title} — ${metric(goal.progress)}`)
    }
  }
  if (visible.length === 0) lines.push('', 'Доступных целей нет.')
  return chunks(lines)
}
