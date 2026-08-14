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
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const telegramId = 2 ** 52 - 1

describe('G03 Telegram time, rating and checkpoint actions', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let lifecycle: TelegramIngressLifecycle
  let clock: FakeProductClock
  let tracking: ReturnType<typeof createTrackingApplication>
  const sent: TelegramSendMessage[] = []
  const batches: unknown[][] = []
  let updateId = 500

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g03_e2e')
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
      INSERT INTO users (id) VALUES ('${firstUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot)
      VALUES ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1);
      INSERT INTO telegram_access_allowlist (user_id, space_id, telegram_id)
      VALUES ('${firstUserId}'::uuid, '${spaceId}'::uuid, ${telegramId});
    `)
    const bot: TelegramBotApiPort = {
      getUpdates: jest.fn(() => Promise.resolve(batches.shift() ?? [])),
      sendMessage: jest.fn((input) => {
        sent.push(input)
        return Promise.resolve()
      }),
      answerCallbackQuery: jest.fn(() => Promise.resolve()),
    }
    const config = buildApiRuntimeConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      DATABASE_URL: postgres.getConnectionUri(),
      DATABASE_POOL_MAX: 12,
      REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 31).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 32).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 33).toString('base64url'),
      AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-g03-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL:
        'http://127.0.0.1:3000/auth/telegram/callback',
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:telegram-g03-bot-token',
    })
    clock = new FakeProductClock(new Date('2026-04-10T18:55:00.000Z'))
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

    const transaction = app.get<DatabaseTransactionPort>(
      DATABASE_TRANSACTION_PORT,
    )
    const members = app.get<WorkspaceMemberResolver>(WORKSPACE_MEMBER_RESOLVER)
    const planning = createPlanningApplication({
      database,
      transaction,
      workspaceMembers: members,
      clock,
    })
    tracking = createTrackingApplication({
      database,
      transaction,
      workspaceMembers: members,
      clock,
    })
    const actor = { kind: 'member' as const, id: firstMemberId }
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor,
      payload: { targetMonth: '2026-04', focus: 'G03 Telegram E2E' },
    })
    const goals: readonly {
      readonly title: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        title: 'Sleep',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'actual_time', start: '22:30', end: '07:00' },
          checkpoints: null,
        },
      },
      {
        title: 'Energy',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'rating', minimum: -5, maximum: 10 },
          checkpoints: null,
        },
      },
      {
        title: 'Routine',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Done',
                deadline: '20:00',
                satisfaction: { kind: 'boolean' },
              },
            ],
          },
        },
      },
      {
        title: 'Schedule',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'actual_time', start: '08:00', end: '18:00' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Start',
                deadline: '12:00',
                satisfaction: {
                  kind: 'actual_time',
                  start: '08:00',
                  end: '18:00',
                },
              },
            ],
          },
        },
      },
      {
        title: 'Mood',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'rating', minimum: 1, maximum: 10 },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Evening',
                deadline: '23:00',
                satisfaction: { kind: 'rating' },
              },
            ],
          },
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: {
          title: goals[index]!.title,
          why: 'G03 E2E',
          category: 'G03',
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
    if (preview === null) throw new Error('G03 publication preview missing')
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
    const button = [...sent]
      .reverse()
      .flatMap((message) => message.replyMarkup?.inline_keyboard.flat() ?? [])
      .find((value) => value.text === text)
    if (button === undefined || !('callback_data' in button)) {
      const labels = sent.flatMap((message) =>
        (message.replyMarkup?.inline_keyboard.flat() ?? []).map(
          (value) => value.text,
        ),
      )
      throw new Error(
        `Telegram button ${text} missing; available: ${labels.join(', ')}`,
      )
    }
    return button.callback_data
  }

  function callback(data: string, id: string): unknown {
    return {
      update_id: updateId++,
      callback_query: {
        id,
        data,
        from: { id: telegramId },
        message: { chat: { id: telegramId, type: 'private' } },
      },
    }
  }

  function message(text: string): unknown {
    return {
      update_id: updateId++,
      message: {
        text,
        chat: { id: telegramId, type: 'private' },
        from: { id: telegramId },
      },
    }
  }

  async function today(id: string): Promise<void> {
    await tick([callback('pl1:t', id)])
  }

  it('maps typed scalar inputs through opaque semantic intents', async () => {
    await today('today-routine')
    const routineSelect = callbackFor('✓ Routine · Done')
    expect(routineSelect).toMatch(/^pl1:s:[0-9a-f-]{36}$/u)
    await tick([callback(routineSelect, 'routine-select')])
    const routineConfirm = callbackFor('Подтвердить')
    await tick([
      callback(routineConfirm, 'routine-confirm-a'),
      callback(routineConfirm, 'routine-confirm-b'),
    ])

    const routineFact = await tracking.getToday.execute({
      trustedActor: { kind: 'member', id: firstMemberId },
    })
    if (routineFact.state !== 'published') throw new Error('Today missing')
    const routineRecord = routineFact.day.goals
      .flatMap((goal) => goal.fixedExpectations)
      .flatMap((value) => value.facts)
      .find((fact) => fact.factKind === 'boolean')
    if (routineRecord === undefined) throw new Error('Routine fact missing')

    await today('today-energy-stale')
    const staleEnergy = callbackFor('Ввести Energy')
    await tick([callback(staleEnergy, 'energy-select-stale')])
    await tick([message('8')])
    await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      expectedRevision: routineRecord.revision,
      payload: {
        factRecordId: routineRecord.factRecordId,
        value: { kind: 'boolean', result: 'not_done' },
        reason: 'G03 correction before Telegram confirm',
      },
    })
    await tick([callback(callbackFor('Подтвердить'), 'energy-stale-confirm')])
    expect(sent.at(-1)?.text).toContain('Состояние изменилось')

    await today('today-energy')
    await tick([callback(callbackFor('Ввести Energy'), 'energy-select')])
    await tick([message('1.5')])
    expect(sent.at(-1)?.text).toContain('целым безопасным числом')
    await tick([message('9007199254740992')])
    expect(sent.at(-1)?.text).toContain('целым безопасным числом')
    await tick([message('-5')])
    await tick([callback(callbackFor('Подтвердить'), 'energy-confirm')])

    await today('today-schedule')
    await tick([
      callback(callbackFor('Ввести Schedule · Start'), 'schedule-select'),
    ])
    await tick([message('24:00')])
    expect(sent.at(-1)?.text).toContain('формат ЧЧ:ММ')
    await tick([message('09:15')])
    await tick([callback(callbackFor('Подтвердить'), 'schedule-confirm')])

    await today('today-mood')
    await tick([callback(callbackFor('Ввести Mood · Evening'), 'mood-select')])
    await tick([message('11')])
    await tick([callback(callbackFor('Подтвердить'), 'mood-invalid-confirm')])
    expect(sent.at(-1)?.text).toContain('Сохранение недоступно')
    await today('today-mood-edit')
    const moodIntent = callbackFor('Ввести Mood · Evening')
    await tick([callback(moodIntent, 'mood-edit')])
    await tick([message('10')])
    await tick([callback(callbackFor('Подтвердить'), 'mood-confirm')])

    await today('today-sleep')
    const sleepIntent = callbackFor('Ввести Sleep')
    await tick([callback(sleepIntent, 'sleep-select')])
    await tick([message('00:30')])
    expect(sent.at(-1)?.text).toContain('Дата: 2026-04-10')
    await tick([callback(callbackFor('Изменить'), 'sleep-edit')])
    await tick([message('01:15')])
    clock.set(new Date('2026-04-10T19:01:00.000Z'))
    await tick([callback(callbackFor('Подтвердить'), 'sleep-confirm')])

    const records = await pool.query<{
      readonly fact_kind: string
      readonly local_date: string
      readonly actual_time_value: string | null
      readonly rating_value: string | null
    }>(`
      SELECT record.fact_kind,
             record.local_date::text,
             revision.actual_time_value::text,
             revision.rating_value::text
        FROM tracking_fact_records record
        JOIN tracking_fact_revisions revision
          ON revision.fact_record_id = record.id
         AND revision.id = record.current_revision_id
       ORDER BY record.fact_kind, record.local_date
    `)
    expect(records.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact_kind: 'actual_time',
          local_date: '2026-04-10',
          actual_time_value: '01:15:00',
        }),
        expect.objectContaining({ fact_kind: 'boolean' }),
        expect.objectContaining({ fact_kind: 'rating', rating_value: '-5' }),
        expect.objectContaining({ fact_kind: 'rating', rating_value: '10' }),
      ]),
    )
    expect(records.rows).toHaveLength(5)
    const aggregate = await pool.query<{
      readonly facts_revision: string
      readonly completed_intents: string
      readonly scalar_receipts: string
    }>(`
      SELECT month.facts_revision::text,
             (SELECT count(*)::text FROM telegram_action_intents
               WHERE state = 'completed') completed_intents,
             (SELECT count(*)::text FROM command_receipts
               WHERE command_type IN (
                 'tracking.record-time.v1',
                 'tracking.record-rating.v1',
                 'tracking.record-checkpoint.v1'
               )) scalar_receipts
        FROM plan_months month
       WHERE month.status = 'published'
    `)
    expect(aggregate.rows[0]).toEqual({
      facts_revision: '6',
      completed_intents: '5',
      scalar_receipts: '5',
    })
    const callbackPayloads = sent.flatMap(
      (value) => value.replyMarkup?.inline_keyboard.flat() ?? [],
    )
    for (const button of callbackPayloads) {
      if (!('callback_data' in button)) continue
      expect(
        Buffer.byteLength(button.callback_data, 'utf8'),
      ).toBeLessThanOrEqual(64)
      expect(button.callback_data).not.toContain(firstMemberId)
      expect(button.callback_data).not.toContain('2026-04-10')
      expect(button.callback_data).not.toContain('01:15')
    }
  }, 120_000)
})
