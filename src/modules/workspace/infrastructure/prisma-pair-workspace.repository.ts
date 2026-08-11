import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  PairProvisioningMemberInput,
  PairProvisioningResult,
  PairWorkspacePort,
  PairWorkspaceSnapshot,
} from '../application/pair-workspace.port'
import { WorkspaceDependencyUnavailableError } from '../application/workspace-errors'
import { existingMemberId, existingSpaceId } from '../domain/workspace-ids'

const PAIR_PROVISIONING_ADVISORY_LOCK = 8_503_113_701n

@Injectable()
export class PrismaPairWorkspaceRepository implements PairWorkspacePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async acquireProvisioningLock(): Promise<void> {
    try {
      await this.database.withClient(async (client) => {
        await client.$executeRaw`SELECT pg_advisory_xact_lock(${PAIR_PROVISIONING_ADVISORY_LOCK})`
      })
    } catch (error: unknown) {
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }

  public async findSnapshot(): Promise<PairWorkspaceSnapshot> {
    try {
      return await this.database.withClient(async (client) => {
        const spaces = await client.space.findMany({
          orderBy: { id: 'asc' },
          select: { id: true },
        })
        const memberships = await client.membership.findMany({
          orderBy: { userId: 'asc' },
          select: { id: true, userId: true },
        })
        const allowlist = await client.telegramAccessAllowlist.findMany({
          orderBy: { userId: 'asc' },
          select: { userId: true, telegramId: true },
        })
        return {
          spaces: spaces.map(({ id }) => ({ spaceId: existingSpaceId(id) })),
          members: memberships.map(({ id, userId }) => ({
            memberId: existingMemberId(id),
            userId,
          })),
          allowlist,
        }
      })
    } catch (error: unknown) {
      if (error instanceof WorkspaceDependencyUnavailableError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }

  public async create(
    members: readonly PairProvisioningMemberInput[],
  ): Promise<Omit<PairProvisioningResult, 'status'>> {
    try {
      return await this.database.withClient(async (client) => {
        const space = await client.space.create({
          data: { singletonKey: 1 },
          select: { id: true },
        })
        const createdMembers = []
        for (const [index, member] of members.entries()) {
          const membership = await client.membership.create({
            data: {
              spaceId: space.id,
              userId: member.userId,
              slot: index + 1,
            },
            select: { id: true, userId: true },
          })
          await client.telegramAccessAllowlist.create({
            data: {
              spaceId: space.id,
              userId: member.userId,
              telegramId: member.telegramId,
            },
          })
          createdMembers.push({
            memberId: existingMemberId(membership.id),
            userId: membership.userId,
          })
        }
        return {
          spaceId: existingSpaceId(space.id),
          members: createdMembers,
        }
      })
    } catch (error: unknown) {
      if (error instanceof WorkspaceDependencyUnavailableError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }
}
