import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { CommandValidationError } from '@/shared/application/application-command'

import type { PlanDraftPersistencePort } from './plan-draft-persistence.port'
import { resolvePlanningMember } from './planning-authorization'
import { validateTargetMonth } from './planning-command.validation'
import {
  PlanDraftNotEditableError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type { DraftView, GetDraftInput } from './planning.types'

export class GetDraftQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: PlanDraftPersistencePort,
  ) {}

  public async execute(input: GetDraftInput): Promise<DraftView | null> {
    try {
      const targetMonth = validateTargetMonth(input.targetMonth)
      const member = await resolvePlanningMember(
        input.trustedActor,
        this.workspaceMembers,
      )
      return await this.drafts.findDraft(member.spaceId, targetMonth)
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
