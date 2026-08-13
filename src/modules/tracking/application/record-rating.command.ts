import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordRatingPayload,
  snapshotRecordRatingCommand,
} from './tracking-command.validation'
import type {
  RecordRatingApplicationCommand,
  RecordRatingPayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordRatingPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-rating.v1' } = {
  commandType: 'tracking.record-rating.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordRatingPayload,
}

export class RecordRatingCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordRatingApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordRatingCommand(command)
    return executeRecordValue(
      {
        executor: this.executor,
        workspaceMembers: this.workspaceMembers,
        facts: this.facts,
      },
      definition,
      snapshot,
      {
        publicationId: snapshot.payload.publicationId,
        planGoalSnapshotId: snapshot.payload.planGoalSnapshotId,
        localDate: snapshot.payload.expectationDate,
        checkpointId: null,
        checklistItemId: null,
        value: { kind: 'rating', value: snapshot.payload.value },
      },
    )
  }
}
