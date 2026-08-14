import type {
  GetTodayQuery,
  TrackingTodayReadModelV1,
} from '@/modules/tracking'
import {
  GetUpdatesRunner,
  TelegramUpdateHandler,
  renderProgress,
  renderToday,
  type TelegramBotApiPort,
  type TelegramIngressStatePort,
} from '@/modules/telegram-bot'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { WorkspaceMemberNotFoundError } from '@/modules/workspace'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'

const member = {
  spaceId: '33333333-3333-4333-8333-333333333333',
  memberId: '44444444-4444-4444-8444-444444444444',
  userId: '11111111-1111-4111-8111-111111111111',
}

function config(
  overrides: Record<string, unknown> = {},
): ApplicationRuntimeConfig {
  return buildApiRuntimeConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://planner:test@127.0.0.1:1/planner',
    REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
    AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 1).toString('base64url'),
    AUTH_CSRF_SECRET: Buffer.alloc(32, 2).toString('base64url'),
    AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 3).toString('base64url'),
    AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
    TELEGRAM_OIDC_CLIENT_ID: '123456789',
    TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-oidc-test-secret',
    TELEGRAM_OIDC_CALLBACK_URL: 'http://127.0.0.1:3000/auth/telegram/callback',
    ...overrides,
  })
}

function resolver(
  result: typeof member | Error = member,
  calls: bigint[] = [],
): WorkspaceMemberResolver {
  return {
    resolveTelegramId: jest.fn((telegramId: bigint) => {
      calls.push(telegramId)
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result)
    }),
    resolveMember: jest.fn(),
    resolveUser: jest.fn(),
  }
}

function todayQuery(
  result: TrackingTodayReadModelV1,
  calls: unknown[] = [],
): GetTodayQuery {
  return {
    execute: jest.fn((input: unknown) => {
      calls.push(input)
      return Promise.resolve(result)
    }),
  } as unknown as GetTodayQuery
}

const noPlan: TrackingTodayReadModelV1 = {
  schemaVersion: 'tracking.today.v1',
  state: 'no_plan',
  queryLocalDate: '2026-04-10',
  targetMonth: '2026-04',
}

