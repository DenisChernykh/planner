import type {
  MemberContext,
  WorkspaceMemberResolver,
} from '@/modules/workspace/application/workspace-member-resolver.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'
import type { ActorRef } from '@/shared/application/application-command'

import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

export async function resolvePlanningMember(
  actor: ActorRef,
  resolver: WorkspaceMemberResolver,
): Promise<MemberContext> {
  if (actor.kind !== 'member') throw new PlanningAuthorizationDeniedError()
  try {
    return await resolver.resolveMember(actor.id)
  } catch (error: unknown) {
    if (error instanceof WorkspaceMemberNotFoundError) {
      throw new PlanningAuthorizationDeniedError()
    }
    if (error instanceof WorkspaceDependencyUnavailableError) {
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
    throw new PlanningDependencyUnavailableError({ cause: error })
  }
}
