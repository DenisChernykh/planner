import type {
  CalculatePilotReportInput,
  PilotReportSourceV1,
} from './pilot-report.types'

export interface PilotReportReadPort {
  load(input: CalculatePilotReportInput): Promise<PilotReportSourceV1 | null>
}
