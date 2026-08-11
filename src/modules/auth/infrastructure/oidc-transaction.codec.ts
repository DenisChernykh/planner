import {
  TELEGRAM_OIDC_CALLBACK_PATH,
  TELEGRAM_OIDC_ISSUER,
  type OidcTransaction,
} from '../application/telegram-oidc.ports'
import type {
  RedisCodec,
  RedisDecodeResult,
} from '@/platform/redis/redis-codec'

import { isCanonicalBase64Url } from './node-auth-crypto.adapter'

const fields = Object.freeze([
  'schema',
  'issuer',
  'clientId',
  'nonce',
  'codeVerifier',
  'callbackUrl',
  'returnTo',
])
const fieldSet = new Set(fields)
const clientIdPattern = /^[1-9][0-9]*$/u

export interface OidcTransactionCodecConfig {
  readonly clientId: string
  readonly callbackUrl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validCallbackUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (
      url.toString() !== value ||
      url.pathname !== TELEGRAM_OIDC_CALLBACK_PATH ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return false
    }
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

function project(value: Record<string, unknown>): OidcTransaction {
  return Object.freeze({
    schema: value['schema'] as 1,
    issuer: value['issuer'] as typeof TELEGRAM_OIDC_ISSUER,
    clientId: value['clientId'] as string,
    nonce: value['nonce'] as string,
    codeVerifier: value['codeVerifier'] as string,
    callbackUrl: value['callbackUrl'] as string,
    returnTo: value['returnTo'] as '/',
  })
}

function validRecord(
  value: Record<string, unknown>,
  config: OidcTransactionCodecConfig,
): boolean {
  return (
    value['schema'] === 1 &&
    value['issuer'] === TELEGRAM_OIDC_ISSUER &&
    value['clientId'] === config.clientId &&
    isCanonicalBase64Url(value['nonce'], 32) &&
    isCanonicalBase64Url(value['codeVerifier'], 32) &&
    value['callbackUrl'] === config.callbackUrl &&
    value['returnTo'] === '/'
  )
}

export function createOidcTransactionCodec(
  config: OidcTransactionCodecConfig,
): RedisCodec<OidcTransaction> {
  if (
    !clientIdPattern.test(config.clientId) ||
    !validCallbackUrl(config.callbackUrl)
  ) {
    throw new Error('OIDC transaction codec config rejected')
  }
  const pinnedConfig = Object.freeze({ ...config })

  const decode = (serialized: string): RedisDecodeResult<OidcTransaction> => {
    try {
      const value: unknown = JSON.parse(serialized)
      if (!isRecord(value)) return { ok: false }
      const keys = Object.keys(value)
      if (
        keys.length !== fields.length ||
        keys.some((key) => !fieldSet.has(key)) ||
        !validRecord(value, pinnedConfig)
      ) {
        return { ok: false }
      }
      return { ok: true, value: project(value) }
    } catch {
      return { ok: false }
    }
  }

  return Object.freeze({
    encode: (record: OidcTransaction) => {
      if (!isRecord(record) || !validRecord(record, pinnedConfig)) {
        throw new Error('OIDC transaction record rejected')
      }
      return JSON.stringify(project(record))
    },
    decode,
  })
}
