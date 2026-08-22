import { createHash } from 'node:crypto'

import type { CanonicalJsonValue } from './application-command'

function canonicalReportValue(value: unknown): CanonicalJsonValue {
  if (typeof value === 'bigint') return value.toString(10)
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    return items.map(canonicalReportValue)
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return Object.fromEntries(
      entries.map(([key, item]) => [key, canonicalReportValue(item)]),
    )
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value
  }
  throw new Error('Report payload contains unsupported value')
}

function canonicalJsonStringify(value: CanonicalJsonValue): string {
  if (Array.isArray(value)) {
    const items = value as readonly CanonicalJsonValue[]
    return `[${items.map((item) => canonicalJsonStringify(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const object = value as { readonly [key: string]: CanonicalJsonValue }
    return `{${Object.keys(object)
      .sort()
      .map((key) => {
        const child = object[key]
        if (child === undefined) throw new Error('Report payload is sparse')
        return `${JSON.stringify(key)}:${canonicalJsonStringify(child)}`
      })
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function reportPayloadChecksum(payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(canonicalReportValue(payload)), 'utf8')
    .digest('hex')
}
