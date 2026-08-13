import { createHash } from 'node:crypto'

import { canonicalJsonStringify } from '@/shared/application/command-fingerprint'

import {
  CLOSE_DAY_PREVIEW_HASH_VERSION,
  CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
  type CloseDayPreviewItemV1,
} from './close-day.types'

export function closeDayPreviewHash(input: {
  readonly publicationId: string
  readonly localDate: string
  readonly memberId: string
  readonly factsRevision: bigint
  readonly unresolved: readonly CloseDayPreviewItemV1[]
}): string {
  const preimage = canonicalJsonStringify({
    schemaVersion: CLOSE_DAY_PREVIEW_SCHEMA_VERSION,
    hashVersion: CLOSE_DAY_PREVIEW_HASH_VERSION,
    publicationId: input.publicationId,
    localDate: input.localDate,
    memberId: input.memberId,
    factsRevision: input.factsRevision.toString(10),
    unresolved: input.unresolved.map((item) => ({
      fixedExpectationId: item.fixedExpectationId,
      planGoalSnapshotId: item.planGoalSnapshotId,
      goalTitle: item.goalTitle,
      componentKind: item.componentKind,
      componentId: item.componentId,
      componentLabel: item.componentLabel,
      scope: item.scope,
    })),
  })
  return createHash('sha256').update(preimage, 'utf8').digest('hex')
}
