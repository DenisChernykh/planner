import { createHash } from 'node:crypto'

export type SafeManifestRow = Record<string, unknown>

function normalized(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `base64:${value.toString('base64')}`
  if (Array.isArray(value)) return value.map((item) => normalized(item))
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalized(record[key])]),
    )
  }
  return value
}

export function canonical(value: unknown): string {
  return JSON.stringify(normalized(value))
}

export function safeDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function mismatchMessage(
  category: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
): string {
  return [
    `restore mismatch category=${category}`,
    `expected_count=${expected.length}`,
    `actual_count=${actual.length}`,
    `expected_digest=${safeDigest(expected)}`,
    `actual_digest=${safeDigest(actual)}`,
  ].join(' ')
}

export function compareSafeArrays(
  category: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
): void {
  const expectedCanonical = canonical(expected)
  const actualCanonical = canonical(actual)
  if (expectedCanonical !== actualCanonical) {
    throw new Error(mismatchMessage(category, expected, actual))
  }
}

export function compareSafeValues(
  category: string,
  expected: unknown,
  actual: unknown,
): void {
  const expectedCanonical = canonical(expected)
  const actualCanonical = canonical(actual)
  if (expectedCanonical !== actualCanonical) {
    const expectedRows = Array.isArray(expected) ? expected : [expected]
    const actualRows = Array.isArray(actual) ? actual : [actual]
    throw new Error(mismatchMessage(category, expectedRows, actualRows))
  }
}
