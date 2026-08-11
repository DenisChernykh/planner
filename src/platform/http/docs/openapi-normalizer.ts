function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, member]) => [key, sortValue(member)]),
  )
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function canonicalizeJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined)
    throw new TypeError('Canonical JSON root is not serializable')
  return `${JSON.stringify(sortValue(JSON.parse(serialized) as unknown), undefined, 2)}\n`
}
