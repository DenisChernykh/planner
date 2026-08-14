import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type { TelegramIngressStatePort } from '../application/telegram-bot.types'

const consumerKey = 'local-get-updates.v1'
const maxUpdateId = 4_503_599_627_370_495n
const maxNextUpdateId = maxUpdateId + 1n

type OffsetRow = { readonly next_update_id: bigint }

@Injectable()
export class PrismaTelegramIngressStateRepository implements TelegramIngressStatePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public getNextUpdateId(): Promise<bigint> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<OffsetRow[]>`
        SELECT next_update_id
          FROM telegram_ingress_state
         WHERE consumer_key = ${consumerKey}
      `
      const row = rows[0]
      if (row === undefined)
        throw new Error('Telegram ingress state is missing')
      if (row.next_update_id < 0n || row.next_update_id > maxNextUpdateId) {
        throw new Error('Telegram ingress state is invalid')
      }
      return row.next_update_id
    })
  }

  public claim(updateId: bigint): Promise<boolean> {
    if (updateId < 1n || updateId > maxUpdateId) {
      return Promise.reject(new Error('Telegram update identifier is invalid'))
    }
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<OffsetRow[]>`
        UPDATE telegram_ingress_state
           SET next_update_id = ${updateId + 1n},
               revision = revision + 1
         WHERE consumer_key = ${consumerKey}
           AND next_update_id <= ${updateId}
        RETURNING next_update_id
      `
      return rows.length === 1
    })
  }
}
