import type { GetFactStateQuery } from './get-fact-state.query'
import type { GetGoalProgressQuery } from './get-goal-progress.query'
import type { RecordCheckpointCommand } from './record-checkpoint.command'
import type { RecordFactCommand } from './record-fact.command'
import type { RecordRatingCommand } from './record-rating.command'
import type { RecordTimeCommand } from './record-time.command'

export type TrackingApplication = {
  readonly recordFact: RecordFactCommand
  readonly recordTime: RecordTimeCommand
  readonly recordRating: RecordRatingCommand
  readonly recordCheckpoint: RecordCheckpointCommand
  readonly getFactState: GetFactStateQuery
  readonly getGoalProgress: GetGoalProgressQuery
}
