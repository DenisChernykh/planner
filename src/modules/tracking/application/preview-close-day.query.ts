import type { WorkspaceMemberResolver } from '@/modules/workspace'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace'
import { CommandValidationError } from '@/shared/application/application-command'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import type { CloseDayPersistencePort } from './close-day-persistence.port'
import { closeDayPreviewHash } from './close-day-preview'
import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
  type CloseDayPreviewV1,
  type PreviewCloseDayInput,
} from './close-day.types'
import {
  CloseDayTargetNotFoundError,
  CloseDayTargetUnavailableError,
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from './tracking-errors'
import {
  localDateAt,
  snapshotPreviewCloseDayInput,
} from './tracking-command.validation'

function accepted(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof TrackingAuthorizationDeniedError ||
    error instanceof CloseDayTargetNotFoundError ||
    error instanceof CloseDayTargetUnavailableError ||
    error instanceof TrackingDependencyUnavailableError
  )
}

export class PreviewCloseDayQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly closeDays: CloseDayPersistencePort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: PreviewCloseDayInput,
  ): Promise<CloseDayPreviewV1> {
    try {
      const snapshot = snapshotPreviewCloseDayInput(input)
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
      const currentLocalDate = localDateAt(this.clock.now())
      const state = await this.transaction.run(() =>
        this.closeDays.preview({
          spaceId: member.spaceId,
          memberId: member.memberId,
          publicationId: snapshot.publicationId,
          localDate: snapshot.localDate,
          currentLocalDate,
        }),
      )
      if (state.state === 'closed') {
        return Object.freeze({
          schemaVersion: CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
          publicationId: snapshot.publicationId,
          localDate: snapshot.localDate,
          ...state,
          closedAt: new Date(state.closedAt.getTime()),
        })
      }
      const unresolved = Object.freeze(
        state.unresolved.map((item) => Object.freeze({ ...item })),
      )
      return Object.freeze({
        schemaVersion: CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
        state: 'ready',
        publicationId: snapshot.publicationId,
        localDate: snapshot.localDate,
        factsRevision: state.factsRevision,
        previewHashVersion: CLOSE_DAY_PREVIEW_HASH_VERSION,
        previewHash: closeDayPreviewHash({
          publicationId: snapshot.publicationId,
          localDate: snapshot.localDate,
          memberId: member.memberId,
          factsRevision: state.factsRevision,
          unresolved,
        }),
        unresolved,
      })
    } catch (error: unknown) {
      if (accepted(error)) throw error
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
