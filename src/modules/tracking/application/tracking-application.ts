import type { GetFactStateQuery } from './get-fact-state.query'
import type { GetGoalProgressQuery } from './get-goal-progress.query'
import type { CorrectRecordCommand } from './correct-record.command'
import type { DeleteRecordCommand } from './delete-record.command'
import type { RecordCheckpointCommand } from './record-checkpoint.command'
import type { RecordChecklistItemCommand } from './record-checklist-item.command'
import type { RecordCompositeOccurrenceCommand } from './record-composite-occurrence.command'
import type { RecordFactCommand } from './record-fact.command'
import type { RecordRatingCommand } from './record-rating.command'
import type { RecordOrVariantCommand } from './record-or-variant.command'
import type { RecordTimeCommand } from './record-time.command'
import type { RecordTextCommand } from './record-text.command'

export type TrackingApplication = {
  readonly correctRecord: CorrectRecordCommand
  readonly deleteRecord: DeleteRecordCommand
  readonly recordFact: RecordFactCommand
  readonly recordTime: RecordTimeCommand
  readonly recordRating: RecordRatingCommand
  readonly recordCheckpoint: RecordCheckpointCommand
  readonly recordText: RecordTextCommand
  readonly recordChecklistItem: RecordChecklistItemCommand
  readonly recordOrVariant: RecordOrVariantCommand
  readonly recordCompositeOccurrence: RecordCompositeOccurrenceCommand
  readonly getFactState: GetFactStateQuery
  readonly getGoalProgress: GetGoalProgressQuery
}
