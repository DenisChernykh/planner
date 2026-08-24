import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  CurrentWorkspaceReadPort,
  CurrentWorkspaceSnapshot,
} from '../application/current-workspace.read.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '../application/workspace-errors'
import { existingMemberId, existingSpaceId } from '../domain/workspace-ids'

interface CurrentWorkspaceRow {
  readonly space_id: string
  readonly current_member_id: string
  readonly member_id: string
  readonly member_a_member_id: string | null
  readonly member_b_member_id: string | null
}

@Injectable()
export class PrismaCurrentWorkspaceRead implements CurrentWorkspaceReadPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async readByUser(userId: string): Promise<CurrentWorkspaceSnapshot> {
    try {
      const rows = await this.database.withClient(
        (client) =>
          client.$queryRaw<CurrentWorkspaceRow[]>`
          WITH current_member AS (
            SELECT membership.space_id,
                   membership.id AS current_member_id
              FROM memberships membership
             WHERE membership.user_id = ${userId}::uuid
          ),
          seed_mapping AS (
            SELECT consumption.space_id,
                   consumption.member_a_member_id::text AS member_a_member_id,
                   consumption.member_b_member_id::text AS member_b_member_id
              FROM planning_seed_consumptions consumption
             WHERE consumption.seed_id = 'april-plan'
          )
          SELECT current_member.space_id::text AS space_id,
                 current_member.current_member_id::text AS current_member_id,
                 member.id::text AS member_id,
                 seed_mapping.member_a_member_id,
                 seed_mapping.member_b_member_id
            FROM current_member
            JOIN memberships member
              ON member.space_id = current_member.space_id
            LEFT JOIN seed_mapping
              ON seed_mapping.space_id = current_member.space_id
           ORDER BY CASE
                      WHEN member.id = current_member.current_member_id THEN 0
                      ELSE 1
                    END,
                    member.id
        `,
      )
      const first = rows[0]
      if (first === undefined) throw new WorkspaceMemberNotFoundError()
      return {
        spaceId: existingSpaceId(first.space_id),
        currentMemberId: existingMemberId(first.current_member_id),
        members: rows.map((row) => ({
          memberId: existingMemberId(row.member_id),
        })),
        denisMemberId:
          first.member_a_member_id === null
            ? null
            : existingMemberId(first.member_a_member_id),
        tanyaMemberId:
          first.member_b_member_id === null
            ? null
            : existingMemberId(first.member_b_member_id),
      }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) throw error
      throw new WorkspaceDependencyUnavailableError({ cause: error })
    }
  }
}
