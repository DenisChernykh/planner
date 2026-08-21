import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import { PrismaWorkspaceMemberResolver } from '../infrastructure/prisma-workspace-member.resolver'

export function createWorkspaceMemberResolver(
  database: PrismaClientProvider,
): PrismaWorkspaceMemberResolver {
  return new PrismaWorkspaceMemberResolver(database)
}
