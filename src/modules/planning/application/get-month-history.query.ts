import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import type {
  MonthHistoryEventRecord,
  MonthHistoryHeaderRecord,
  MonthHistoryReadPort,
} from './month-history.read.port'
import {
  PlanMonthNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u

export interface GetMonthHistoryInput {
  readonly trustedUserId: string
  readonly planMonthId: string
  readonly limit?: number
  readonly cursor?: string
}

export interface MonthHistoryPage {
  readonly schemaVersion: 'planning.month-history.v1'
  readonly planMonthId: string
  readonly targetMonth: string
  readonly current: MonthHistoryHeaderRecord['current']
  readonly items: readonly MonthHistoryEventRecord[]
  readonly nextCursor: string | null
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

export class GetMonthHistoryQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly history: MonthHistoryReadPort,
    private readonly transaction: DatabaseTransactionPort,
  ) {}

  public async execute(input: GetMonthHistoryInput): Promise<MonthHistoryPage> {
    const limit = input.limit ?? DEFAULT_LIMIT
    if (
      !UUID.test(input.trustedUserId) ||
      !UUID.test(input.planMonthId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      (input.cursor !== undefined && !POSITIVE.test(input.cursor))
    ) {
      throw new CommandValidationError()
    }
    try {
      return await this.transaction.run(
        async () => {
          let member
          try {
            member = await this.workspaceMembers.resolveUser(
              input.trustedUserId,
            )
          } catch (error: unknown) {
            if (error instanceof WorkspaceMemberNotFoundError) {
              throw new PlanningAuthorizationDeniedError()
            }
            if (error instanceof WorkspaceDependencyUnavailableError) {
              throw new PlanningDependencyUnavailableError({ cause: error })
            }
            throw error
          }
          const header = await this.history.readHeader({
            spaceId: member.spaceId,
            planMonthId: input.planMonthId,
          })
          if (header === null) throw new PlanMonthNotFoundError()
          const rows = await this.history.readEvents({
            spaceId: member.spaceId,
            planMonthId: input.planMonthId,
            limit: limit + 1,
            cursor: input.cursor === undefined ? null : BigInt(input.cursor),
          })
          const items = rows.slice(0, limit)
          return freeze({
            schemaVersion: 'planning.month-history.v1' as const,
            planMonthId: header.planMonthId,
            targetMonth: header.targetMonth,
            current: header.current,
            items,
            nextCursor:
              rows.length > limit ? items.at(-1)!.after.revision : null,
          })
        },
        { mode: 'repeatable_read_only' },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof PlanMonthNotFoundError ||
        error instanceof PlanningAuthorizationDeniedError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
