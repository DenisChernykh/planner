import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordChecklistItemPayload,
  snapshotRecordChecklistItemCommand,
} from './tracking-command.validation'
import type {
  RecordChecklistItemApplicationCommand,
  RecordChecklistItemPayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordChecklistItemPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-checklist-item.v1' } = {
  commandType: 'tracking.record-checklist-item.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordChecklistItemPayload,
}

export class RecordChecklistItemCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordChecklistItemApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordChecklistItemCommand(command)
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
        checklistItemId: snapshot.payload.checklistItemId,
        orVariantId: null,
        value: { kind: 'checklist_item', state: snapshot.payload.state },
      },
    )
  }
}