describe('G01 Telegram ingress application', () => {
  it('keeps ingress disabled by default and requires a token when enabled', () => {
    expect(config().telegramBot).toMatchObject({ ingressMode: 'disabled' })
    expect(() => config({ TELEGRAM_INGRESS_MODE: 'get_updates' })).toThrow(
      'Runtime configuration is invalid',
    )
    expect(
      config({
        TELEGRAM_INGRESS_MODE: 'get_updates',
        TELEGRAM_BOT_TOKEN: '123456789:test-bot-token-value',
      }).telegramBot,
    ).toMatchObject({
      ingressMode: 'get_updates',
      token: '123456789:test-bot-token-value',
      getUpdatesTimeoutSeconds: 25,
    })
    expect(() =>
      config({
        NODE_ENV: 'production',
        AUTH_CSRF_ORIGINS: 'https://planner.invalid',
        TELEGRAM_OIDC_CALLBACK_URL:
          'https://planner.invalid/auth/telegram/callback',
        TELEGRAM_INGRESS_MODE: 'get_updates',
        TELEGRAM_BOT_TOKEN: '123456789:test-bot-token-value',
      }),
    ).toThrow('Runtime configuration is invalid')
  })

  it('does not resolve workspace data for non-private chat', async () => {
    const memberCalls: bigint[] = []
    const members = resolver(member, memberCalls)
    const handler = new TelegramUpdateHandler(
      members,
      todayQuery(noPlan),
      'http://127.0.0.1:3000/auth/telegram/start',
    )
    const prepared = await handler.prepare({
      kind: 'non_private',
      updateId: 1n,
      chatId: -10n,
    })
    expect(memberCalls).toEqual([])
    expect(prepared.attempts).toEqual([
      expect.objectContaining({
        kind: 'send_message',
        chatId: -10n,
        text: 'Planner работает только в личном чате.',
      }),
    ])
  })

  it('acknowledges unsafe callbacks exactly once without workspace lookup', async () => {
    const memberCalls: bigint[] = []
    const handler = new TelegramUpdateHandler(
      resolver(member, memberCalls),
      todayQuery(noPlan),
      'http://127.0.0.1:3000/auth/telegram/start',
    )
    const group = await handler.prepare({
      kind: 'non_private',
      updateId: 10n,
      chatId: -10n,
      callbackQueryId: 'callback-group',
    })
    const rejected = await handler.prepare({
      kind: 'rejected_callback',
      updateId: 11n,
      callbackQueryId: 'callback-mismatch',
    })
    expect(memberCalls).toEqual([])
    expect(
      group.attempts.filter((value) => value.kind === 'answer_callback'),
    ).toHaveLength(1)
    expect(rejected.attempts).toEqual([
      {
        kind: 'answer_callback',
        callbackQueryId: 'callback-mismatch',
        text: 'Доступ к Planner закрыт.',
      },
    ])
  })

  it('conceals an unknown private identity and acknowledges its callback', async () => {
    const handler = new TelegramUpdateHandler(
      resolver(new WorkspaceMemberNotFoundError()),
      todayQuery(noPlan),
      'http://127.0.0.1:3000/auth/telegram/start',
    )
    const prepared = await handler.prepare({
      kind: 'private_callback',
      updateId: 2n,
      chatId: 123n,
      telegramId: 123n,
      callbackQueryId: 'callback-2',
      callbackData: 'pl1:t',
    })
    expect(prepared.attempts.map((value) => value.kind)).toEqual([
      'answer_callback',
      'send_message',
    ])
    expect(
      JSON.stringify(prepared, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(member.spaceId)
  })

  it('maps Today through the trusted member query and returns no-plan state', async () => {
    const calls: unknown[] = []
    const handler = new TelegramUpdateHandler(
      resolver(),
      todayQuery(noPlan, calls),
      'http://127.0.0.1:3000/auth/telegram/start',
    )
    const prepared = await handler.prepare({
      kind: 'private_callback',
      updateId: 3n,
      chatId: 123n,
      telegramId: 123n,
      callbackQueryId: 'callback-3',
      callbackData: 'pl1:t',
    })
    expect(calls).toEqual([
      { trustedActor: { kind: 'member', id: member.memberId } },
    ])
    expect(prepared.attempts[0]?.kind).toBe('answer_callback')
    const response = prepared.attempts[1]
    expect(response?.kind).toBe('send_message')
    expect(response?.kind === 'send_message' ? response.text : '').toContain(
      'На текущий месяц плана нет',
    )
  })

  it('renders only personal-owner/shared goals and chunks deterministically', () => {
    const metric = {
      available: true as const,
      exact: { numerator: '1', denominator: '2' },
      basisPoints: '5000',
    }
    const progress = {
      formulaVersions: {
        calendar: 'planner.calendar-targets.v1' as const,
        evaluation: 'planner.goal-evaluation.v1' as const,
      },
      progress: metric,
      score: metric,
      overperformance: metric,
      coverage: { filled: '1', applicable: '2' },
      contribution: {
        score: metric.exact,
        coverage: { filled: '1', applicable: '2' },
      },
      periods: [],
    }
    const published = {
      schemaVersion: 'tracking.today.v1',
      state: 'published',
      queryLocalDate: '2026-04-10',
      targetMonth: '2026-04',
      planMonthId: 'month',
      lifecycleRevision: 1n,
      factsRevision: 0n,
      monthStatus: 'published',
      phase: 'active',
      publicationId: 'publication',
      publicationRevision: 1n,
      activeLocalDate: '2026-04-01',
      latePublication: false,
      focus: 'Фокус',
      goals: [
        {
          planGoalSnapshotId: 'own',
          title: 'Личная',
          viewerAccess: 'personal_owner',
          progress,
        },
        {
          planGoalSnapshotId: 'shared',
          title: 'Общая',
          viewerAccess: 'shared',
          progress,
        },
        {
          planGoalSnapshotId: 'partner',
          title: 'Партнёра',
          viewerAccess: 'partner_read_only',
          progress,
        },
      ],
      day: {
        localDate: '2026-04-10',
        state: 'partial',
        goals: ['own', 'shared', 'partner'].map((planGoalSnapshotId) => ({
          planGoalSnapshotId,
          state: 'partial',
          progress,
          fixedExpectations:
            planGoalSnapshotId === 'own'
              ? [
                  {
                    componentKind: 'goal',
                    state: 'done',
                    facts: [],
                  },
                ]
              : [],
          flexiblePeriods:
            planGoalSnapshotId === 'own'
              ? [
                  {
                    eligibleOnDate: true,
                    periodKind: 'weekly',
                    actualProgress: { numerator: '2', denominator: '1' },
                    expectedProgress: 3,
                    periodTarget: 5,
                  },
                ]
              : [],
        })),
      },
    } as unknown as TrackingTodayReadModelV1
    const rendered = renderToday(published).join('\n')
    expect(rendered).toContain('Личная')
    expect(rendered).toContain('Общая')
    expect(rendered).not.toContain('Партнёра')
    expect(rendered).toContain('основное ожидание: выполнено')
    expect(rendered).toContain('неделя: факт 2, план к дате 3, цель периода 5')
    expect(renderProgress(published).join('\n')).not.toContain('Партнёра')
  })

  it('labels non-published progress independently from Today', () => {
    expect(renderProgress(noPlan).join('\n')).toContain('Прогресс')
    expect(renderProgress(noPlan).join('\n')).not.toContain('Сегодня')
    expect(
      renderProgress({
        ...noPlan,
        state: 'draft',
        planMonthId: 'month',
        lifecycleRevision: 1n,
        draftRevision: 1n,
        focus: 'Фокус',
      }).join('\n'),
    ).toContain('Прогресс')
  })

  it('chunks a large Today response and attaches navigation only to the last part', async () => {
    const exact = {
      available: true as const,
      exact: { numerator: '1', denominator: '1' },
      basisPoints: '10000',
    }
    const progress = {
      formulaVersions: {
        calendar: 'planner.calendar-targets.v1' as const,
        evaluation: 'planner.goal-evaluation.v1' as const,
      },
      progress: exact,
      score: exact,
      overperformance: exact,
      coverage: { filled: '1', applicable: '1' },
      contribution: {
        score: exact.exact,
        coverage: { filled: '1', applicable: '1' },
      },
      periods: [],
    }
    const identifiers = Array.from(
      { length: 30 },
      (_, index) => `goal-${index}`,
    )
    const model = {
      schemaVersion: 'tracking.today.v1',
      state: 'published',
      queryLocalDate: '2026-04-10',
      targetMonth: '2026-04',
      phase: 'active',
      activeLocalDate: '2026-04-01',
      focus: 'Фокус',
      goals: identifiers.map((planGoalSnapshotId) => ({
        planGoalSnapshotId,
        title: `${planGoalSnapshotId} ${'длинная цель '.repeat(12)}`,
        viewerAccess: 'personal_owner',
        progress,
      })),
      day: {
        state: 'filled',
        goals: identifiers.map((planGoalSnapshotId) => ({
          planGoalSnapshotId,
          state: 'filled',
          progress,
          fixedExpectations: [],
          flexiblePeriods: [],
        })),
      },
    } as unknown as TrackingTodayReadModelV1
    const handler = new TelegramUpdateHandler(
      resolver(),
      todayQuery(model),
      'http://127.0.0.1:3000/auth/telegram/start',
    )
    const prepared = await handler.prepare({
      kind: 'private_callback',
      updateId: 12n,
      chatId: 123n,
      telegramId: 123n,
      callbackQueryId: 'large-today',
      callbackData: 'pl1:t',
    })
    const messages = prepared.attempts.filter(
      (attempt) => attempt.kind === 'send_message',
    )
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.every((message) => message.text.length <= 4_000)).toBe(true)
    expect(
      messages
        .slice(0, -1)
        .every((message) => message.replyMarkup === undefined),
    ).toBe(true)
    expect(messages.at(-1)?.replyMarkup).toBeDefined()
  })

  it('renders a future publication without presenting daily actions', () => {
    const future = {
      schemaVersion: 'tracking.today.v1',
      state: 'published',
      queryLocalDate: '2026-03-31',
      targetMonth: '2026-04',
      phase: 'future',
      activeLocalDate: '2026-04-01',
      focus: 'Апрель',
      goals: [],
      day: { localDate: '2026-03-31', state: 'future', goals: [] },
    } as unknown as TrackingTodayReadModelV1
    expect(renderToday(future).join('\n')).toContain(
      'План начнёт действовать 2026-04-01',
    )
  })

  it('sorts updates and claims before each single outbound attempt', async () => {
    const events: string[] = []
    const state: TelegramIngressStatePort = {
      getNextUpdateId: jest.fn().mockResolvedValue(0n),
      claim: jest.fn((updateId: bigint) => {
        events.push(`claim:${updateId}`)
        return Promise.resolve(updateId !== 1n)
      }),
    }
    const bot: TelegramBotApiPort = {
      getUpdates: jest.fn().mockResolvedValue([
        {
          update_id: 2,
          message: {
            text: '/menu',
            chat: { id: 123, type: 'private' },
            from: { id: 123 },
          },
        },
        { update_id: 1 },
      ]),
      sendMessage: jest.fn(() => {
        events.push('send')
        return Promise.resolve()
      }),
      answerCallbackQuery: jest.fn(),
    }
    const runner = new GetUpdatesRunner(
      state,
      bot,
      new TelegramUpdateHandler(
        resolver(),
        todayQuery(noPlan),
        'http://127.0.0.1:3000/auth/telegram/start',
      ),
      25,
    )
    await runner.tick(0, AbortSignal.timeout(100))
    expect(events).toEqual(['claim:1', 'claim:2', 'send'])
  })

  it('stops admission while a startup update is still being prepared', async () => {
    let releaseToday: (() => void) | undefined
    let markTodayStarted: (() => void) | undefined
    const todayStarted = new Promise<void>((resolve) => {
      markTodayStarted = resolve
    })
    const blockedToday = new Promise<TrackingTodayReadModelV1>((resolve) => {
      releaseToday = () => resolve(noPlan)
    })
    const claim = jest.fn().mockResolvedValue(true)
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const answerCallbackQuery = jest.fn().mockResolvedValue(undefined)
    const state: TelegramIngressStatePort = {
      getNextUpdateId: jest.fn().mockResolvedValue(0n),
      claim,
    }
    const bot: TelegramBotApiPort = {
      getUpdates: jest.fn().mockResolvedValue([
        {
          update_id: 20,
          callback_query: {
            id: 'blocked-today',
            data: 'pl1:t',
            from: { id: 123 },
            message: { chat: { id: 123, type: 'private' } },
          },
        },
      ]),
      sendMessage,
      answerCallbackQuery,
    }
    const runner = new GetUpdatesRunner(
      state,
      bot,
      new TelegramUpdateHandler(
        resolver(),
        {
          execute: () => {
            markTodayStarted?.()
            return blockedToday
          },
        } as unknown as GetTodayQuery,
        'http://127.0.0.1:3000/auth/telegram/start',
      ),
      25,
    )
    const startup = runner.start(AbortSignal.timeout(1_000))
    await todayStarted
    const stop = runner.stop(AbortSignal.timeout(1_000))
    releaseToday?.()
    await expect(stop).resolves.toBeUndefined()
    await expect(startup).rejects.toThrow('Telegram ingress start aborted')
    expect(claim).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(answerCallbackQuery).not.toHaveBeenCalled()
  })

  it('does not announce API readiness when the initial poll fails', async () => {
    const lifecycle = new ApplicationLifecycleState()
    const databaseClose = jest.fn().mockResolvedValue(undefined)
    const redisClose = jest.fn().mockResolvedValue(undefined)
    const ingressStop = jest.fn().mockResolvedValue(undefined)
    const failure = new Error('initial Telegram poll failed')
    const runtime = new ApiRuntime(() =>
      Promise.resolve({
        lifecycle,
        requestTracker: new ActiveRequestTracker(),
        telegramIngress: {
          start: () => Promise.reject(failure),
          stop: ingressStop,
        },
        httpDrainTimeoutMs: 6_000,
        shutdownGraceMs: 10_000,
        database: {
          connect: () => Promise.resolve(),
          close: databaseClose,
        },
        redis: {
          connect: () => Promise.resolve(),
          close: redisClose,
        },
        application: {
          listen: () => Promise.resolve(),
          closeListener: () => Promise.resolve(),
          closeIdleConnections: () => undefined,
          closeAllConnections: () => undefined,
          close: () => Promise.resolve(),
          address: () => null,
        },
      }),
    )
    await expect(runtime.start()).rejects.toMatchObject({
      message: 'API startup failed',
      cause: failure,
    })
    expect(lifecycle.startupComplete).toBe(true)
    expect(lifecycle.phase).toBe('draining')
    expect(ingressStop).toHaveBeenCalledTimes(1)
    expect(databaseClose).toHaveBeenCalledTimes(1)
    expect(redisClose).toHaveBeenCalledTimes(1)
  })
})
