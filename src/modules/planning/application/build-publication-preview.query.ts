import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'
import { CommandValidationError } from '@/shared/application/application-command'
import type { ProductClock } from '@/shared/application/product-clock'

import type { DraftGoalPersistencePort } from './draft-goal-persistence.port'
import { validateTargetMonth } from './planning-command.validation'
import { isCanonicalPlanningUuid } from '../domain/planning-values'
import {
  PlanDraftNotEditableError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import {
  buildPublicationPreview,
  type PublicationPreview,
} from './publication-preview'

export type BuildPublicationPreviewInput = {
  readonly trustedUserId: string
  readonly targetMonth: string
}

function snapshotInput(value: unknown): BuildPublicationPreviewInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CommandValidationError()
  }
  const keys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    keys.length !== 2 ||
    !keys.includes('trustedUserId') ||
    !keys.includes('targetMonth') ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        descriptors[key]?.get !== undefined ||
        descriptors[key]?.set !== undefined,
    )
  ) {
    throw new CommandValidationError()
  }
  const input = value as Record<string, unknown>
  if (!isCanonicalPlanningUuid(input['trustedUserId'])) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    trustedUserId: input['trustedUserId'],
    targetMonth: validateTargetMonth(input['targetMonth']),
  })
}

export class BuildPublicationPreviewQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly drafts: DraftGoalPersistencePort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: BuildPublicationPreviewInput,
  ): Promise<PublicationPreview | null> {
    try {
      const snapshot = snapshotInput(input)
      const member = await this.workspaceMembers.resolveUser(
        snapshot.trustedUserId,
      )
      const today = this.clock.today('Asia/Yekaterinburg')
      const editor = await this.drafts.findEditor(
        member.spaceId,
        snapshot.targetMonth,
      )
      return editor === null ? null : buildPublicationPreview(editor, today)
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof PlanningAuthorizationDeniedError ||
        error instanceof PlanDraftNotEditableError ||
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
