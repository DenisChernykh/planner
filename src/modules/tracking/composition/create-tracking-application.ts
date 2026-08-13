import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

import { GetFactStateQuery } from '../application/get-fact-state.query'
import { RecordFactCommand } from '../application/record-fact.command'
import type { TrackingApplication } from '../application/tracking-application'
import { PrismaFactPersistence } from '../infrastructure/prisma-fact.persistence'

export function createTrackingApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): TrackingApplication {
  const facts = new PrismaFactPersistence(dependencies.database)
  const executor = new DurableCommandExecutor(
    dependencies.transaction,
    new PrismaCommandReceiptAdapter(dependencies.database),
    dependencies.clock,
  )
  return Object.freeze({
    recordFact: new RecordFactCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    getFactState: new GetFactStateQuery(dependencies.workspaceMembers, facts),
  })
}
