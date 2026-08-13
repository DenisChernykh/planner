import type { ActorRef } from '@/shared/application/application-command'

import type { FactRecordRef } from './fact-persistence.port'

export type RecordWeeklyTaskResultPersistenceInput = {
  readonly actor: ActorRef
  readonly actorScope: string
  readonly commandId: string
  readonly occurredAt: Date
  readonly currentLocalDate: string
  readonly spaceId: string
  readonly memberId: string
  readonly publicationId: string
  readonly flexiblePeriodId: string
  readonly result: 'done' | 'not_done'
}

export type WeeklyTaskResultWritePhase =
  'record' | 'revision' | 'pointer' | 'facts_revision' | 'history'

export interface WeeklyTaskResultPersistencePort {
  record(input: RecordWeeklyTaskResultPersistenceInput): Promise<FactRecordRef>
}
