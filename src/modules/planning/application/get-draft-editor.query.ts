import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { CommandValidationError } from '@/shared/application/application-command'

import type { DraftGoalPersistencePort } from './draft-goal-persistence.port'
import type { DraftEditorView, GetDraftEditorInput } from './draft-goal.types'
import { snapshotGetDraftEditorInput } from './draft-goal.validation'
import { resolvePlanningMember } from './planning-authorization'
import {
  PlanDraftNotEditableError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

export class GetDraftEditorQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: DraftGoalPersistencePort,
  ) {}

  public async execute(
    input: GetDraftEditorInput,
  ): Promise<DraftEditorView | null> {
    try {
      const snapshot = snapshotGetDraftEditorInput(input)
      const member = await resolvePlanningMember(
        snapshot.trustedActor,
        this.workspaceMembers,
      )
      return await this.drafts.findEditor(member.spaceId, snapshot.targetMonth)
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof PlanningAuthorizationDeniedError ||
        error instanceof PlanDraftNotEditableError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
