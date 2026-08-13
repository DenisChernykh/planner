import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordTimePayload,
  snapshotRecordTimeCommand,
} from './tracking-command.validation'
import type {
  RecordTimeApplicationCommand,
  RecordTimePayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordTimePayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-time.v1' } = {
  commandType: 'tracking.record-time.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordTimePayload,
}

export class RecordTimeCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordTimeApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordTimeCommand(command)
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
        orVariantId: null,
        value: { kind: 'actual_time', value: snapshot.payload.value },
      },
    )
  }
}
