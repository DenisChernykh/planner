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

type PublishedConfig = {
  readonly measurement: {
    readonly items?: readonly { readonly itemId: string }[]
    readonly variants?: readonly { readonly variantId: string }[]
  }
  readonly checkpoints?: {
    readonly items: readonly { readonly checkpointId: string }[]
  } | null
}

describe('G04 Telegram text, checklist and OR actions', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let app: NestExpressApplication
  let database: PrismaClientProvider
  let lifecycle: TelegramIngressLifecycle
  let clock: FakeProductClock
  let tracking: ReturnType<typeof createTrackingApplication>
  const sent: TelegramSendMessage[] = []
  const batches: unknown[][] = []
  let updateId = 700
  let publicationId: string
  let checklistSnapshotId: string
  let checklistItemIds: string[]
  let orVariantIds: string[]

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_g04_e2e')
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
    const runtimeConfig = buildApiRuntimeConfig({
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
      TELEGRAM_OIDC_CLIENT_SECRET: 'telegram-g04-client-secret',
      TELEGRAM_OIDC_CALLBACK_URL:
        'http://127.0.0.1:3000/auth/telegram/callback',
      TELEGRAM_INGRESS_MODE: 'get_updates',
      TELEGRAM_BOT_TOKEN: '123456789:telegram-g04-bot-token',
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
      payload: { targetMonth: '2026-04', focus: 'G04 composite Telegram' },
    })
    const goals: readonly {
      readonly key: string
      readonly config: DraftGoalConfigV1
    }[] = [
      {
        key: 'text',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: null,
        },
      },
      {
        key: 'checklist',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: null, label: 'Первый пункт' },
              { itemId: null, label: 'Второй пункт' },
            ],
          },
          checkpoints: null,
        },
      },
      {
        key: 'or',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'any_of',
            variants: [
              {
                variantId: null,
                label: 'Книги',
                unit: 'стр.',
                precision: 1,
                target: '10',
              },
              {
                variantId: null,
                label: 'Аудио',
                unit: 'мин.',
                precision: 0,
                target: '20',
              },
            ],
          },
          checkpoints: null,
        },
      },
      {
        key: 'checkpoint-text',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'text' },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Текстовый checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'text' },
              },
            ],
          },
        },
      },
      {
        key: 'checkpoint-checklist',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'checklist',
            items: [{ itemId: null, label: 'Checkpoint пункт' }],
          },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'Checklist checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'checklist' },
              },
            ],
          },
        },
      },
      {
        key: 'checkpoint-or',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: {
            kind: 'any_of',
            variants: [
              {
                variantId: null,
                label: 'Checkpoint вариант',
                unit: 'шт.',
                precision: 0,
                target: '1',
              },
            ],
          },
          checkpoints: {
            aggregation: 'independent',
            items: [
              {
                checkpointId: null,
                name: 'OR checkpoint',
                deadline: '20:00',
                satisfaction: { kind: 'any_of' },
              },
            ],
          },
        },
      },
      {
        key: 'flex-checklist',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'weekly', n: '2' },
          measurement: {
            kind: 'checklist',
            items: [{ itemId: null, label: 'Гибкий пункт' }],
          },
          checkpoints: null,
        },
      },
      {
        key: 'flex-or',
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'weekly', n: '2' },
          measurement: {
            kind: 'any_of',
            variants: [
              {
                variantId: null,
                label: 'Гибкий вариант',
                unit: 'шт.',
                precision: 0,
                target: '2',
              },
            ],
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
          title: `G04 ${goals[index]!.key}`,
          why: 'G04 E2E',
          category: 'G04',
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
    if (preview === null) throw new Error('G04 publication preview missing')
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
      readonly config: PublishedConfig
    }>(
      `SELECT id::text, title, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publicationId],
    )
    const snapshot = (key: string): string =>
      rows.rows.find((row) => row.title === `G04 ${key}`)?.id ??
      (() => {
        throw new Error(`G04 snapshot ${key} missing`)
      })()
    const config = (key: string): PublishedConfig =>
      rows.rows.find((row) => row.title === `G04 ${key}`)?.config ??
      (() => {
        throw new Error(`G04 config ${key} missing`)
      })()
    const checkpoint = (key: string): string =>
      config(key).checkpoints?.items[0]?.checkpointId ??
      (() => {
        throw new Error(`G04 checkpoint ${key} missing`)
      })()
    checklistSnapshotId = snapshot('checklist')
    checklistItemIds = config('checklist').measurement.items!.map(
      (item) => item.itemId,
    )
    orVariantIds = config('or').measurement.variants!.map(
      (variant) => variant.variantId,
    )
    checkpoint('checkpoint-text')
    checkpoint('checkpoint-checklist')
    checkpoint('checkpoint-or')
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

  it('maps fixed and flexible composite inputs with partial progress and opaque callbacks', async () => {
    await today('g04-today')
    expect(callbackFor('✓ G04 text')).toMatch(/^pl1:s:[0-9a-f-]{36}$/u)
    expect(callbackFor('✓ G04 checklist · Первый пункт')).toMatch(
      /^pl1:s:[0-9a-f-]{36}$/u,
    )
    const callbackPayloads = sent.flatMap(
      (value) => value.replyMarkup?.inline_keyboard.flat() ?? [],
    )
    for (const button of callbackPayloads) {
      if (!('callback_data' in button)) continue
      expect(
        Buffer.byteLength(button.callback_data, 'utf8'),
      ).toBeLessThanOrEqual(64)
      expect(button.callback_data).not.toContain(checklistItemIds[0]!)
      expect(button.callback_data).not.toContain(orVariantIds[0]!)
      expect(button.callback_data).not.toContain(publicationId)
    }

    await tick([callback(callbackFor('✓ G04 text'), 'text-select')])
    await tick([message('   ')])
    expect(sent.at(-1)?.text).toContain('Текст пустой')
    await tick([message('x'.repeat(4_096))])
    expect(sent.at(-1)?.text).toContain('слишком длинный')
    await tick([message('Запись из Telegram')])
    expect(sent.at(-1)?.text).toContain('Запись из Telegram')
    const confirm = callbackFor('Подтвердить')
    await tick([
      callback(confirm, 'text-confirm-a'),
      callback(confirm, 'text-confirm-b'),
    ])

    await today('g04-checkpoint-text')
    await tick([
      callback(
        callbackFor('✓ G04 checkpoint-text · Текстовый checkpoint'),
        'checkpoint-text-select',
      ),
    ])
    await tick([message('Checkpoint text')])
    await tick([
      callback(callbackFor('Подтвердить'), 'checkpoint-text-confirm'),
    ])

    await today('g04-checkpoint-checklist')
    await tick([
      callback(
        callbackFor(
          '✓ G04 checkpoint-checklist · Checklist checkpoint · Checkpoint пункт',
        ),
        'checkpoint-checklist-select',
      ),
    ])
    await tick([
      callback(callbackFor('Подтвердить'), 'checkpoint-checklist-confirm'),
    ])

    await today('g04-checkpoint-or')
    await tick([
      callback(
        callbackFor(
          'Ввести G04 checkpoint-or · OR checkpoint · Checkpoint вариант',
        ),
        'checkpoint-or-select',
      ),
    ])
    await tick([message('1')])
    await tick([callback(callbackFor('Подтвердить'), 'checkpoint-or-confirm')])

    await today('g04-checklist')
    await tick([
      callback(
        callbackFor('✓ G04 checklist · Первый пункт'),
        'checklist-select',
      ),
    ])
    await tick([callback(callbackFor('Подтвердить'), 'checklist-confirm')])
    await today('g04-partial')
    expect(
      sent
        .at(-1)
        ?.replyMarkup?.inline_keyboard.flat()
        .map((value) => value.text),
    ).toContain('✓ G04 checklist · Второй пункт')

    await tick([callback(callbackFor('Ввести G04 or · Книги'), 'or-select')])
    await tick([message('1.25')])
    expect(sent.at(-1)?.text).toContain('G04 or · Книги')
    expect(sent.at(-1)?.text).toContain('Значение некорректно')
    await tick([message('1.2')])
    expect(sent.at(-1)?.text).toContain('Значение:')
    const orConfirm = callbackFor('Подтвердить')
    await tracking.recordChecklistItem.execute({
      commandId: randomUUID(),
      trustedActor: { kind: 'member', id: firstMemberId },
      payload: {
        publicationId,
        planGoalSnapshotId: checklistSnapshotId,
        expectationDate: '2026-04-10',
        checkpointId: null,
        checklistItemId: checklistItemIds[1]!,
        state: 'done',
      },
    })
    await tick([callback(orConfirm, 'or-stale-confirm')])
    expect(sent.at(-1)?.text).toContain('Состояние изменилось')

    await today('g04-flexible')
    await tick([
      callback(
        callbackFor('✓ G04 flex-checklist · Гибкий пункт'),
        'flex-checklist-select',
      ),
    ])
    await tick([callback(callbackFor('Подтвердить'), 'flex-checklist-confirm')])
    await today('g04-flexible-or')
    await tick([
      callback(
        callbackFor('Ввести G04 flex-or · Гибкий вариант'),
        'flex-or-select',
      ),
    ])
    await tick([message('1')])
    await tick([callback(callbackFor('Подтвердить'), 'flex-or-confirm')])

    const records = await pool.query<{
      readonly fact_kind: string
      readonly checklist_item_id: string | null
      readonly or_variant_id: string | null
    }>(
      `SELECT fact_kind, checklist_item_id::text, or_variant_id::text
         FROM tracking_fact_records
        WHERE publication_id = $1::uuid`,
      [publicationId],
    )
    expect(records.rows.map((row) => row.fact_kind)).toEqual(
      expect.arrayContaining(['text', 'checklist_item', 'or_variant']),
    )
    expect(records.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checklist_item_id: checklistItemIds[0] }),
      ]),
    )
    const recordedVariant = records.rows.find(
      (row) => row.fact_kind === 'or_variant',
    )?.or_variant_id
    expect(recordedVariant).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
  }, 120_000)

  it('expires a selected OR action before confirmation', async () => {
    await today('g04-expiry')
    await tick([
      callback(callbackFor('Ввести G04 or · Аудио'), 'or-expiry-select'),
    ])
    await tick([message('2')])
    clock.set(new Date('2026-04-10T19:11:00.000Z'))
    await tick([callback(callbackFor('Подтвердить'), 'or-expired-confirm')])
    expect(sent.at(-1)?.text).toContain('Действие устарело')
  }, 120_000)
})
