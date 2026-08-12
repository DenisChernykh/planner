import type { PublicationPreview } from '../application/publication-preview'

export type PublicationPreviewResponse = PublicationPreview

export function toPublicationPreviewResponse(
  value: PublicationPreview,
): PublicationPreviewResponse {
  return value
}
