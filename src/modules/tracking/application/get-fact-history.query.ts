import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import type {
  FactHistoryEventRecord,
  FactHistoryHeaderRecord,
  FactHistoryReadPort,
} from './fact-history.read.port'
import {
  FactTargetNotFoundError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u

export interface GetFactHistoryInput {
  readonly trustedUserId: string
  readonly factRecordId: string
  readonly limit?: number
  readonly cursor?: string
}

export interface FactHistoryPage {
  readonly schemaVersion: 'tracking.fact-history.v1'
  readonly factRecordId: string
  readonly originalActor: FactHistoryHeaderRecord['originalActor']
  readonly createdAt: string
  readonly currentRevision: FactHistoryHeaderRecord['currentRevision']
  readonly items: readonly FactHistoryEventRecord[]
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

export class GetFactHistoryQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly history: FactHistoryReadPort,
    private readonly transaction: DatabaseTransactionPort,
  ) {}

  public async execute(input: GetFactHistoryInput): Promise<FactHistoryPage> {
    const limit = input.limit ?? DEFAULT_LIMIT
    if (
      !UUID.test(input.trustedUserId) ||
      !UUID.test(input.factRecordId) ||
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
              throw new TrackingAuthorizationDeniedError()
            }
            if (error instanceof WorkspaceDependencyUnavailableError) {
              throw new TrackingDependencyUnavailableError({ cause: error })
            }
            throw error
          }
          const header = await this.history.readHeader({
            spaceId: member.spaceId,
            factRecordId: input.factRecordId,
          })
          if (header === null) throw new FactTargetNotFoundError()
          const rows = await this.history.readEvents({
            spaceId: member.spaceId,
            factRecordId: input.factRecordId,
            limit: limit + 1,
            cursor: input.cursor === undefined ? null : BigInt(input.cursor),
          })
          const items = rows.slice(0, limit)
          return freeze({
            schemaVersion: 'tracking.fact-history.v1' as const,
            factRecordId: header.factRecordId,
            originalActor: header.originalActor,
            createdAt: header.createdAt,
            currentRevision: header.currentRevision,
            items,
            nextCursor:
              rows.length > limit ? items.at(-1)!.afterRevision.revision : null,
          })
        },
        { mode: 'repeatable_read_only' },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof FactTargetNotFoundError ||
        error instanceof TrackingAuthorizationDeniedError ||
        error instanceof TrackingDependencyUnavailableError
      ) {
        throw error
      }
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
