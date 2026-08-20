import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  MemberContext,
  WorkspaceMemberResolver,
  WorkspaceTelegramRecipientResolver,
} from '../application/workspace-member-resolver.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
  WorkspaceTelegramRecipientNotFoundError,
} from '../application/workspace-errors'

interface ResolvedRow {
  readonly id: string
  readonly spaceId: string
  readonly userId: string
}

function toMemberContext(row: ResolvedRow | null): MemberContext {
  if (row === null) throw new WorkspaceMemberNotFoundError()
  return {
    spaceId: row.spaceId,
    memberId: row.id,
    userId: row.userId,
  }
}

@Injectable()
export class PrismaWorkspaceMemberResolver
  implements WorkspaceMemberResolver, WorkspaceTelegramRecipientResolver
{
  public constructor(private readonly database: PrismaClientProvider) {}

  public async resolveUser(userId: string): Promise<MemberContext> {
    try {
      const row = await this.database.withClient((client) =>
        client.membership.findUnique({
          where: { userId },
          select: { id: true, spaceId: true, userId: true },
        }),
      )
      return toMemberContext(row)
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }

  public async resolveTelegramId(telegramId: bigint): Promise<MemberContext> {
    try {
      const row = await this.database.withClient(async (client) => {
        const access = await client.telegramAccessAllowlist.findUnique({
          where: { telegramId },
          select: {
            membership: {
              select: { id: true, spaceId: true, userId: true },
            },
          },
        })
        return access?.membership ?? null
      })
      return toMemberContext(row)
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }

  public async resolveMember(memberId: string): Promise<MemberContext> {
    try {
      const row = await this.database.withClient((client) =>
        client.membership.findUnique({
          where: { id: memberId },
          select: { id: true, spaceId: true, userId: true },
        }),
      )
      return toMemberContext(row)
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }

  public async resolveTelegramRecipient(memberId: string): Promise<bigint> {
    try {
      const row = await this.database.withClient((client) =>
        client.membership.findUnique({
          where: { id: memberId },
          select: { allowlist: { select: { telegramId: true } } },
        }),
      )
      const telegramId = row?.allowlist?.telegramId
      if (telegramId === undefined) {
        throw new WorkspaceTelegramRecipientNotFoundError()
      }
      return telegramId
    } catch (error: unknown) {
      if (error instanceof WorkspaceTelegramRecipientNotFoundError) {
        throw error
      }
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }
}
