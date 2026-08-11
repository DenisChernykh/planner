import { randomUUID } from 'node:crypto'

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const canonicalUlid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u

export const REQUEST_ID_HEADER = 'X-Request-ID'

export interface ResolvedRequestId {
  readonly requestId: string
  readonly accepted: boolean
}

export function isCanonicalRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (canonicalUuid.test(value) || canonicalUlid.test(value))
  )
}

export function resolveRequestId(
  value: unknown,
  generate: () => string = randomUUID,
): ResolvedRequestId {
  const accepted = isCanonicalRequestId(value)
  return Object.freeze({ requestId: accepted ? value : generate(), accepted })
}
