import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordTextPayload,
  snapshotRecordTextCommand,
} from './tracking-command.validation'
import type {
  RecordTextApplicationCommand,
  RecordTextPayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordTextPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-text.v1' } = {
  commandType: 'tracking.record-text.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordTextPayload,
}

export class RecordTextCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordTextApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordTextCommand(command)
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
        checklistItemId: null,
        value: {
          kind: 'text',
          text: snapshot.payload.text,
          result: snapshot.payload.result,
        },
      },
    )
  }
}
