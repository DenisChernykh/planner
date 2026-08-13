import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import type { TrackingReadPersistencePort } from './tracking-read-persistence.port'
import type {
  GetMonthInput,
  GetTodayInput,
  TrackingMonthReadModelV1,
  TrackingTodayReadModelV1,
} from './tracking-read.types'
import {
  snapshotGetMonthInput,
  snapshotGetTodayInput,
} from './tracking-read.validation'

async function memberContext(
  workspaceMembers: WorkspaceMemberResolver,
  memberId: string,
): Promise<{ readonly spaceId: string; readonly memberId: string }> {
  try {
    const member = await workspaceMembers.resolveMember(memberId)
    return { spaceId: member.spaceId, memberId: member.memberId }
  } catch (error: unknown) {
    if (error instanceof WorkspaceMemberNotFoundError) {
      throw new TrackingAuthorizationDeniedError()
    }
    if (error instanceof WorkspaceDependencyUnavailableError) {
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
    throw error
  }
}

function accepted(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export class GetMonthQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly reads: TrackingReadPersistencePort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: GetMonthInput,
  ): Promise<TrackingMonthReadModelV1> {
    try {
      const snapshot = snapshotGetMonthInput(input)
      if (snapshot.trustedActor.kind !== 'member') {
        throw new TrackingAuthorizationDeniedError()
      }
      const member = await memberContext(
        this.workspaceMembers,
        snapshot.trustedActor.id,
      )
      const queryLocalDate = this.clock.today('Asia/Yekaterinburg')
      const value = await this.transaction.run(() =>
        this.reads.getMonth({
          ...member,
          targetMonth: snapshot.targetMonth,
          queryLocalDate,
          selectedLocalDate: null,
        }),
      )
      return Object.freeze({ schemaVersion: 'tracking.month.v1', ...value })
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}

export class GetTodayQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly reads: TrackingReadPersistencePort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: GetTodayInput,
  ): Promise<TrackingTodayReadModelV1> {
    try {
      const snapshot = snapshotGetTodayInput(input)
      if (snapshot.trustedActor.kind !== 'member') {
        throw new TrackingAuthorizationDeniedError()
      }
      const queryLocalDate = this.clock.today('Asia/Yekaterinburg')
      const member = await memberContext(
        this.workspaceMembers,
        snapshot.trustedActor.id,
      )
      const value = await this.transaction.run(() =>
        this.reads.getMonth({
          ...member,
          targetMonth: queryLocalDate.slice(0, 7),
          queryLocalDate,
          selectedLocalDate: queryLocalDate,
        }),
      )
      if (value.state !== 'published') {
        return Object.freeze({ schemaVersion: 'tracking.today.v1', ...value })
      }
      const day = value.days[0]
      if (day === undefined || day.localDate !== queryLocalDate) {
        throw new Error('Today read model did not contain the requested date')
      }
      const { days: _days, ...published } = value
      void _days
      return Object.freeze({
        schemaVersion: 'tracking.today.v1',
        ...published,
        day,
      })
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
