import { createLocalUserProvisioningPort } from '@/modules/auth'
import type { ProvisionPairRuntimeConfig } from '@/platform/config/provision-pair-runtime-config'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'

import type {
  PairProvisioningInput,
  PairProvisioningResult,
} from '../application/pair-workspace.port'
import { ProvisionPairUseCase } from '../application/provision-pair.use-case'
import { PrismaPairWorkspaceRepository } from '../infrastructure/prisma-pair-workspace.repository'

export interface PairProvisioningRuntime {
  start(signal: AbortSignal): Promise<void>
  provision(input: PairProvisioningInput): Promise<PairProvisioningResult>
  close(signal: AbortSignal): Promise<void>
}

export function createPairProvisioningRuntime(
  config: ProvisionPairRuntimeConfig,
): PairProvisioningRuntime {
  const context = new PrismaTransactionContext()
  const database = new PrismaClientProvider(config, context)
  const transaction = new PrismaTransactionAdapter(database, context, config)
  const users = createLocalUserProvisioningPort(database)
  const workspace = new PrismaPairWorkspaceRepository(database)
  const provision = new ProvisionPairUseCase(transaction, users, workspace)
  return {
    start: (signal) => database.connect(signal),
    provision: (input) => provision.execute(input),
    close: (signal) => database.close(signal),
  }
}
