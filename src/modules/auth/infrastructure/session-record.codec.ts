import type {
  RedisCodec,
  RedisDecodeResult,
} from '@/platform/redis/redis-codec'

import type { StoredSessionRecord } from '../application/session-store.port'
import { isCanonicalBase64Url } from './node-auth-crypto.adapter'

const fields = Object.freeze([
  'schema',
  'userId',
  'sessionId',
  'csrfSeed',
  'createdAtMs',
  'lastSeenAtMs',
  'absoluteExpiresAtMs',
])
const fieldSet = new Set(fields)
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function decode(serialized: string): RedisDecodeResult<StoredSessionRecord> {
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isObject(value)) return { ok: false }
    const keys = Object.keys(value)
    if (
      keys.length !== fields.length ||
      keys.some((key) => !fieldSet.has(key))
    ) {
      return { ok: false }
    }
    if (
      value['schema'] !== 1 ||
      typeof value['userId'] !== 'string' ||
      !uuidPattern.test(value['userId']) ||
      !isCanonicalBase64Url(value['sessionId'], 16) ||
      !isCanonicalBase64Url(value['csrfSeed'], 32) ||
      !safeTime(value['createdAtMs']) ||
      !safeTime(value['lastSeenAtMs']) ||
      !safeTime(value['absoluteExpiresAtMs']) ||
      value['lastSeenAtMs'] < value['createdAtMs'] ||
      value['absoluteExpiresAtMs'] <= value['lastSeenAtMs']
    )
      return { ok: false }
    return {
      ok: true,
      value: Object.freeze({
        schema: 1,
        userId: value['userId'],
        sessionId: value['sessionId'],
        csrfSeed: value['csrfSeed'],
        createdAtMs: value['createdAtMs'],
        lastSeenAtMs: value['lastSeenAtMs'],
        absoluteExpiresAtMs: value['absoluteExpiresAtMs'],
      }),
    }
  } catch {
    return { ok: false }
  }
}

export const sessionRecordCodec: RedisCodec<StoredSessionRecord> =
  Object.freeze({
    encode: (record: StoredSessionRecord) => JSON.stringify(record),
    decode,
  })
