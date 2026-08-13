import type { WorkspaceMemberResolver } from '@/modules/workspace'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

import { GetFactStateQuery } from '../application/get-fact-state.query'
import { GetGoalProgressQuery } from '../application/get-goal-progress.query'
import { CorrectRecordCommand } from '../application/correct-record.command'
import { DeleteRecordCommand } from '../application/delete-record.command'
import { RecordCheckpointCommand } from '../application/record-checkpoint.command'
import { RecordChecklistItemCommand } from '../application/record-checklist-item.command'
import { RecordCompositeOccurrenceCommand } from '../application/record-composite-occurrence.command'
import { RecordFactCommand } from '../application/record-fact.command'
import { RecordRatingCommand } from '../application/record-rating.command'
import { RecordOrVariantCommand } from '../application/record-or-variant.command'
import { RecordTimeCommand } from '../application/record-time.command'
import { RecordTextCommand } from '../application/record-text.command'
import { UndoLastOwnActionCommand } from '../application/undo-last-own-action.command'
import { CloseDayCommand } from '../application/close-day.command'
import { PreviewCloseDayQuery } from '../application/preview-close-day.query'
import {
  GetMonthQuery,
  GetTodayQuery,
} from '../application/tracking-read.query'
import type { TrackingApplication } from '../application/tracking-application'
import { PrismaFactPersistence } from '../infrastructure/prisma-fact.persistence'
import { PrismaCloseDayPersistence } from '../infrastructure/prisma-close-day.persistence'
import { PrismaTrackingReadPersistence } from '../infrastructure/prisma-tracking-read.persistence'

export function createTrackingApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): TrackingApplication {
  const facts = new PrismaFactPersistence(dependencies.database)
  const closeDays = new PrismaCloseDayPersistence(dependencies.database)
  const reads = new PrismaTrackingReadPersistence(dependencies.database)
  const executor = new DurableCommandExecutor(
    dependencies.transaction,
    new PrismaCommandReceiptAdapter(dependencies.database),
    dependencies.clock,
  )
  return Object.freeze({
    closeDay: new CloseDayCommand(
      executor,
      dependencies.workspaceMembers,
      closeDays,
    ),
    previewCloseDay: new PreviewCloseDayQuery(
      dependencies.workspaceMembers,
      closeDays,
      dependencies.transaction,
      dependencies.clock,
    ),
    correctRecord: new CorrectRecordCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    deleteRecord: new DeleteRecordCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordFact: new RecordFactCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordTime: new RecordTimeCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordRating: new RecordRatingCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordCheckpoint: new RecordCheckpointCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordText: new RecordTextCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordChecklistItem: new RecordChecklistItemCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordOrVariant: new RecordOrVariantCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    recordCompositeOccurrence: new RecordCompositeOccurrenceCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    undoLastOwnAction: new UndoLastOwnActionCommand(
      executor,
      dependencies.workspaceMembers,
      facts,
    ),
    getFactState: new GetFactStateQuery(dependencies.workspaceMembers, facts),
    getGoalProgress: new GetGoalProgressQuery(
      dependencies.workspaceMembers,
      facts,
    ),
    getToday: new GetTodayQuery(
      dependencies.workspaceMembers,
      reads,
      dependencies.transaction,
      dependencies.clock,
    ),
    getMonth: new GetMonthQuery(
      dependencies.workspaceMembers,
      reads,
      dependencies.transaction,
      dependencies.clock,
    ),
  })
}
