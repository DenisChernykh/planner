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
import {
  createPlanningApplication,
  type DraftGoalConfigV1,
} from '@/modules/planning'
import { createTrackingApplication } from '@/modules/tracking'
import {
  TELEGRAM_BOT_API,
  TELEGRAM_INGRESS_LIFECYCLE,
  type GetUpdatesRunner,
  type TelegramBotApiPort,
  type TelegramIngressLifecycle,
  type TelegramSendMessage,
} from '@/modules/telegram-bot'
import {
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'
const telegramId = 123456789

describe('G02 Telegram Boolean and quantity pilot mutations', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let lifecycle: TelegramIngressLifecycle
  let clock: FakeProductClock
  const sent: TelegramSendMessage[] = []
  const answered: string[] = []
  const batches: unknown[][] = []

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g02_e2e')
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
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
      INSERT INTO telegram_access_allowlist (user_id, space_id, telegram_id)
      VALUES ('${firstUserId}'::uuid, '${spaceId}'::uuid, ${telegramId});
    `)
    const bot: TelegramBotApiPort = {
      getUpdates: jest.fn(() => Promise.resolve(batches.shift() ?? [])),
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
      DATABASE_POOL_MAX: 12,
      REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 21).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 22).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 23).toString('base64url'),
      AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-g02-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL:
        'http://127.0.0.1:3000/auth/telegram/callback',
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:telegram-g02-bot-token',
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

    const planning = createPlanningApplication({
      database,
      transaction: app.get<DatabaseTransactionPort>(DATABASE_TRANSACTION_PORT),
      workspaceMembers: app.get<WorkspaceMemberResolver>(
        WORKSPACE_MEMBER_RESOLVER,
      ),
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2026-04', focus: 'G02 Telegram E2E' },
    })
    const goals: readonly {
      readonly title: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        title: 'Vitamin',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        title: 'Water',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'ml',
            precision: 0,
            aggregation: 'add',
            target: '1200',
          },
          checkpoints: null,
        },
      },
      {
        title: 'Steps',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'quantity',
            mode: 'targeted',
            unit: 'steps',
            precision: 0,
            aggregation: 'latest',
            target: '7000',
          },
          checkpoints: null,
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: goals[index]!.title,
          why: 'G02 E2E',
          category: 'G02',
        },
      })
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: goals[index]!.config,
          sourceProvenance: null,
        },
      })
    }
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('G02 E2E preview missing')
    await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  async function tick(updates: readonly unknown[]): Promise<void> {
    batches.push([...updates])
    await (lifecycle as GetUpdatesRunner).tick(0, AbortSignal.timeout(5_000))
  }

  function callbackFor(text: string): string {
    const message = [...sent]
      .reverse()
      .find((value) =>
        value.replyMarkup?.inline_keyboard
          .flat()
          .some((button) => button.text === text),
      )
    const button = message?.replyMarkup?.inline_keyboard
      .flat()
      .find((value) => value.text === text)
    if (button === undefined || !('callback_data' in button)) {
      throw new Error(`Telegram button ${text} missing`)
    }
    return button.callback_data
  }

  it('uses semantic intents across distinct callback query IDs', async () => {
    let updateId = 200
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'today-1',
          data: 'pl1:t',
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])
    const vitaminSelect = callbackFor('✓ Vitamin')
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'vitamin-select',
          data: vitaminSelect,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])
    const vitaminConfirm = callbackFor('Подтвердить')
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'vitamin-confirm-a',
          data: vitaminConfirm,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
      {
        update_id: updateId++,
        callback_query: {
          id: 'vitamin-confirm-b',
          data: vitaminConfirm,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])

    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'today-2',
          data: 'pl1:t',
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])
    const waterSelect = callbackFor('Ввести Water')
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'water-select',
          data: waterSelect,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
      {
        update_id: updateId++,
        message: {
          text: '400',
          chat: { id: telegramId, type: 'private' },
          from: { id: telegramId },
        },
      },
    ])
    const waterConfirm = callbackFor('Подтвердить')
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'water-confirm',
          data: waterConfirm,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])

    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'today-3',
          data: 'pl1:t',
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])
    const stepsSelect = callbackFor('Ввести Steps')
    await tick([
      {
        update_id: updateId++,
        callback_query: {
          id: 'steps-select',
          data: stepsSelect,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
      {
        update_id: updateId++,
        message: {
          text: '7000',
          chat: { id: telegramId, type: 'private' },
          from: { id: telegramId },
        },
      },
    ])
    const stepsConfirm = callbackFor('Подтвердить')
    await tick([
      {
        update_id: updateId,
        callback_query: {
          id: 'steps-confirm',
          data: stepsConfirm,
          from: { id: telegramId },
          message: { chat: { id: telegramId, type: 'private' } },
        },
      },
    ])

    const rows = await pool.query<{
      readonly facts_revision: string
      readonly records: string
      readonly receipts: string
      readonly completed_intents: string
    }>(`
      SELECT month.facts_revision::text,
             (SELECT count(*)::text FROM tracking_fact_records) records,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type = 'tracking.record-fact.v1') receipts,
             (SELECT count(*)::text FROM telegram_action_intents
               WHERE state = 'completed') completed_intents
        FROM plan_months month
       WHERE month.status = 'published'
    `)
    expect(rows.rows[0]).toEqual({
      facts_revision: '3',
      records: '3',
      receipts: '3',
      completed_intents: '3',
    })
    expect(answered).toEqual(
      expect.arrayContaining([
        'vitamin-confirm-a',
        'vitamin-confirm-b',
        'water-confirm',
        'steps-confirm',
      ]),
    )
    expect(
      sent.filter((message) => message.text.includes('Сохранено.')),
    ).toHaveLength(4)

    const tracking = createTrackingApplication({
      database,
      transaction: app.get<DatabaseTransactionPort>(DATABASE_TRANSACTION_PORT),
      workspaceMembers: app.get<WorkspaceMemberResolver>(
        WORKSPACE_MEMBER_RESOLVER,
      ),
      clock,
    })
    const today = await tracking.getToday.execute({
      trustedActor: { kind: 'member', id: firstMemberId },
    })
    if (today.state !== 'published') throw new Error('Published read missing')
    const facts = today.day.goals.flatMap((goal) => [
      ...goal.fixedExpectations.flatMap((value) => value.facts),
      ...goal.flexiblePeriods.flatMap((value) => value.facts),
    ])
    expect(facts.map((fact) => fact.factKind).sort()).toEqual([
      'boolean',
      'quantity_add',
      'quantity_latest',
    ])
  }, 120_000)
})
