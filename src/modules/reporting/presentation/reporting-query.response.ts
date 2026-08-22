import type { PilotReportReadModelV1 } from '../application/pilot-report.types'

type JsonBigInts<T> = T extends bigint
  ? string
  : T extends readonly (infer Item)[]
    ? readonly JsonBigInts<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: JsonBigInts<T[Key]> }
      : T

export type PilotReportReadResponseV1 = JsonBigInts<PilotReportReadModelV1>

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10)
  if (Array.isArray(value)) return Object.freeze(value.map(jsonValue))
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
      ),
    )
  }
  return value
}

export function toPilotReportReadResponse(
  value: PilotReportReadModelV1,
): PilotReportReadResponseV1 {
  return jsonValue(value) as PilotReportReadResponseV1
}
