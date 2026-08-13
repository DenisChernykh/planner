import type { GetFactStateQuery } from './get-fact-state.query'
import type { RecordFactCommand } from './record-fact.command'

export type TrackingApplication = {
  readonly recordFact: RecordFactCommand
  readonly getFactState: GetFactStateQuery
}
