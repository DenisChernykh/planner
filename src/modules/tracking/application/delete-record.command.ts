import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import { executeFactMutation } from './fact-mutation.command'
import {
  canonicalDeleteRecordPayload,
  snapshotDeleteRecordCommand,
} from './tracking-command.validation'
import type {
  DeleteRecordApplicationCommand,
  DeleteRecordPayload,
} from './tracking.types'

const definition: CommandDefinition<
  DeleteRecordPayload,
  'tracking.fact-record.v1'
> & { readonly commandType: 'tracking.delete-record.v1' } = {
  commandType: 'tracking.delete-record.v1',
  resultKind: 'tracking.fact-record.v1',
  toCanonicalPayload: canonicalDeleteRecordPayload,
}

export class DeleteRecordCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public execute(
    command: DeleteRecordApplicationCommand,
  ): Promise<DurableCommandResultRef<'tracking.fact-record.v1'>> {
    const snapshot = snapshotDeleteRecordCommand(command)
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
        value: null,
        reason: snapshot.payload.reason,
      },
    )
  }
}
