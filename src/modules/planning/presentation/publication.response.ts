import type { DurableCommandResultRef } from '@/shared/application/application-command'

import type { PublishedSnapshot } from '../domain/publication'

export type PlanPublicationResultResponse = {
  readonly kind: 'planning.plan-publication.v1'
  readonly aggregateId: string
  readonly aggregateRevision: string
}

export type PublishedSnapshotResponse = PublishedSnapshot

export function toPlanPublicationResultResponse(
  value: DurableCommandResultRef<'planning.plan-publication.v1'>,
): PlanPublicationResultResponse {
  return Object.freeze({
    kind: value.kind,
    aggregateId: value.aggregateId,
    aggregateRevision: value.aggregateRevision.toString(10),
  })
}

export function toPublishedSnapshotResponse(
  value: PublishedSnapshot,
): PublishedSnapshotResponse {
  return value
}
