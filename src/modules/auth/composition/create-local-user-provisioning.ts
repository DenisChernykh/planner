import type { LocalUserProvisioningPort } from '../application/local-user-provisioning.port'
import { PrismaLocalUserProvisioningRepository } from '../infrastructure/prisma-local-user-provisioning.repository'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

export function createLocalUserProvisioningPort(
  database: PrismaClientProvider,
): LocalUserProvisioningPort {
  return new PrismaLocalUserProvisioningRepository(database)
}
