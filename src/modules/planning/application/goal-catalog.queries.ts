import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { CommandValidationError } from '@/shared/application/application-command'

import type { GoalCatalogPersistencePort } from './goal-catalog-persistence.port'
import type {
  GetGoalDefinitionInput,
  GoalDefinitionDetail,
  GoalDefinitionSummary,
  ListGoalDefinitionsInput,
} from './goal-catalog.types'
import {
  snapshotGetGoalDefinitionInput,
  snapshotGoalDefinitionListInput,
} from './goal-catalog.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

function isPublicQueryError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class ListGoalDefinitionsQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly catalog: GoalCatalogPersistencePort,
  ) {}

  public async execute(
    input: ListGoalDefinitionsInput,
  ): Promise<readonly GoalDefinitionSummary[]> {
    try {
      const snapshot = snapshotGoalDefinitionListInput(input)
      const member = await resolvePlanningMember(
        snapshot.trustedActor,
        this.workspaceMembers,
      )
      return await this.catalog.list(member.spaceId, snapshot.state)
    } catch (error: unknown) {
      if (isPublicQueryError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}

export class GetGoalDefinitionQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly catalog: GoalCatalogPersistencePort,
  ) {}

  public async execute(
    input: GetGoalDefinitionInput,
  ): Promise<GoalDefinitionDetail | null> {
    try {
      const snapshot = snapshotGetGoalDefinitionInput(input)
      const member = await resolvePlanningMember(
        snapshot.trustedActor,
        this.workspaceMembers,
      )
      return await this.catalog.get(member.spaceId, snapshot.goalDefinitionId)
    } catch (error: unknown) {
      if (isPublicQueryError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
