import type {
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from 'node:stream/web'

import { AuthDependencyUnavailableError } from '../application/auth-errors'
import {
  TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
  TELEGRAM_OIDC_DISCOVERY_URL,
  TELEGRAM_OIDC_ISSUER,
  type TelegramOidcFetch,
  type TelegramOidcProviderPort,
} from '../application/telegram-oidc.ports'

const DISCOVERY_TIMEOUT_MS = 2_000
const DISCOVERY_BODY_LIMIT_BYTES = 16_384

interface TelegramDiscoveryMetadata {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly response_types_supported: readonly string[]
  readonly scopes_supported: readonly string[]
  readonly code_challenge_methods_supported: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined
}

function decodeMetadata(value: unknown): TelegramDiscoveryMetadata | undefined {
  if (!isRecord(value)) return undefined
  const responseTypes = stringArray(value['response_types_supported'])
  const scopes = stringArray(value['scopes_supported'])
  const challengeMethods = stringArray(
    value['code_challenge_methods_supported'],
  )
  if (
    value['issuer'] !== TELEGRAM_OIDC_ISSUER ||
    value['authorization_endpoint'] !== TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT ||
    responseTypes?.includes('code') !== true ||
    challengeMethods?.includes('S256') !== true ||
    scopes?.includes('openid') !== true ||
    scopes.includes('profile') !== true ||
    scopes.includes('telegram:bot_access') !== true
  ) {
    return undefined
  }
  return {
    issuer: value['issuer'],
    authorization_endpoint: value['authorization_endpoint'],
    response_types_supported: responseTypes,
    scopes_supported: scopes,
    code_challenge_methods_supported: challengeMethods,
  }
}

async function readBoundedBody(
  response: Response,
  bodyLimitBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (/^(?:0|[1-9][0-9]*)$/u.test(contentLength) === false ||
      Number(contentLength) > bodyLimitBytes)
  ) {
    throw new Error('OIDC discovery body rejected')
  }
  if (response.body === null) return ''

  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > bodyLimitBytes) {
        await reader.cancel()
        throw new Error('OIDC discovery body rejected')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  )
}

export class TelegramOidcProvider implements TelegramOidcProviderPort {
  public constructor(
    private readonly fetcher: TelegramOidcFetch = globalThis.fetch,
    private readonly bounds: {
      readonly timeoutMs: number
      readonly bodyLimitBytes: number
    } = {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      bodyLimitBytes: DISCOVERY_BODY_LIMIT_BYTES,
    },
  ) {
    if (
      bounds.timeoutMs !== DISCOVERY_TIMEOUT_MS ||
      bounds.bodyLimitBytes !== DISCOVERY_BODY_LIMIT_BYTES
    ) {
      throw new Error('Telegram OIDC provider bounds rejected')
    }
  }

  public async resolveAuthorizationEndpoint(): Promise<string> {
    try {
      const response = await this.fetcher(TELEGRAM_OIDC_DISCOVERY_URL, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.bounds.timeoutMs),
      })
      if (response.status !== 200) {
        throw new Error('OIDC discovery response rejected')
      }
      const body = await readBoundedBody(response, this.bounds.bodyLimitBytes)
      const metadata = decodeMetadata(JSON.parse(body) as unknown)
      if (metadata === undefined) {
        throw new Error('OIDC discovery metadata rejected')
      }
      return metadata.authorization_endpoint
    } catch (error: unknown) {
      if (error instanceof AuthDependencyUnavailableError) throw error
      throw new AuthDependencyUnavailableError({ cause: error })
    }
  }
}
