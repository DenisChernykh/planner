import type {
  CalculatePilotReportInput,
  PilotReportMonthSourceInput,
  PilotReportMonthSourceV1,
  PilotReportSourceV1,
} from './pilot-report.types'

export interface PilotReportReadPort {
  load(input: CalculatePilotReportInput): Promise<PilotReportSourceV1 | null>
}

export interface PilotReportMonthReadPort {
  loadByMonth(
    input: PilotReportMonthSourceInput,
  ): Promise<PilotReportMonthSourceV1 | null>
}
