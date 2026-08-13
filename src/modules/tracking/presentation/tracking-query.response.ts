import type {
  TrackingMonthReadModelV1,
  TrackingTodayReadModelV1,
} from '../application/tracking-read.types'

type JsonBigInts<T> = T extends bigint
  ? string
  : T extends readonly (infer Item)[]
    ? readonly JsonBigInts<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: JsonBigInts<T[Key]> }
      : T

export type TrackingMonthResponseV1 = JsonBigInts<TrackingMonthReadModelV1>
export type TrackingTodayResponseV1 = JsonBigInts<TrackingTodayReadModelV1>

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

export function toTrackingMonthResponse(
  value: TrackingMonthReadModelV1,
): TrackingMonthResponseV1 {
  return jsonValue(value) as TrackingMonthResponseV1
}

export function toTrackingTodayResponse(
  value: TrackingTodayReadModelV1,
): TrackingTodayResponseV1 {
  return jsonValue(value) as TrackingTodayResponseV1
}
