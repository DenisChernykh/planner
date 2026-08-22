import type { CalculatePilotReportUseCase } from './calculate-pilot-report.use-case'
import type { BuildPilotReportRevision } from './build-pilot-report-revision'
import type { BuildPilotReportQuery } from './build-pilot-report.query'

export const REPORTING_APPLICATION: unique symbol = Symbol(
  'REPORTING_APPLICATION',
)

export type ReportingApplication = {
  readonly calculatePilotReport: CalculatePilotReportUseCase
  readonly buildPilotReport: BuildPilotReportQuery
  readonly buildCloseMonthReport: BuildPilotReportRevision
}
