import { createHmac } from 'node:crypto'

import type { StartedRedisContainer } from '@testcontainers/redis'

import { AuthDependencyUnavailableError } from '@/modules/auth/application/auth-errors'
import {
  TELEGRAM_OIDC_ISSUER,
  type OidcTransaction,
} from '@/modules/auth/application/telegram-oidc.ports'
import { NodeAuthCryptoAdapter } from '@/modules/auth/infrastructure/node-auth-crypto.adapter'
import { RedisOidcTransactionStore } from '@/modules/auth/infrastructure/redis-oidc-transaction.store'
import { RedisAuthConnectionManager } from '@/platform/redis/redis-auth.connection'
import { RedisClientFactory } from '@/platform/redis/redis-client.factory'
import type { RedisCommandExecutorPort } from '@/platform/redis/redis-command.executor'
import { RedisLifecycle } from '@/platform/redis/redis-lifecycle'
import {
  resumeRedis,
  suspendRedis,
} from '@test/integration/support/redis-outage'
import { startRedisContainer } from '@test/integration/support/redis-container'

const stateSecret = new Uint8Array(Buffer.alloc(32, 41))
const state = Buffer.alloc(32, 42).toString('base64url')
const secondState = Buffer.alloc(32, 43).toString('base64url')
const transaction: OidcTransaction = Object.freeze({
  schema: 1,
  issuer: TELEGRAM_OIDC_ISSUER,
  clientId: '123456789',
  nonce: Buffer.alloc(32, 44).toString('base64url'),
  codeVerifier: Buffer.alloc(32, 45).toString('base64url'),
  callbackUrl: 'http://127.0.0.1:3000/auth/telegram/callback',
  returnTo: '/',
})

function transactionKey(rawState: string): string {
  const digest = createHmac('sha256', stateSecret)
    .update(rawState, 'utf8')
    .digest('base64url')
  return `planner:auth:v1:oidc-transaction:${digest}`
}

