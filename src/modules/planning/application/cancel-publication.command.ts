import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type {
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import { actorScope } from '@/shared/application/durable-command.executor'

import type { PublicationPersistencePort } from './publication-persistence.port'
import type {
  CancelPublicationApplicationCommand,
  CancelPublicationPayload,
} from './publication.types'
import {
  canonicalCancelPublicationPayload,
  snapshotCancelPublicationCommand,
} from './publication.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  PlanMonthRevisionConflictError,
  PlanPublicationCancellationConflictError,
  PlanPublicationNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

const resultKind = 'planning.plan-month.v1' as const

export const CANCEL_PUBLICATION: CommandDefinition<
  CancelPublicationPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.cancel-publication.v1',
  resultKind,
  toCanonicalPayload: canonicalCancelPublicationPayload,
})

function localDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

function publicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanPublicationNotFoundError ||
    error instanceof PlanMonthRevisionConflictError ||
    error instanceof PlanPublicationCancellationConflictError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class CancelPublicationCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly publications: PublicationPersistencePort,
  ) {}

  public execute(
    command: CancelPublicationApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotCancelPublicationCommand(command)
    try {
      return this.executor
        .execute(CANCEL_PUBLICATION, snapshot, async ({ occurredAt }) => {
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const value = await this.publications.cancel({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: 'planning.cancel-publication.v1',
            commandId: snapshot.commandId,
            occurredAt,
            localDate: localDate(occurredAt),
            spaceId: member.spaceId,
            memberId: member.memberId,
            planMonthId: snapshot.payload.planMonthId,
            publicationId: snapshot.payload.publicationId,
            expectedPlanMonthRevision: snapshot.expectedRevision!,
          })
          return Object.freeze({
            kind: resultKind,
            aggregateId: value.planMonthId,
            aggregateRevision: value.planMonthRevision,
          })
        })
        .catch((error: unknown) => {
          if (publicError(error)) throw error
          throw new PlanningDependencyUnavailableError({ cause: error })
        })
    } catch (error: unknown) {
      if (publicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
