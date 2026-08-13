import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { ProductClock } from '@/shared/application/product-clock'

import type { PublishedSnapshot } from '../domain/publication'
import type { PublicationPersistencePort } from './publication-persistence.port'
import type { GetActiveMonthInput } from './publication.types'
import { snapshotGetActiveMonthInput } from './publication.validation'
import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

export class GetActiveMonthQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly publications: PublicationPersistencePort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: GetActiveMonthInput,
  ): Promise<PublishedSnapshot | null> {
    try {
      const snapshot = snapshotGetActiveMonthInput(input)
      const member = await this.workspaceMembers.resolveUser(
        snapshot.trustedUserId,
      )
      const localDate = this.clock.today('Asia/Yekaterinburg')
      return await this.publications.findActive(member.spaceId, localDate)
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
