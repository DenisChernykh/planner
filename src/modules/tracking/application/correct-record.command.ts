import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeFactMutation } from './fact-mutation.command'
import {
  canonicalCorrectRecordPayload,
  snapshotCorrectRecordCommand,
} from './tracking-command.validation'
import type {
  CorrectRecordApplicationCommand,
  CorrectRecordPayload,
} from './tracking.types'

const definition: CommandDefinition<
  CorrectRecordPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.correct-record.v1' } = {
  commandType: 'tracking.correct-record.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalCorrectRecordPayload,
}

export class CorrectRecordCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: CorrectRecordApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotCorrectRecordCommand(command)
    return executeFactMutation(
      {
        executor: this.executor,
        workspaceMembers: this.workspaceMembers,
        facts: this.facts,
      },
      definition,
      snapshot,
      {
        factRecordId: snapshot.payload.factRecordId,
        value: snapshot.payload.value,
        reason: snapshot.payload.reason,
      },
    )
  }
}
