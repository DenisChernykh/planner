import type {
  ActorRef,
  ApplicationCommand,
} from '@/shared/application/application-command'

export const CLOSE_DAY_PREVIEW_SCHEMA_VERSION =
  'tracking.close-day-preview.v1' as const
export const CLOSE_DAY_PREVIEW_HASH_VERSION =
  'tracking.close-day-preview-hash.v1' as const

export type CloseDayComponentKindV1 = 'goal' | 'checkpoint' | 'checklist_item'

export type CloseDayPreviewItemV1 = {
  readonly fixedExpectationId: string
  readonly planGoalSnapshotId: string
  readonly goalTitle: string
  readonly componentKind: CloseDayComponentKindV1
  readonly componentId: string | null
  readonly componentLabel: string | null
  readonly scope: 'personal' | 'shared'
}

export type CloseDayReadyPreviewV1 = {
  readonly schemaVersion: typeof CLOSE_DAY_PREVIEW_SCHEMA_VERSION
  readonly state: 'ready'
  readonly publicationId: string
  readonly localDate: string
  readonly factsRevision: bigint
  readonly previewHashVersion: typeof CLOSE_DAY_PREVIEW_HASH_VERSION
  readonly previewHash: string
  readonly unresolved: readonly CloseDayPreviewItemV1[]
}

export type CloseDayClosedPreviewV1 = {
  readonly schemaVersion: typeof CLOSE_DAY_PREVIEW_SCHEMA_VERSION
  readonly state: 'closed'
  readonly publicationId: string
  readonly localDate: string
  readonly dayCloseId: string
  readonly revision: bigint
  readonly closedAt: Date
  readonly closedCount: number
}

export type CloseDayPreviewV1 = CloseDayReadyPreviewV1 | CloseDayClosedPreviewV1

export type PreviewCloseDayInput = {
  readonly trustedActor: ActorRef
  readonly publicationId: string
  readonly localDate: string
}

export type CloseDayPayload = {
  readonly publicationId: string
  readonly localDate: string
  readonly previewSchemaVersion: typeof CLOSE_DAY_PREVIEW_SCHEMA_VERSION
  readonly previewHashVersion: typeof CLOSE_DAY_PREVIEW_HASH_VERSION
  readonly previewHash: string
}

export type CloseDayApplicationCommand = ApplicationCommand<CloseDayPayload>
