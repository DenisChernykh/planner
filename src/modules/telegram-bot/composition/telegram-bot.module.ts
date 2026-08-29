import { Module, type DynamicModule } from '@nestjs/common'

import {
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
import {
  WorkspaceModule,
  WORKSPACE_MEMBER_RESOLVER,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { RuntimeConfigService } from '@/platform/config/runtime-config.service'
import { DatabaseModule } from '@/platform/database/database.module'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  TELEGRAM_BOT_API,
  TELEGRAM_INGRESS_LIFECYCLE,
  type TelegramBotApiPort,
  type TelegramIngressLifecycle,
} from '../application/telegram-bot.types'
import { TelegramUpdateHandler } from '../application/telegram-update.handler'
import { TelegramActionIntentService } from '../application/action-intent.service'
import { GetBotNavigationQuery } from '../application/get-bot-navigation.query'
import {
  GetUpdatesRunner,
  DisabledTelegramIngress,
} from '../infrastructure/get-updates.runner'
import { TelegramBotApiClient } from '../infrastructure/telegram-bot-api.client'
import { PrismaTelegramIngressStateRepository } from '../infrastructure/prisma-telegram-ingress-state.repository'
import { PrismaActionIntentRepository } from '../infrastructure/prisma-action-intent.repository'
import { TelegramNavigationController } from '../presentation/telegram-navigation.controller'

const TELEGRAM_TRACKING_APPLICATION: unique symbol = Symbol(
  'TELEGRAM_TRACKING_APPLICATION',
)

@Module({})
export class TelegramBotModule {
  public static forRoot(
    clock: ProductClock = new SystemProductClock(),
  ): DynamicModule {
    return {
      module: TelegramBotModule,
      imports: [DatabaseModule, WorkspaceModule],
      controllers: [TelegramNavigationController],
      providers: [
        {
          provide: GetBotNavigationQuery,
          inject: [RuntimeConfigService],
          useFactory: (config: RuntimeConfigService) =>
            new GetBotNavigationQuery(config.telegramBot.navigationUrl),
        },
        PrismaTelegramIngressStateRepository,
        PrismaActionIntentRepository,
        {
          provide: TELEGRAM_TRACKING_APPLICATION,
          inject: [
            PrismaClientProvider,
            DATABASE_TRANSACTION_PORT,
            WORKSPACE_MEMBER_RESOLVER,
          ],
          useFactory: (
            database: PrismaClientProvider,
            transaction: DatabaseTransactionPort,
            workspaceMembers: WorkspaceMemberResolver,
          ) =>
            createTrackingApplication({
              database,
              transaction,
              workspaceMembers,
              clock,
            }),
        },
        {
          provide: TelegramActionIntentService,
          inject: [
            PrismaActionIntentRepository,
            TELEGRAM_TRACKING_APPLICATION,
            DATABASE_TRANSACTION_PORT,
          ],
          useFactory: (
            intents: PrismaActionIntentRepository,
            tracking: TrackingApplication,
            transaction: DatabaseTransactionPort,
          ) =>
            new TelegramActionIntentService(
              intents,
              tracking,
              transaction,
              clock,
            ),
        },
        {
          provide: TELEGRAM_BOT_API,
          inject: [RuntimeConfigService],
          useFactory: (config: RuntimeConfigService): TelegramBotApiPort => {
            const bot = config.telegramBot
            if (bot.ingressMode === 'disabled' || bot.token === undefined) {
              return {
                getUpdates: () =>
                  Promise.reject(new Error('Telegram ingress is disabled')),
                sendMessage: () =>
                  Promise.reject(new Error('Telegram ingress is disabled')),
                answerCallbackQuery: () =>
                  Promise.reject(new Error('Telegram ingress is disabled')),
              }
            }
            return new TelegramBotApiClient(bot.token, bot)
          },
        },
        {
          provide: TelegramUpdateHandler,
          inject: [
            WORKSPACE_MEMBER_RESOLVER,
            TELEGRAM_TRACKING_APPLICATION,
            TelegramActionIntentService,
            RuntimeConfigService,
          ],
          useFactory: (
            workspaceMembers: WorkspaceMemberResolver,
            tracking: TrackingApplication,
            actionIntents: TelegramActionIntentService,
            config: RuntimeConfigService,
          ) =>
            new TelegramUpdateHandler(
              workspaceMembers,
              tracking.getToday,
              new URL(
                '/auth/telegram/start',
                config.auth.telegramOidc.callbackUrl,
              ).toString(),
              actionIntents,
            ),
        },
        {
          provide: TELEGRAM_INGRESS_LIFECYCLE,
          inject: [
            RuntimeConfigService,
            PrismaTelegramIngressStateRepository,
            TELEGRAM_BOT_API,
            TelegramUpdateHandler,
          ],
          useFactory: (
            config: RuntimeConfigService,
            state: PrismaTelegramIngressStateRepository,
            botApi: TelegramBotApiPort,
            handler: TelegramUpdateHandler,
          ): TelegramIngressLifecycle =>
            config.telegramBot.ingressMode === 'disabled'
              ? new DisabledTelegramIngress()
              : new GetUpdatesRunner(
                  state,
                  botApi,
                  handler,
                  config.telegramBot.getUpdatesTimeoutSeconds,
                ),
        },
      ],
      exports: [TELEGRAM_INGRESS_LIFECYCLE],
    }
  }
}
