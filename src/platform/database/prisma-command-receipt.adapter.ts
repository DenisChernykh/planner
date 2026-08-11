import { Injectable } from '@nestjs/common'

import { canonicalJsonStringify } from '@/shared/application/command-fingerprint'
import type {
  CommandReceiptKey,
  CommandReceiptPort,
  CompletedCommandReceipt,
} from '@/shared/application/command-receipt.port'

import { PrismaClientProvider } from './prisma-client.provider'

const RECEIPT_LOCK_SEED = 8_503_113_703n

@Injectable()
export class PrismaCommandReceiptAdapter implements CommandReceiptPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async acquireLock(key: CommandReceiptKey): Promise<void> {
    const keyJson = canonicalJsonStringify({
      actorScope: key.actorScope,
      commandType: key.commandType,
      commandId: key.commandId,
    })
    await this.database.withClient(async (client) => {
      await client.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${keyJson}, ${RECEIPT_LOCK_SEED})
        )
      `
    })
  }

  public findCompleted(
    key: CommandReceiptKey,
  ): Promise<CompletedCommandReceipt | null> {
    return this.database.withClient(async (client) => {
      const row = await client.commandReceipt.findUnique({
        where: {
          actorScope_commandType_commandId: key,
        },
      })
      if (row === null) return null
      return {
        actorScope: row.actorScope,
        commandType: row.commandType,
        commandId: row.commandId,
        fingerprint: row.fingerprint,
        resultKind: row.resultKind,
        aggregateId: row.aggregateId,
        aggregateRevision: row.aggregateRevision,
        completedAt: new Date(row.completedAt.getTime()),
      }
    })
  }

  public async insertCompleted(
    receipt: CompletedCommandReceipt,
  ): Promise<void> {
    await this.database.withClient(async (client) => {
      await client.commandReceipt.create({
        data: {
          actorScope: receipt.actorScope,
          commandType: receipt.commandType,
          commandId: receipt.commandId,
          fingerprint: receipt.fingerprint,
          resultKind: receipt.resultKind,
          aggregateId: receipt.aggregateId,
          aggregateRevision: receipt.aggregateRevision,
          completedAt: receipt.completedAt,
        },
      })
    })
  }
}
