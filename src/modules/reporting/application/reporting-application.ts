import type { CalculatePilotReportUseCase } from './calculate-pilot-report.use-case'

export type ReportingApplication = {
  readonly calculatePilotReport: CalculatePilotReportUseCase
}
