import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'

import type { PublishedSnapshot } from '../domain/publication'
import type { PublicationPersistencePort } from './publication-persistence.port'
import type { GetPublishedSnapshotInput } from './publication.types'
import { snapshotGetPublishedSnapshotInput } from './publication.validation'
import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

export class GetPublishedSnapshotQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly publications: PublicationPersistencePort,
  ) {}

  public async execute(
    input: GetPublishedSnapshotInput,
  ): Promise<PublishedSnapshot | null> {
    try {
      const snapshot = snapshotGetPublishedSnapshotInput(input)
      const member = await this.workspaceMembers.resolveUser(
        snapshot.trustedUserId,
      )
      return await this.publications.findPublished(
        member.spaceId,
        snapshot.publicationId,
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof PlanningAuthorizationDeniedError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new PlanningAuthorizationDeniedError()
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new PlanningDependencyUnavailableError({ cause: error })
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
