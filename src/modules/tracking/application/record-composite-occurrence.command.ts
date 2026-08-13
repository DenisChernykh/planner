import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordCompositeOccurrencePayload,
  snapshotRecordCompositeOccurrenceCommand,
} from './tracking-command.validation'
import type {
  RecordCompositeOccurrenceApplicationCommand,
  RecordCompositeOccurrencePayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordCompositeOccurrencePayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-composite-occurrence.v1' } = {
  commandType: 'tracking.record-composite-occurrence.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordCompositeOccurrencePayload,
}

export class RecordCompositeOccurrenceCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordCompositeOccurrenceApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordCompositeOccurrenceCommand(command)
    const component = snapshot.payload.component
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
        localDate: snapshot.payload.localDate,
        checkpointId: null,
        checklistItemId:
          component.kind === 'checklist_item'
            ? component.checklistItemId
            : null,
        orVariantId:
          component.kind === 'or_variant' ? component.variantId : null,
        value:
          component.kind === 'checklist_item'
            ? { kind: component.kind, state: component.state }
            : { kind: component.kind, value: component.value },
      },
    )
  }
}