describe('A02 one-time OIDC transaction with real Redis', () => {
  let redis: StartedRedisContainer
  let lifecycle: RedisLifecycle
  let executor: RedisCommandExecutorPort
  let store: RedisOidcTransactionStore
  let redisSuspended = false

  beforeAll(async () => {
    redis = await startRedisContainer()
    const connection = new RedisAuthConnectionManager(
      new RedisClientFactory({
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 300,
      }),
      {
        authUrl: redis.getConnectionUrl(),
        connectTimeoutMs: 1_000,
        commandTimeoutMs: 300,
      },
    )
    lifecycle = new RedisLifecycle(connection, 1_000)
    await lifecycle.connect(AbortSignal.timeout(2_000))
    executor = connection.commandExecutor
    store = new RedisOidcTransactionStore(
      executor,
      new NodeAuthCryptoAdapter(),
      Object.freeze({
        keyPrefix: 'planner',
        stateKeySecret: stateSecret,
        clientId: transaction.clientId,
        callbackUrl: transaction.callbackUrl,
      }),
    )
  })

  beforeEach(async () => {
    await executor.execute('test-flush', (client) =>
      client.sendCommand<string>(['FLUSHDB']),
    )
  })

  afterAll(async () => {
    if (redisSuspended) await resumeRedis(redis)
    await lifecycle?.close(AbortSignal.timeout(1_000)).catch(() => undefined)
    await redis?.stop()
  })

  it('stores only the HMAC-addressed exact record with the requested finite PX TTL', async () => {
    // Raw state in key/value, a non-PX expiry or an altered record must fail.
    await expect(store.create(state, transaction, 300_000)).resolves.toBe(
      'created',
    )
    const key = transactionKey(state)
    const [payload, ttl, keys] = await executor.execute(
      'test-inspect-oidc',
      async (client) =>
        Promise.all([
          client.sendCommand<string | null>(['GET', key]),
          client.sendCommand<number>(['PTTL', key]),
          client.sendCommand<readonly string[]>(['KEYS', '*']),
        ]),
    )

    expect(keys).toEqual([key])
    expect(key).not.toContain(state)
    expect(payload).not.toContain(state)
    expect(JSON.parse(payload!)).toEqual(transaction)
    expect(ttl).toBeGreaterThan(299_000)
    expect(ttl).toBeLessThanOrEqual(300_000)
  })

  it('uses NX without overwriting the value or extending its collision TTL', async () => {
    // Omitting NX or applying PX before collision detection must fail.
    await store.create(state, transaction, 300_000)
    const key = transactionKey(state)
    const beforeTtl = await executor.execute('test-ttl-before', (client) =>
      client.sendCommand<number>(['PTTL', key]),
    )
    const replacement = Object.freeze({
      ...transaction,
      nonce: Buffer.alloc(32, 46).toString('base64url'),
    })

    await expect(store.create(state, replacement, 300_000)).resolves.toBe(
      'collision',
    )
    const [payload, afterTtl] = await executor.execute(
      'test-collision-inspect',
      async (client) =>
        Promise.all([
          client.sendCommand<string | null>(['GET', key]),
          client.sendCommand<number>(['PTTL', key]),
        ]),
    )
    expect(JSON.parse(payload!)).toEqual(transaction)
    expect(afterTtl).toBeLessThanOrEqual(beforeTtl)
  })

  it('projects exactly seven configured fields on create and rejects mismatched configured values', async () => {
    const recordWithExtraField = {
      ...transaction,
      extra: 'must not be stored',
    } as OidcTransaction
    await expect(
      store.create(state, recordWithExtraField, 300_000),
    ).resolves.toBe('created')
    const payload = await executor.execute('test-projected-oidc', (client) =>
      client.sendCommand<string | null>(['GET', transactionKey(state)]),
    )
    const projected: unknown = JSON.parse(payload!)
    expect(projected).toEqual(transaction)
    if (
      typeof projected !== 'object' ||
      projected === null ||
      Array.isArray(projected)
    ) {
      throw new Error('stored transaction is not a record')
    }
    expect(Object.keys(projected)).toEqual([
      'schema',
      'issuer',
      'clientId',
      'nonce',
      'codeVerifier',
      'callbackUrl',
      'returnTo',
    ])

    for (const [rawState, mismatched] of [
      [
        Buffer.alloc(32, 47).toString('base64url'),
        { ...transaction, clientId: '987654321' },
      ],
      [
        Buffer.alloc(32, 48).toString('base64url'),
        {
          ...transaction,
          callbackUrl: 'https://other.example/auth/telegram/callback',
        },
      ],
    ] as const) {
      await expect(
        store.create(rawState, mismatched, 300_000),
      ).rejects.toBeInstanceOf(AuthDependencyUnavailableError)
      await expect(
        executor.execute('test-rejected-create', (client) =>
          client.sendCommand<number>(['EXISTS', transactionKey(rawState)]),
        ),
      ).resolves.toBe(0)
    }
  })

  it('atomically consumes once across eight concurrent GETDEL callers and rejects replay', async () => {
    // GET followed by DEL would permit more than one winner under this race.
    await store.create(state, transaction, 300_000)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(state)),
    )

    expect(results.filter((result) => result !== undefined)).toEqual([
      transaction,
    ])
    expect(results.filter((result) => result === undefined)).toHaveLength(7)
    await expect(store.consume(state)).resolves.toBeUndefined()
    await expect(
      executor.execute('test-consumed-exists', (client) =>
        client.sendCommand<number>(['EXISTS', transactionKey(state)]),
      ),
    ).resolves.toBe(0)
  })

  it('returns absence after expiry and consumes every malformed or config-mismatched record before failing closed', async () => {
    // Accepting wrong values/shape or leaving poison records replayable must fail.
    await store.create(state, transaction, 40)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await expect(store.consume(state)).resolves.toBeUndefined()

    const { nonce: _omittedNonce, ...missingNonce } = transaction
    void _omittedNonce
    const malformedPayloads = [
      '{',
      JSON.stringify(null),
      JSON.stringify({ ...transaction, schema: 2 }),
      JSON.stringify({ ...transaction, issuer: 'https://evil.example' }),
      JSON.stringify({ ...transaction, clientId: '987654321' }),
      JSON.stringify({ ...transaction, nonce: 'invalid' }),
      JSON.stringify({ ...transaction, codeVerifier: 'invalid' }),
      JSON.stringify({
        ...transaction,
        callbackUrl: 'https://other.example/auth/telegram/callback',
      }),
      JSON.stringify({ ...transaction, returnTo: '/evil' }),
      JSON.stringify(missingNonce),
      JSON.stringify({ ...transaction, extra: true }),
    ]

    for (const [index, payload] of malformedPayloads.entries()) {
      const rawState = Buffer.alloc(32, 60 + index).toString('base64url')
      const key = transactionKey(rawState)
      await executor.execute('test-corrupt-oidc', (client) =>
        client.sendCommand<string>(['SET', key, payload, 'PX', '300000']),
      )
      await expect(store.consume(rawState)).rejects.toBeInstanceOf(
        AuthDependencyUnavailableError,
      )
      await expect(
        executor.execute('test-corrupt-consumed', (client) =>
          client.sendCommand<number>(['EXISTS', key]),
        ),
      ).resolves.toBe(0)
    }
  })

  it('fails closed during an outage and reconnects for a fresh transaction', async () => {
    // Treating Redis loss as absence or remaining permanently disconnected must fail.
    // The timed-out GETDEL itself is intentionally ambiguous after reconnect.
    await store.create(state, transaction, 300_000)
    await suspendRedis(redis)
    redisSuspended = true
    await expect(store.consume(state)).rejects.toBeInstanceOf(
      AuthDependencyUnavailableError,
    )
    await resumeRedis(redis)
    redisSuspended = false
    await expect(store.create(secondState, transaction, 300_000)).resolves.toBe(
      'created',
    )
    await expect(store.consume(secondState)).resolves.toEqual(transaction)
  })
})
