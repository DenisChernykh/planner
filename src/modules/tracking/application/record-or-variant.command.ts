import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeRecordValue } from './record-value.command'
import {
  canonicalRecordOrVariantPayload,
  snapshotRecordOrVariantCommand,
} from './tracking-command.validation'
import type {
  RecordOrVariantApplicationCommand,
  RecordOrVariantPayload,
} from './tracking.types'

const definition: CommandDefinition<
  RecordOrVariantPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.record-or-variant.v1' } = {
  commandType: 'tracking.record-or-variant.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalRecordOrVariantPayload,
}

export class RecordOrVariantCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: RecordOrVariantApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotRecordOrVariantCommand(command)
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
        orVariantId: snapshot.payload.variantId,
        value: { kind: 'or_variant', value: snapshot.payload.value },
      },
    )
  }
}
