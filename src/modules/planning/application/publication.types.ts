import type { ApplicationCommand } from '@/shared/application/application-command'

export type PublishMonthPayload = {
  readonly planMonthId: string
  readonly previewSchemaVersion: string
  readonly previewHashVersion: string
  readonly previewHash: string
}

export type PublishMonthApplicationCommand =
  ApplicationCommand<PublishMonthPayload>

export type GetPublishedSnapshotInput = {
  readonly trustedUserId: string
  readonly publicationId: string
}

export type GetActiveMonthInput = {
  readonly trustedUserId: string
}
