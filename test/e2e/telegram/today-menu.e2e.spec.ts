import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import { ApiModule } from '@/bootstrap/api/api.module'
import { createPlanningApplication } from '@/modules/planning'
import {
  TELEGRAM_BOT_API,
  TELEGRAM_INGRESS_LIFECYCLE,
  type GetUpdatesRunner,
  type TelegramBotApiPort,
  type TelegramIngressLifecycle,
  type TelegramSendMessage,
} from '@/modules/telegram-bot'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import {
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'

describe('G01 Telegram Today menu through real composition/PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let lifecycle: TelegramIngressLifecycle
  let clock: FakeProductClock
  let bot: TelegramBotApiPort
  const sent: TelegramSendMessage[] = []
  const answered: string[] = []
  const batches: unknown[][] = []

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g01_e2e')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of readdirSync('prisma/migrations').sort()) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('11111111-1111-4111-8111-111111111111'::uuid),
        ('22222222-2222-4222-8222-222222222222'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('33333333-3333-4333-8333-333333333333'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        (
          '44444444-4444-4444-8444-444444444444'::uuid,
          '33333333-3333-4333-8333-333333333333'::uuid,
          '11111111-1111-4111-8111-111111111111'::uuid,
          1
        ),
        (
          '55555555-5555-4555-8555-555555555555'::uuid,
          '33333333-3333-4333-8333-333333333333'::uuid,
          '22222222-2222-4222-8222-222222222222'::uuid,
          2
        );
      INSERT INTO telegram_access_allowlist
        (user_id, space_id, telegram_id) VALUES
        (
          '11111111-1111-4111-8111-111111111111'::uuid,
          '33333333-3333-4333-8333-333333333333'::uuid,
          123456789
        ),
        (
          '22222222-2222-4222-8222-222222222222'::uuid,
          '33333333-3333-4333-8333-333333333333'::uuid,
          223456789
        );
    `)

    batches.push([
      {
        update_id: 100,
        message: {
          text: '/start',
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789 },
        },
      },
      {
        update_id: 101,
        callback_query: {
          id: 'today-callback',
          data: 'pl1:t',
          from: { id: 123456789 },
          message: { chat: { id: 123456789, type: 'private' } },
        },
      },
      {
        update_id: 102,
        message: {
          text: '/start',
          chat: { id: -900, type: 'group' },
          from: { id: 123456789 },
        },
      },
      {
        update_id: 103,
        message: {
          text: '/start',
          chat: { id: 999999999, type: 'private' },
          from: { id: 999999999 },
        },
      },
      {
        update_id: 104,
        callback_query: {
          id: 'stale-callback',
          data: 'pl2:t',
          from: { id: 123456789 },
          message: { chat: { id: 123456789, type: 'private' } },
        },
      },
      {
        update_id: 104,
        message: {
          text: '/menu',
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789 },
        },
      },
    ])
    bot = {
      getUpdates: jest.fn(async ({ signal }) => {
        const batch = batches.shift()
        if (batch !== undefined) return batch
        return new Promise<readonly unknown[]>((_resolve, reject) => {
          const abort = (): void => reject(new Error('poll aborted'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }),
      sendMessage: jest.fn((input) => {
        sent.push(input)
        return Promise.resolve()
      }),
      answerCallbackQuery: jest.fn((input) => {
        answered.push(input.callbackQueryId)
        return Promise.resolve()
      }),
    }
    const config = buildApiRuntimeConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      DATABASE_URL: postgres.getConnectionUri(),
      DATABASE_POOL_MAX: 8,
      REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 11).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 12).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 13).toString('base64url'),
      AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-e2e-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL:
        'http://127.0.0.1:3000/auth/telegram/callback',
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:telegram-e2e-bot-token',
    })
    clock = new FakeProductClock(new Date('2026-04-10T07:00:00.000Z'))
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(config, clock)],
    })
      .overrideProvider(TELEGRAM_BOT_API)
      .useValue(bot)
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>()
    await app.init()
    database = app.get(PrismaClientProvider)
    await database.connect(AbortSignal.timeout(3_000))
    lifecycle = app.get(TELEGRAM_INGRESS_LIFECYCLE)
    await lifecycle.start(AbortSignal.timeout(5_000))
  }, 120_000)

  afterAll(async () => {
    await lifecycle?.stop(AbortSignal.timeout(3_000)).catch(() => undefined)
    await database?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  it('exposes menu/no-plan and safe denied states with durable dedupe', async () => {
    expect(
      sent.some(
        (message) =>
          message.chatId === 123456789n &&
          message.text.includes('Выберите действие'),
      ),
    ).toBe(true)
    const menu = sent.find((message) =>
      message.text.includes('Выберите действие'),
    )
    const buttons = menu?.replyMarkup?.inline_keyboard.flat() ?? []
    expect(buttons.map((button) => button.text)).toEqual([
      'Сегодня',
      'Месяц',
      'Статистика',
      'План',
      'Настройки',
    ])
    expect(
      buttons
        .filter((button) => 'url' in button)
        .every(
          (button) =>
            'url' in button && button.url.endsWith('/auth/telegram/start'),
        ),
    ).toBe(true)
    expect(
      sent.some(
        (message) =>
          message.chatId === 123456789n &&
          message.text.includes('На текущий месяц плана нет'),
      ),
    ).toBe(true)
    expect(sent).toContainEqual(
      expect.objectContaining({
        chatId: -900n,
        text: 'Planner работает только в личном чате.',
      }),
    )
    expect(sent).toContainEqual(
      expect.objectContaining({
        chatId: 999999999n,
        text: 'Доступ к Planner закрыт.',
      }),
    )
    expect(
      sent.some(
        (message) =>
          message.chatId === 123456789n &&
          message.text.includes('Кнопка устарела'),
      ),
    ).toBe(true)
    expect(answered).toEqual(['today-callback', 'stale-callback'])
    const offset = await pool.query<{ readonly next_update_id: string }>(
      'SELECT next_update_id::text FROM telegram_ingress_state',
    )
    expect(offset.rows[0]?.next_update_id).toBe('105')
    const receipts = await pool.query<{ readonly count: string }>(
      'SELECT count(*)::text count FROM command_receipts',
    )
    expect(receipts.rows[0]?.count).toBe('0')

    await lifecycle.stop(AbortSignal.timeout(3_000))
    const planning = createPlanningApplication({
      database,
      transaction: app.get<DatabaseTransactionPort>(DATABASE_TRANSACTION_PORT),
      workspaceMembers: app.get<WorkspaceMemberResolver>(
        WORKSPACE_MEMBER_RESOLVER,
      ),
      clock,
    })
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: {
        kind: 'member',
        id: '44444444-4444-4444-8444-444444444444',
      },
      payload: { targetMonth: '2026-04', focus: 'Апрельский фокус' },
    })
    batches.push([
      {
        update_id: 105,
        message: {
          text: 'Сегодня',
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789 },
        },
      },
    ])
    await (lifecycle as GetUpdatesRunner).tick(0, AbortSignal.timeout(3_000))
    expect(sent.at(-1)?.text).toContain('План пока остаётся черновиком')

    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: '11111111-1111-4111-8111-111111111111',
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('Publication preview is missing')
    expect(preview.blockers).toEqual([])
    await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: {
        kind: 'member',
        id: '44444444-4444-4444-8444-444444444444',
      },
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    batches.push([
      {
        update_id: 106,
        callback_query: {
          id: 'active-today',
          data: 'pl1:t',
          from: { id: 123456789 },
          message: { chat: { id: 123456789, type: 'private' } },
        },
      },
    ])
    await (lifecycle as GetUpdatesRunner).tick(0, AbortSignal.timeout(3_000))
    expect(sent.at(-1)?.text).toContain('Фокус: Апрельский фокус')
    expect(sent.at(-1)?.text).toContain('Статус дня:')

    batches.push([
      {
        update_id: 107,
        callback_query: {
          id: 'active-progress',
          data: 'pl1:p',
          from: { id: 123456789 },
          message: { chat: { id: 123456789, type: 'private' } },
        },
      },
    ])
    await (lifecycle as GetUpdatesRunner).tick(0, AbortSignal.timeout(3_000))
    expect(sent.at(-1)?.text).toContain('Прогресс · 2026-04')
    expect(sent.at(-1)?.text).toContain('Фокус: Апрельский фокус')
    expect(answered).toContain('active-progress')
  })
})
