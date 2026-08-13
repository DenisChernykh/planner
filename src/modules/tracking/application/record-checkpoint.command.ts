import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordCheckpointPayload,
  snapshotRecordCheckpointCommand,
} from './tracking-command.validation'
import type {
  RecordCheckpointApplicationCommand,
  RecordCheckpointPayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordCheckpointPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-checkpoint.v1' } = {
  commandType: 'tracking.record-checkpoint.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordCheckpointPayload,
}

export class RecordCheckpointCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordCheckpointApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordCheckpointCommand(command)
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
        checkpointId: snapshot.payload.checkpointId,
        value: snapshot.payload.value,
      },
    )
  }
}
