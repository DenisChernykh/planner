import {
  type MemberContext,
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import {
  isCanonicalCalendarMonth,
  isCanonicalPlanningUuid,
} from '@/modules/planning/domain/planning-values'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'
import type { ActorRef } from '@/shared/application/application-command'

import { calculatePilotReport } from './calculate-pilot-report.use-case'
import {
  PilotReportAuthorizationDeniedError,
  PilotReportDependencyUnavailableError,
  PilotReportQueryValidationError,
  PilotReportSourceChangedError,
  PilotReportSourceInvalidError,
  PilotReportSourceNotFoundError,
} from './pilot-report.errors'
import type { PilotReportMonthReadPort } from './pilot-report-read.port'
import { buildPilotReportSeries } from './pilot-series.builder'
import {
  PILOT_REPORT_READ_SCHEMA_VERSION,
  type BuildPilotReportInput,
  type PilotReportReadModelV1,
} from './pilot-report.types'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

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

function monthEnd(targetMonth: string): string {
  const year = Number(targetMonth.slice(0, 4))
  const month = Number(targetMonth.slice(5, 7))
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${targetMonth}-${String(day).padStart(2, '0')}`
}

function snapshotInput(input: BuildPilotReportInput): BuildPilotReportInput {
  if (
    input === null ||
    typeof input !== 'object' ||
    input.trustedActor === null ||
    typeof input.trustedActor !== 'object' ||
    input.trustedActor.kind !== 'member' ||
    !UUID.test(input.trustedActor.id) ||
    !isCanonicalCalendarMonth(input.targetMonth)
  ) {
    throw new PilotReportQueryValidationError()
  }
  return Object.freeze({
    trustedActor: Object.freeze({
      kind: 'member' as const,
      id: input.trustedActor.id,
    }),
    targetMonth: input.targetMonth,
  })
}

async function resolveMember(
  resolver: WorkspaceMemberResolver,
  actor: ActorRef,
): Promise<MemberContext> {
  if (actor.kind !== 'member' || !isCanonicalPlanningUuid(actor.id)) {
    throw new PilotReportAuthorizationDeniedError()
  }
  try {
    return await resolver.resolveMember(actor.id)
  } catch (error: unknown) {
    if (error instanceof WorkspaceMemberNotFoundError) {
      throw new PilotReportAuthorizationDeniedError()
    }
    if (error instanceof WorkspaceDependencyUnavailableError) {
      throw new PilotReportDependencyUnavailableError({ cause: error })
    }
    throw new PilotReportDependencyUnavailableError({ cause: error })
  }
}

function accepted(error: unknown): boolean {
  return (
    error instanceof PilotReportAuthorizationDeniedError ||
    error instanceof PilotReportDependencyUnavailableError ||
    error instanceof PilotReportQueryValidationError ||
    error instanceof PilotReportSourceChangedError ||
    error instanceof PilotReportSourceInvalidError ||
    error instanceof PilotReportSourceNotFoundError
  )
}

export class BuildPilotReportQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly reports: PilotReportMonthReadPort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: BuildPilotReportInput,
  ): Promise<PilotReportReadModelV1> {
    try {
      const snapshot = snapshotInput(input)
      const member = await resolveMember(
        this.workspaceMembers,
        snapshot.trustedActor,
      )
      const queryLocalDate = this.clock.today('Asia/Yekaterinburg')
      const asOfLocalDate = [
        queryLocalDate,
        monthEnd(snapshot.targetMonth),
      ].sort()[0]!
      const monthSource = await this.transaction.run(
        () =>
          this.reports.loadByMonth({
            spaceId: member.spaceId,
            targetMonth: snapshot.targetMonth,
            asOfLocalDate,
          }),
        { mode: 'repeatable_read_only' },
      )
      if (monthSource === null || monthSource.activeLocalDate > asOfLocalDate) {
        throw new PilotReportSourceNotFoundError()
      }
      if (monthSource.lifecycleStatus === 'closed') {
        return monthSource.storedReport
      }
      const report = calculatePilotReport(
        {
          spaceId: member.spaceId,
          publicationId: monthSource.source.publicationId,
          asOfLocalDate,
        },
        monthSource.source,
      )
      return freeze({
        schemaVersion: PILOT_REPORT_READ_SCHEMA_VERSION,
        status:
          monthSource.lifecycleStatus === 'grace' ||
          queryLocalDate > monthEnd(snapshot.targetMonth)
            ? ('preliminary' as const)
            : ('current' as const),
        source: report.source,
        sections: buildPilotReportSeries(
          monthSource.source,
          report,
          asOfLocalDate,
        ),
      })
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new PilotReportDependencyUnavailableError({ cause: error })
    }
  }
}
