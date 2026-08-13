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
  PublishMonthApplicationCommand,
  PublishMonthPayload,
} from './publication.types'
import {
  canonicalPublishMonthPayload,
  snapshotPublishMonthCommand,
} from './publication.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  DraftRevisionConflictError,
  PlanDraftNotEditableError,
  PlanDraftNotFoundError,
  PlanMonthAlreadyPublishedError,
  PlanPublicationBlockedError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
  PublicationPreviewConflictError,
} from './planning-errors'

const resultKind = 'planning.plan-publication.v1' as const
export const PUBLISH_MONTH: CommandDefinition<
  PublishMonthPayload,
  typeof resultKind
> = Object.freeze({
  commandType: 'planning.publish-month.v1',
  resultKind,
  toCanonicalPayload: canonicalPublishMonthPayload,
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
    error instanceof PlanDraftNotFoundError ||
    error instanceof PlanDraftNotEditableError ||
    error instanceof DraftRevisionConflictError ||
    error instanceof PublicationPreviewConflictError ||
    error instanceof PlanPublicationBlockedError ||
    error instanceof PlanMonthAlreadyPublishedError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class PublishMonthCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly publications: PublicationPersistencePort,
  ) {}

  public execute(
    command: PublishMonthApplicationCommand,
  ): Promise<DurableCommandResultRef<typeof resultKind>> {
    const snapshot = snapshotPublishMonthCommand(command)
    try {
      return this.executor
        .execute(PUBLISH_MONTH, snapshot, async ({ occurredAt }) => {
          const member = await resolvePlanningMember(
            snapshot.trustedActor,
            this.workspaceMembers,
          )
          const value = await this.publications.publish({
            actor: snapshot.trustedActor,
            actorScope: actorScope(snapshot.trustedActor),
            commandType: 'planning.publish-month.v1',
            commandId: snapshot.commandId,
            occurredAt,
            localDate: localDate(occurredAt),
            spaceId: member.spaceId,
            memberId: member.memberId,
            planMonthId: snapshot.payload.planMonthId,
            expectedDraftRevision: snapshot.expectedRevision!,
            previewSchemaVersion: snapshot.payload.previewSchemaVersion,
            previewHashVersion: snapshot.payload.previewHashVersion,
            previewHash: snapshot.payload.previewHash,
          })
          return Object.freeze({
            kind: resultKind,
            aggregateId: value.publicationId,
            aggregateRevision: value.publicationRevision,
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
