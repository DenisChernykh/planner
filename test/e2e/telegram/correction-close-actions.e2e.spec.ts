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
const telegramId = 2 ** 52 - 1

describe('G05 Telegram corrections and period closure', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let lifecycle: TelegramIngressLifecycle
  let tracking: ReturnType<typeof createTrackingApplication>
  let clock: FakeProductClock
  const sent: TelegramSendMessage[] = []
  const batches: unknown[][] = []
  const snapshots = new Map<string, string>()
  let updateId = 900
  let publicationId: string

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g05_e2e')
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
      answerCallbackQuery: jest.fn(() => Promise.resolve()),
    }
    const runtimeConfig = buildApiRuntimeConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      DATABASE_URL: postgres.getConnectionUri(),
      DATABASE_POOL_MAX: 12,
      REDIS_AUTH_URL: 'redis://default:test@127.0.0.1:1',
      REDIS_KEY_PREFIX: 'planner',
      AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 41).toString('base64url'),
      AUTH_CSRF_SECRET: Buffer.alloc(32, 42).toString('base64url'),
      AUTH_OIDC_STATE_KEY_SECRET: Buffer.alloc(32, 43).toString('base64url'),
      AUTH_CSRF_ORIGINS: 'http://127.0.0.1:3000',
      TELEGRAM_OIDC_CLIENT_ID: '123456789',
      TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-g05-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL:
        'http://127.0.0.1:3000/auth/telegram/callback',
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:telegram-g05-bot-token',
    })
    clock = new FakeProductClock(new Date('2026-04-10T18:55:00.000Z'))
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(runtimeConfig, clock)],
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
      payload: { targetMonth: '2026-04', focus: 'G05 Telegram' },
    })
    const goals: readonly {
      readonly title: string
      readonly config: DraftGoalConfigV1
    }[] = [
      ...(['correct', 'delete', 'undo', 'missing'] as const).map((key) => ({
        title: `G05 ${key}`,
        config: {
          schemaVersion: 1 as const,
          scope: { kind: 'personal' as const, ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' as const },
          measurement: { kind: 'boolean' as const },
          checkpoints: null,
        },
      })),
      {
        title: 'G05 shared',
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        title: 'G05 text',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: null,
        },
      },
      {
        title: 'G05 partner',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: secondMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
      {
        title: 'G05 weekly',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '2',
            taskText: 'G05 weekly task',
          },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
      },
    ]
    for (let index = 0; index < goals.length; index += 1) {
      const goal = goals[index]!
      const definition = await planning.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        payload: { title: goal.title, why: 'G05 E2E', category: 'G05' },
      })
      await planning.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor,
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: goal.config,
          sourceProvenance: null,
        },
      })
    }
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('G05 publication preview missing')
    const publication = await planning.publishMonth.execute({
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
    publicationId = publication.aggregateId
    const rows = await pool.query<{
      readonly id: string
      readonly title: string
    }>(
      `SELECT id::text, title FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publicationId],
    )
    for (const row of rows.rows) snapshots.set(row.title, row.id)

    const textSnapshotId = snapshots.get('G05 text')
    if (textSnapshotId === undefined) throw new Error('G05 text missing')
    await tracking.recordText.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      payload: {
        publicationId,
        planGoalSnapshotId: textSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        text: 'Исходный текст',
        result: 'done',
      },
    })
    for (const title of [
      'G05 correct',
      'G05 delete',
      'G05 undo',
      'G05 shared',
      'G05 partner',
    ]) {
      const planGoalSnapshotId = snapshots.get(title)
      if (planGoalSnapshotId === undefined) throw new Error(`${title} missing`)
      await tracking.recordFact.execute({
        commandId: randomUUID(),
        trustedActor: {
          kind: 'member',
          id:
            title === 'G05 shared' || title === 'G05 partner'
              ? secondMemberId
              : firstMemberId,
        },
        payload: {
          publicationId,
          planGoalSnapshotId,
          localDate: '2026-04-10',
          value: { kind: 'boolean', result: 'done' },
        },
      })
    }
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
      throw new Error(`Telegram button ${text} missing`)
    }
    return button.callback_data
  }

  function latestButtonTexts(): readonly string[] {
    return (
      [...sent]
        .reverse()
        .find((message) => message.replyMarkup !== undefined)
        ?.replyMarkup?.inline_keyboard.flat()
        .map((button) => button.text) ?? []
    )
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

  async function confirm(id: string): Promise<string> {
    const data = callbackFor('Подтвердить')
    await tick([callback(data, id)])
    return data
  }

  it('corrects, deletes, undoes, records weekly result and recovers from CloseDay race', async () => {
    await today('g05-initial')
    const initial = latestButtonTexts()
    expect(initial).toContain('✕ Исправить G05 correct')
    expect(initial).toContain('Удалить G05 delete')
    expect(initial).toContain('Отменить действие · G05 undo')
    expect(initial).toContain('✕ Исправить G05 shared')
    expect(initial).not.toContain('Удалить G05 shared')
    expect(initial).not.toContain('Отменить действие · G05 shared')
    expect(initial.some((text) => text.includes('G05 partner'))).toBe(false)

    await tick([
      callback(
        callbackFor('Отменить действие · G05 correct'),
        'undo-partner-action-select',
      ),
    ])
    await confirm('undo-partner-action-confirm')
    expect(sent.at(-1)?.text).toContain('Состояние изменилось')

    await today('g05-own-undo')
    await tick([
      callback(callbackFor('Отменить действие · G05 undo'), 'undo-select'),
    ])
    await confirm('undo-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-correct')
    await tick([
      callback(callbackFor('✕ Исправить G05 correct'), 'correct-select'),
    ])
    await tick([message('   ')])
    expect(sent.at(-1)?.text).toContain('Причина должна быть непустой')
    await tick([message(`${'x'.repeat(2_000)} `)])
    expect(sent.at(-1)?.text).toContain('не длиннее 2000')
    await tick([message('Исправление результата')])
    expect(sent.at(-1)?.text).toContain('Причина: Исправление результата')
    const correctionConfirm = callbackFor('Подтвердить')
    await tick([
      callback(correctionConfirm, 'correct-confirm-a'),
      callback(correctionConfirm, 'correct-confirm-b'),
    ])
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-text-correction')
    await tick([
      callback(callbackFor('✕ Исправить G05 text'), 'text-correction-select'),
    ])
    await tick([message('z'.repeat(3_900))])
    expect(sent.at(-1)?.text).toContain('Введите обязательную причину')
    await tick([message('r'.repeat(200))])
    expect(sent.at(-1)?.text).toContain('Причина должна быть')
    await tick([message('Короткая причина')])
    await confirm('text-correction-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-shared')
    await tick([
      callback(callbackFor('✕ Исправить G05 shared'), 'shared-select'),
    ])
    await tick([message('Общее исправление')])
    await confirm('shared-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-delete')
    await tick([callback(callbackFor('Удалить G05 delete'), 'delete-select')])
    await tick([message('Удаление личной записи')])
    await confirm('delete-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')
    await today('g05-delete-recovery')
    expect(latestButtonTexts()).not.toContain('Удалить G05 delete')
    expect(latestButtonTexts()).toContain('✕ Исправить G05 delete')
    expect(latestButtonTexts()).toContain('Отменить действие · G05 delete')
    await tick([
      callback(
        callbackFor('Отменить действие · G05 delete'),
        'delete-undo-select',
      ),
    ])
    await confirm('delete-undo-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-weekly')
    await tick([
      callback(callbackFor('✓ задача недели · G05 weekly'), 'weekly-select'),
    ])
    await confirm('weekly-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')
    await today('g05-weekly-correction')
    await tick([
      callback(
        callbackFor('✕ Исправить G05 weekly'),
        'weekly-correction-select',
      ),
    ])
    await tick([message('Нужна специальная коррекция недели')])
    await confirm('weekly-correction-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')
    await today('g05-weekly-delete')
    await tick([
      callback(callbackFor('Удалить G05 weekly'), 'weekly-delete-select'),
    ])
    await tick([message('Проверка weekly tombstone')])
    await confirm('weekly-delete-confirm')
    await today('g05-weekly-tombstone')
    expect(latestButtonTexts()).not.toContain('✓ задача недели · G05 weekly')
    expect(latestButtonTexts()).toContain('✕ Исправить G05 weekly')
    expect(latestButtonTexts()).toContain('Отменить действие · G05 weekly')
    await tick([
      callback(
        callbackFor('Отменить действие · G05 weekly'),
        'weekly-undo-select',
      ),
    ])
    await confirm('weekly-undo-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-close-preview')
    await tick([callback(callbackFor('Закрыть день'), 'close-select')])
    expect(sent.at(-1)?.text).toContain('Закрыть день')
    const closeConfirm = callbackFor('Подтвердить')
    const model = await tracking.getToday.execute({
      trustedActor: { kind: 'member', id: firstMemberId },
    })
    if (model.state !== 'published') throw new Error('G05 Today missing')
    const goal = model.day.goals.find(
      (value) => value.planGoalSnapshotId === snapshots.get('G05 correct'),
    )
    const fact = goal?.fixedExpectations[0]?.facts.find(
      (value) => value.revisionKind === 'recorded',
    )
    if (fact === undefined) throw new Error('G05 correction fact missing')
    await tracking.correctRecord.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      expectedRevision: fact.revision,
      payload: {
        factRecordId: fact.factRecordId,
        value: { kind: 'boolean', result: 'done' },
        reason: 'Гонка после Telegram preview',
      },
    })
    await tick([callback(closeConfirm, 'close-race-confirm')])
    expect(sent.at(-1)?.text).toContain('Состояние изменилось')

    await today('g05-close-retry')
    await tick([callback(callbackFor('Закрыть день'), 'close-retry-select')])
    await confirm('close-retry-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')
    await today('g05-after-close')
    expect(latestButtonTexts()).not.toContain('Закрыть день')
    expect(latestButtonTexts()).toContain('✕ Исправить G05 correct')
    expect(latestButtonTexts()).toContain('Удалить G05 correct')
    expect(latestButtonTexts()).toContain('Отменить действие · G05 correct')
    expect(latestButtonTexts()).toContain('✕ Исправить G05 weekly')
    await tick([
      callback(
        callbackFor('✕ Исправить G05 correct'),
        'after-close-correction-select',
      ),
    ])
    await tick([message('Исправление после закрытия дня')])
    await confirm('after-close-correction-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    await today('g05-after-close-refresh')
    expect(latestButtonTexts()).toContain('✓ G05 missing')
    await tick([
      callback(callbackFor('✓ G05 missing'), 'fixed-not-done-override-select'),
    ])
    await confirm('fixed-not-done-override-confirm')
    expect(sent.at(-1)?.text).toContain('Сохранено')

    const persisted = await pool.query<{
      readonly day_closes: string
      readonly completed_intents: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM tracking_day_closures
           WHERE publication_id = $1::uuid) day_closes,
         (SELECT count(*)::text FROM telegram_action_intents
           WHERE state = 'completed'
             AND (
               intent_kind LIKE 'correct_%'
               OR intent_kind IN (
                 'delete_record', 'undo_record',
                 'weekly_task_result', 'close_day'
               )
             )) completed_intents`,
      [publicationId],
    )
    expect(persisted.rows[0]).toMatchObject({
      day_closes: '1',
      completed_intents: '12',
    })

    clock.set(new Date('2026-04-11T18:59:00.000Z'))
    await today('g05-before-midnight')
    const midnightClose = callbackFor('Закрыть день')
    clock.set(new Date('2026-04-11T19:01:00.000Z'))
    await tick([callback(midnightClose, 'g05-after-midnight')])
    expect(sent.at(-1)?.text).toContain('Действие устарело')
  }, 120_000)
})
