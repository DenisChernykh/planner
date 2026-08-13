import { evaluateGoalProgress } from '@/modules/progress'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'

import type { FactPersistencePort } from './fact-persistence.port'
import {
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import { snapshotGetGoalProgressInput } from './tracking-command.validation'
import type {
  GetGoalProgressInput,
  GoalProgressStateV1,
} from './tracking.types'

export class GetGoalProgressQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly facts: FactPersistencePort,
  ) {}

  public async execute(
    input: GetGoalProgressInput,
  ): Promise<GoalProgressStateV1 | null> {
    try {
      const snapshot = snapshotGetGoalProgressInput(input)
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
      const progressInput = await this.facts.getGoalProgressInput({
        spaceId: member.spaceId,
        publicationId: snapshot.publicationId,
        planGoalSnapshotId: snapshot.planGoalSnapshotId,
        asOfLocalDate: snapshot.asOfLocalDate,
      })
      return progressInput === null ? null : evaluateGoalProgress(progressInput)
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof TrackingAuthorizationDeniedError ||
        error instanceof TrackingDependencyUnavailableError
      ) {
        throw error
      }
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
