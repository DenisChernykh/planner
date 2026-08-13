import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import {
  FactTargetNotFoundError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import { snapshotGetFactStateInput } from './tracking-command.validation'
import type { FactStateV1, GetFactStateInput } from './tracking.types'

export class GetFactStateQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public async execute(input: GetFactStateInput): Promise<FactStateV1 | null> {
    try {
      const snapshot = snapshotGetFactStateInput(input)
      if (snapshot.trustedActor.kind !== 'member') {
        throw new TrackingAuthorizationDeniedError()
      }
      let member
      try {
        member = await this.workspaceMembers.resolveMember(
          snapshot.trustedActor.id,
        )
      } catch (error: unknown) {
        if (error instanceof WorkspaceMemberNotFoundError) {
          throw new TrackingAuthorizationDeniedError()
        }
        if (error instanceof WorkspaceDependencyUnavailableError) {
          throw new TrackingDependencyUnavailableError({ cause: error })
        }
        throw error
      }
      return await this.facts.getState({
        spaceId: member.spaceId,
        publicationId: snapshot.publicationId,
        planGoalSnapshotId: snapshot.planGoalSnapshotId,
        localDate: snapshot.localDate,
      })
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof TrackingAuthorizationDeniedError ||
        error instanceof FactTargetNotFoundError ||
        error instanceof TrackingDependencyUnavailableError
      ) {
        throw error
      }
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
