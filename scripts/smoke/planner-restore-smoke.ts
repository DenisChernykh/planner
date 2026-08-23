import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis'
import { Pool, type PoolClient } from 'pg'
import { createClient } from 'redis'

import { reportPayloadChecksum } from '@/shared/application/report-payload-integrity'
import {
  compareSafeArrays,
  compareSafeValues,
} from './planner-restore-assertions'
import {
  assertOwnedVolumeGone,
  assertTempRootGone,
} from './planner-restore-cleanup'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const REDIS_IMAGE =
  'redis:8.8.0-trixie@sha256:234c902a2db49461a129e2d4aeff85b28cf20187ed274a67f6e50995fa713c7b'
const POSTGRES_USER = 'planner'
const POSTGRES_PASSWORD = 'planner-test-only'
const ENVELOPE_MAGIC = Buffer.from('PLANNER-O02-AESGCM\0', 'ascii')
const ENVELOPE_VERSION = 1
const AUTH_TAG_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const COMMAND_TIMEOUT_MS = 240_000

type CommandResult = { readonly stdout: string; readonly stderr: string }
type ManifestRow = Record<string, unknown>
type ManifestTables = {
  readonly users: readonly ManifestRow[]
  readonly memberships: readonly ManifestRow[]
  readonly externalIdentities: readonly ManifestRow[]
  readonly planMonths: readonly ManifestRow[]
  readonly publications: readonly ManifestRow[]
  readonly goalSnapshots: readonly ManifestRow[]
  readonly trackingFactRecords: readonly ManifestRow[]
  readonly trackingFactRevisions: readonly ManifestRow[]
  readonly trackingActionGroups: readonly ManifestRow[]
  readonly trackingFactChanges: readonly ManifestRow[]
  readonly reminderSchedules: readonly ManifestRow[]
  readonly reminderScheduleSlots: readonly ManifestRow[]
  readonly reminderOccurrences: readonly ManifestRow[]
  readonly notificationIntents: readonly ManifestRow[]
  readonly notificationAttempts: readonly ManifestRow[]
  readonly reportRevisions: readonly ManifestRow[]
}
type Manifest = {
  readonly tables: ManifestTables
  readonly reportPayloadChecksums: readonly {
    readonly stored: string
    readonly computed: string
  }[]
}
type OwnedResources = {
  sourcePostgres?: StartedPostgreSqlContainer
  sourceRedis?: StartedRedisContainer
  targetPostgres?: StartedPostgreSqlContainer
  targetRedis?: StartedRedisContainer
}
type Envelope = {
  readonly header: Buffer
  readonly headerEnd: number
  readonly ciphertext: Buffer
  readonly tag: Buffer
}
type MountInfo = {
  readonly source: string
  readonly name?: string
}

const runId = `o02-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
const abortController = new AbortController()
const children = new Set<ChildProcess>()
let interrupted = false

function safeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('restore smoke failed')
}

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...extra }
  delete environment.PLANNER_O02_BACKUP_KEY
  delete environment.PLANNER_O02_FAIL_AFTER_BACKUP
  delete environment.PLANNER_O02_WAIT_FOR_SIGNAL_AFTER_BACKUP
  return environment
}

const nonAbortableChildren = new Set<ChildProcess>()

function terminateChildren(): void {
  for (const child of children) {
    if (
      !nonAbortableChildren.has(child) &&
      child.exitCode === null &&
      !child.killed
    ) {
      child.kill('SIGTERM')
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (
        !nonAbortableChildren.has(child) &&
        child.exitCode === null &&
        !child.killed
      ) {
        child.kill('SIGKILL')
      }
    }
  }, 1_000).unref()
}

function onSignal(signal: NodeJS.Signals): void {
  interrupted = true
  abortController.abort(new Error(`${signal} received`))
  terminateChildren()
}

function commandFailure(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  return new Error(`${command} exited (${code ?? signal ?? 'unknown'})`)
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly timeoutMs?: number
    readonly nonAbortable?: boolean
  } = {},
): Promise<CommandResult> {
  if (!options.nonAbortable && abortController.signal.aborted) {
    throw safeError(abortController.signal.reason)
  }
  const rendered = [command, ...args].join(' ')
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: options.env ?? childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    if (options.nonAbortable) nonAbortableChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let abortListener: (() => void) | undefined
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      }, 1_000).unref()
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      children.delete(child)
      nonAbortableChildren.delete(child)
      clearTimeout(timeout)
      if (abortListener !== undefined) {
        abortController.signal.removeEventListener('abort', abortListener)
      }
      if (error !== undefined) rejectPromise(error)
      else resolvePromise({ stdout, stderr })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64_000) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) =>
      finish(new Error(`${rendered}: ${error.message}`)),
    )
    child.once('close', (code, signal) => {
      if (code === 0) finish()
      else finish(commandFailure(rendered, code, signal))
    })
    const terminate = (): void => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      }, 1_000).unref()
    }
    if (!options.nonAbortable) {
      abortListener = terminate
      abortController.signal.addEventListener('abort', abortListener, {
        once: true,
      })
    }
  })
}

function requireKey(): Buffer {
  const encoded = process.env.PLANNER_O02_BACKUP_KEY
  delete process.env.PLANNER_O02_BACKUP_KEY
  if (encoded === undefined || encoded.length === 0) {
    throw new Error('PLANNER_O02_BACKUP_KEY is required')
  }
  const key = Buffer.from(encoded, 'base64url')
  if (key.length !== KEY_BYTES || key.toString('base64url') !== encoded) {
    key.fill(0)
    throw new Error(
      'PLANNER_O02_BACKUP_KEY must be canonical base64url for 32 bytes',
    )
  }
  return key
}

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

function canonical(value: unknown): string {
  return JSON.stringify(normalized(value))
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

async function queryRows(
  client: PoolClient,
  query: string,
): Promise<ManifestRow[]> {
  const result = await client.query(query)
  return result.rows.map((row) => normalized(row) as ManifestRow)
}

async function captureManifest(pool: Pool): Promise<Manifest> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const tables: ManifestTables = {
      users: await queryRows(client, 'SELECT * FROM users ORDER BY id'),
      memberships: await queryRows(
        client,
        'SELECT * FROM memberships ORDER BY id',
      ),
      externalIdentities: await queryRows(
        client,
        'SELECT * FROM telegram_external_identities ORDER BY issuer, subject',
      ),
      planMonths: await queryRows(
        client,
        'SELECT * FROM plan_months ORDER BY id',
      ),
      publications: await queryRows(
        client,
        'SELECT * FROM plan_publications ORDER BY id',
      ),
      goalSnapshots: await queryRows(
        client,
        'SELECT * FROM plan_goal_snapshots ORDER BY id',
      ),
      trackingFactRecords: await queryRows(
        client,
        'SELECT * FROM tracking_fact_records ORDER BY id',
      ),
      trackingFactRevisions: await queryRows(
        client,
        'SELECT * FROM tracking_fact_revisions ORDER BY id',
      ),
      trackingActionGroups: await queryRows(
        client,
        'SELECT * FROM tracking_action_groups ORDER BY id',
      ),
      trackingFactChanges: await queryRows(
        client,
        'SELECT * FROM tracking_fact_changes ORDER BY action_id, fact_record_id',
      ),
      reminderSchedules: await queryRows(
        client,
        'SELECT * FROM reminder_schedules ORDER BY id',
      ),
      reminderScheduleSlots: await queryRows(
        client,
        'SELECT * FROM reminder_schedule_slots ORDER BY id',
      ),
      reminderOccurrences: await queryRows(
        client,
        'SELECT * FROM reminder_occurrences ORDER BY id',
      ),
      notificationIntents: await queryRows(
        client,
        'SELECT * FROM notification_intents ORDER BY id',
      ),
      notificationAttempts: await queryRows(
        client,
        'SELECT * FROM notification_attempts ORDER BY id',
      ),
      reportRevisions: await queryRows(
        client,
        'SELECT * FROM report_revisions ORDER BY plan_month_id, revision',
      ),
    }
    const reportRows = await client.query<{
      readonly payload: unknown
      readonly payload_checksum: string
    }>(
      'SELECT payload, payload_checksum FROM report_revisions ORDER BY plan_month_id, revision',
    )
    const reportPayloadChecksums = reportRows.rows.map((row) => ({
      stored: row.payload_checksum,
      computed: reportPayloadChecksum(row.payload),
    }))
    await client.query('COMMIT')
    return { tables, reportPayloadChecksums }
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function assertSourceManifest(manifest: Manifest): void {
  const months = manifest.tables.planMonths
  const activeMonths = months.filter(
    (row) => row['active_publication_id'] !== null,
  )
  assert.ok(activeMonths.length > 0, 'manifest has no active publication')
  assert.ok(manifest.tables.users.length >= 2, 'manifest has no users')
  assert.ok(
    manifest.tables.memberships.length >= 2,
    'manifest has no memberships',
  )
  assert.ok(
    manifest.tables.externalIdentities.length >= 2,
    'manifest has no external identities',
  )
  assert.ok(
    manifest.tables.publications.length > 0,
    'manifest has no publication',
  )
  assert.ok(
    manifest.tables.goalSnapshots.length > 0,
    'manifest has no goal snapshots',
  )
  assert.ok(
    manifest.tables.trackingFactRecords.some(
      (row) => row['current_revision_id'] !== null,
    ),
    'manifest has no current fact pointer',
  )
  assert.ok(
    manifest.tables.trackingFactRevisions.length > 0,
    'manifest has no fact revisions',
  )
  const pendingOccurrenceIds = new Set(
    manifest.tables.reminderOccurrences
      .filter((row) => row['state'] === 'pending')
      .map((row) => row['id']),
  )
  assert.ok(
    pendingOccurrenceIds.size > 0,
    'manifest has no pending reminder occurrence',
  )
  assert.ok(
    manifest.tables.notificationAttempts.some(
      (row) =>
        pendingOccurrenceIds.has(row['occurrence_id']) &&
        row['outcome'] === 'retryable' &&
        row['state'] === 'terminal',
    ),
    'manifest has no retryable reminder attempt',
  )
  const statuses = new Set(
    manifest.tables.reportRevisions.map((row) => row['status']),
  )
  assert.ok(statuses.has('original'), 'manifest has no original report')
  assert.ok(statuses.has('revised'), 'manifest has no revised report')
  assert.ok(
    manifest.reportPayloadChecksums.length > 0,
    'manifest has no report payload',
  )
  for (const checksum of manifest.reportPayloadChecksums) {
    compareSafeValues(
      'source.report_payload_checksum',
      checksum.stored,
      checksum.computed,
    )
  }
}

async function redisSessionCount(url: string): Promise<{
  readonly dbSize: number
  readonly scanned: number
  readonly sessions: number
  readonly keysDigest: string
}> {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  })
  client.on('error', () => undefined)
  try {
    await client.connect()
    const dbSize = await client.dbSize()
    let scanned = 0
    let sessions = 0
    const keys = createHash('sha256')
    for await (const page of client.scanIterator({ MATCH: '*', COUNT: 100 })) {
      for (const key of page) {
        if (typeof key !== 'string') continue
        scanned += 1
        keys.update(key)
        if (key.split(':').includes('session')) sessions += 1
      }
    }
    return { dbSize, scanned, sessions, keysDigest: keys.digest('hex') }
  } finally {
    client.destroy()
  }
}

async function inspectMounts(containerId: string): Promise<MountInfo[]> {
  const result = await runCommand('docker', [
    'inspect',
    '--format',
    '{{json .Mounts}}',
    containerId,
  ])
  const mounts = JSON.parse(result.stdout.trim()) as readonly {
    readonly Source?: string
    readonly Name?: string
  }[]
  return mounts.flatMap((mount) => {
    if (mount.Source === undefined) return []
    return [
      {
        source: mount.Source,
        ...(mount.Name === undefined ? {} : { name: mount.Name }),
      },
    ]
  })
}

function envelopeHeader(iv: Buffer): Buffer {
  const body = Buffer.from(
    JSON.stringify({
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      version: ENVELOPE_VERSION,
    }),
    'utf8',
  )
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([ENVELOPE_MAGIC, length, body])
}

function parseEnvelope(value: Buffer): Envelope {
  assert.ok(
    value.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC),
    'invalid backup envelope',
  )
  const lengthOffset = ENVELOPE_MAGIC.length
  const bodyLength = value.readUInt32BE(lengthOffset)
  const headerEnd = lengthOffset + 4 + bodyLength
  const header = value.subarray(0, headerEnd)
  const body = JSON.parse(
    value.subarray(lengthOffset + 4, headerEnd).toString('utf8'),
  ) as {
    readonly algorithm?: string
    readonly iv?: string
    readonly version?: number
  }
  assert.equal(
    body.version,
    ENVELOPE_VERSION,
    'unsupported backup envelope version',
  )
  assert.equal(
    body.algorithm,
    'aes-256-gcm',
    'unsupported backup envelope algorithm',
  )
  const iv = Buffer.from(body.iv ?? '', 'base64url')
  assert.equal(iv.length, IV_BYTES, 'invalid backup envelope IV')
  assert.ok(
    value.length > headerEnd + AUTH_TAG_BYTES,
    'empty backup ciphertext',
  )
  return {
    header,
    headerEnd,
    ciphertext: value.subarray(headerEnd, value.length - AUTH_TAG_BYTES),
    tag: value.subarray(value.length - AUTH_TAG_BYTES),
  }
}

function envelopeIv(envelope: Envelope): Buffer {
  const body = JSON.parse(
    envelope.header.subarray(ENVELOPE_MAGIC.length + 4).toString('utf8'),
  ) as { readonly iv: string }
  return Buffer.from(body.iv, 'base64url')
}

async function decryptEnvelopeTo(
  value: Buffer,
  key: Buffer,
  destination: NodeJS.WritableStream,
): Promise<void> {
  const envelope = parseEnvelope(value)
  const decipher = createDecipheriv('aes-256-gcm', key, envelopeIv(envelope))
  decipher.setAAD(envelope.header)
  decipher.setAuthTag(envelope.tag)
  await pipeline(Readable.from(envelope.ciphertext), decipher, destination)
}

async function authenticateEnvelope(value: Buffer, key: Buffer): Promise<void> {
  await decryptEnvelopeTo(
    value,
    key,
    new Writable({ write: (_chunk, _encoding, callback) => callback() }),
  )
}

async function encryptPgDump(
  source: StartedPostgreSqlContainer,
  artifactPath: string,
  key: Buffer,
): Promise<{ readonly bytes: number; readonly digest: string }> {
  const iv = randomBytes(IV_BYTES)
  const header = envelopeHeader(iv)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const output = createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    output.once('open', () => resolvePromise())
    output.once('error', rejectPromise)
  })
  await chmod(artifactPath, 0o600)
  output.write(header)
  const child = spawn(
    'docker',
    [
      'exec',
      '--interactive',
      source.getId(),
      'pg_dump',
      '--username',
      POSTGRES_USER,
      '--dbname',
      source.getDatabase(),
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ],
    {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4_000) stderr += chunk.toString('utf8')
  })
  cipher.pipe(output, { end: false })
  const pipelinePromise = pipeline(child.stdout, cipher)
  const exitPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(commandFailure('pg_dump', code, signal))
    })
  })
  try {
    await Promise.all([pipelinePromise, exitPromise])
  } catch (error: unknown) {
    child.kill('SIGTERM')
    await pipelinePromise.catch(() => undefined)
    throw new Error(`pg_dump failed: ${safeError(error).message}`, {
      cause: error,
    })
  } finally {
    children.delete(child)
  }
  const tag = cipher.getAuthTag()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    output.once('error', rejectPromise)
    output.end(tag, () => resolvePromise())
  })
  const artifact = await readFile(artifactPath)
  assert.equal(artifact.subarray(0, header.length).equals(header), true)
  return { bytes: artifact.length, digest: digest(artifact) }
}

async function restoreWithPgRestore(
  target: StartedPostgreSqlContainer,
  artifact: Buffer,
  key: Buffer,
): Promise<void> {
  const envelope = parseEnvelope(artifact)
  const decipher = createDecipheriv('aes-256-gcm', key, envelopeIv(envelope))
  decipher.setAAD(envelope.header)
  decipher.setAuthTag(envelope.tag)
  const child = spawn(
    'docker',
    [
      'exec',
      '--interactive',
      target.getId(),
      'pg_restore',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--username',
      POSTGRES_USER,
      '--dbname',
      target.getDatabase(),
    ],
    {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  )
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4_000) stderr += chunk.toString('utf8')
  })
  const closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(commandFailure('pg_restore', code, signal))
    })
  })
  try {
    await Promise.all([
      pipeline(Readable.from(envelope.ciphertext), decipher, child.stdin),
      closePromise,
    ])
  } catch (error: unknown) {
    child.kill('SIGTERM')
    throw new Error(`pg_restore failed: ${safeError(error).message}`, {
      cause: error,
    })
  } finally {
    children.delete(child)
  }
}

async function localMigrationInventory(): Promise<string[]> {
  const entries = await readdir(resolve('prisma/migrations'), {
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function databaseMigrationInventory(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ readonly migration_name: string }>(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  )
  return result.rows.map((row) => row.migration_name)
}

async function stopResource(
  label: string,
  resource: { stop(): Promise<unknown> } | undefined,
): Promise<Error | undefined> {
  if (resource === undefined) return undefined
  try {
    await Promise.race([
      resource.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('resource stop timeout')),
          30_000,
        ).unref(),
      ),
    ])
    return undefined
  } catch {
    return new Error(`cleanup failed for ${label}`)
  }
}

async function cleanup(
  resources: OwnedResources,
  pool: Pool | undefined,
  tempRoot: string | undefined,
  artifactPath: string | undefined,
): Promise<void> {
  const failures: Error[] = []
  if (pool !== undefined) {
    try {
      await pool.end()
    } catch {
      failures.push(new Error('cleanup failed for source database pool'))
    }
  }
  const resourceResults = await Promise.all([
    stopResource('target Redis', resources.targetRedis),
    stopResource('target PostgreSQL', resources.targetPostgres),
    stopResource('source Redis', resources.sourceRedis),
    stopResource('source PostgreSQL', resources.sourcePostgres),
  ])
  failures.push(
    ...resourceResults.flatMap((failure) => (failure ? [failure] : [])),
  )
  if (artifactPath !== undefined) {
    try {
      await rm(artifactPath, { force: true })
    } catch {
      failures.push(new Error('cleanup failed for encrypted artifact'))
    }
  }
  if (tempRoot !== undefined) {
    try {
      await rm(tempRoot, { recursive: true, force: true })
    } catch {
      failures.push(new Error('cleanup failed for temporary root'))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'owned cleanup failed')
  }
}

async function scopedCleanupProof(
  tempRoot: string | undefined,
  volumeNames: readonly string[],
): Promise<void> {
  await runCommand('docker', ['info'], {
    timeoutMs: 30_000,
    nonAbortable: true,
  })
  const result = await runCommand(
    'docker',
    ['ps', '-aq', '--filter', `label=planner.o02.run=${runId}`],
    { timeoutMs: 30_000, nonAbortable: true },
  )
  const remainingContainers = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0)
  if (remainingContainers.length > 0) {
    throw new Error(
      `cleanup proof found owned containers count=${remainingContainers.length}`,
    )
  }
  let remainingVolumes = 0
  for (const volumeName of volumeNames) {
    await assertOwnedVolumeGone(volumeName, async () => {
      const result = await runCommand(
        'docker',
        [
          'volume',
          'ls',
          '--format',
          '{{.Name}}',
          '--filter',
          `name=${volumeName}`,
        ],
        {
          timeoutMs: 30_000,
          nonAbortable: true,
        },
      )
      return result.stdout
        .trim()
        .split(/\s+/)
        .filter((value) => value.length > 0)
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === 'cleanup proof found an owned volume'
      ) {
        remainingVolumes += 1
        return
      }
      throw error
    })
  }
  const tempGone =
    tempRoot === undefined ||
    (await (async () => {
      try {
        await assertTempRootGone(tempRoot)
        return true
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === 'cleanup proof found temporary artifact'
        ) {
          return false
        }
        throw error
      }
    })())
  if (remainingVolumes > 0) {
    throw new Error(
      `cleanup proof found owned volumes count=${remainingVolumes}`,
    )
  }
  if (!tempGone) throw new Error('cleanup proof found temporary artifact')
  console.log(
    `cleanup: run=${runId} containers=0 volumes=0 temp_artifact=removed`,
  )
}

async function waitForSignalProbe(): Promise<void> {
  if (process.env.PLANNER_O02_WAIT_FOR_SIGNAL_AFTER_BACKUP !== '1') return
  console.log(`signal-probe-ready: run=${runId}`)
  if (interrupted) return
  await new Promise<void>((resolvePromise) => {
    const timer = setInterval(() => {
      if (!interrupted) return
      clearInterval(timer)
      resolvePromise()
    }, 25)
  })
}

async function drill(key: Buffer): Promise<void> {
  const drillStartedAt = Date.now()
  const resources: OwnedResources = {}
  let sourcePool: Pool | undefined
  let tempRoot: string | undefined
  let artifactPath: string | undefined
  const ownedVolumeNames = new Set<string>()
  let drillFailure: Error | undefined
  try {
    console.log(`run=${runId}`)
    console.log(
      `recovery scope: docker ps -aq --filter label=planner.o02.run=${runId}`,
    )
    console.log(
      'resources: source/target PostgreSQL and Redis use unique names and labels; Redis is never backed up',
    )
    const sourceDatabase = `planner_o02_source_${runId.replaceAll('-', '_')}`
    const targetDatabase = `planner_o02_target_${runId.replaceAll('-', '_')}`
    const sourcePostgresName = `planner-${runId}-source-postgres`
    const sourceRedisName = `planner-${runId}-source-redis`
    const targetPostgresName = `planner-${runId}-target-postgres`
    const targetRedisName = `planner-${runId}-target-redis`
    const labels = {
      'planner.o02.run': runId,
      'planner.o02.scope': 'restore-drill',
    }

    resources.sourcePostgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(sourceDatabase)
      .withUsername(POSTGRES_USER)
      .withPassword(POSTGRES_PASSWORD)
      .withName(sourcePostgresName)
      .withLabels({ ...labels, 'planner.o02.role': 'source-postgres' })
      .start()
    resources.sourceRedis = await new RedisContainer(REDIS_IMAGE)
      .withPassword('planner-session-test-only')
      .withName(sourceRedisName)
      .withLabels({ ...labels, 'planner.o02.role': 'source-redis' })
      .start()
    const sourceMounts = await inspectMounts(resources.sourcePostgres.getId())
    for (const mount of sourceMounts) {
      if (mount.name !== undefined) ownedVolumeNames.add(mount.name)
    }
    const sourceDatabaseUrl = resources.sourcePostgres.getConnectionUri()
    const sourceRedisUrl = resources.sourceRedis.getConnectionUrl()
    await runCommand(
      'node',
      [
        '--experimental-vm-modules',
        './node_modules/jest/bin/jest.js',
        '--config',
        'jest.e2e.config.mjs',
        '--runInBand',
        '--runTestsByPath',
        'test/e2e/pilot/full-month-pilot.e2e.spec.ts',
      ],
      {
        timeoutMs: 300_000,
        env: childEnvironment({
          PLANNER_E01_EXTERNAL_DATABASE_URL: sourceDatabaseUrl,
          PLANNER_E01_EXTERNAL_REDIS_URL: sourceRedisUrl,
          PLANNER_E01_RESTORE_FIXTURE: '1',
        }),
      },
    )
    const sourceRedisState = await redisSessionCount(sourceRedisUrl)
    assert.ok(sourceRedisState.dbSize > 0, 'source Redis is empty')
    assert.ok(
      sourceRedisState.sessions > 0,
      `source Redis has no session keys (dbsize=${sourceRedisState.dbSize}, scanned=${sourceRedisState.scanned}, digest=${sourceRedisState.keysDigest})`,
    )

    sourcePool = new Pool({ connectionString: sourceDatabaseUrl })
    const sourceManifest = await captureManifest(sourcePool)
    assertSourceManifest(sourceManifest)

    tempRoot = await mkdtemp(resolve(tmpdir(), `planner-${runId}-`))
    artifactPath = resolve(tempRoot, 'backup.enc')
    const backupStartedAt = Date.now()
    const backup = await encryptPgDump(
      resources.sourcePostgres,
      artifactPath,
      key,
    )
    const backupDurationMs = Date.now() - backupStartedAt
    const artifact = await readFile(artifactPath)
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600)
    assert.equal(artifact.length, backup.bytes)
    assert.equal(digest(artifact), backup.digest)
    const tampered = Buffer.from(artifact)
    const parsed = parseEnvelope(tampered)
    const tamperIndex =
      parsed.headerEnd + Math.floor(parsed.ciphertext.length / 2)
    const tamperByte = tampered.at(tamperIndex)
    if (tamperByte === undefined) throw new Error('backup ciphertext is empty')
    tampered[tamperIndex] = tamperByte ^ 1
    await assert.rejects(
      authenticateEnvelope(tampered, key),
      /Unsupported state|authenticate|bad decrypt|unable to authenticate/i,
    )
    await authenticateEnvelope(artifact, key)
    console.log(
      `backup: bytes=${backup.bytes} digest=${backup.digest} duration_ms=${backupDurationMs}`,
    )

    await waitForSignalProbe()
    if (interrupted) throw new Error('signal received')
    if (process.env.PLANNER_O02_FAIL_AFTER_BACKUP === '1') {
      throw new Error('controlled failure after encrypted backup')
    }

    resources.targetPostgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(targetDatabase)
      .withUsername(POSTGRES_USER)
      .withPassword(POSTGRES_PASSWORD)
      .withName(targetPostgresName)
      .withLabels({ ...labels, 'planner.o02.role': 'target-postgres' })
      .start()
    resources.targetRedis = await new RedisContainer(REDIS_IMAGE)
      .withPassword('planner-session-test-only')
      .withName(targetRedisName)
      .withLabels({ ...labels, 'planner.o02.role': 'target-redis' })
      .start()
    assert.notEqual(
      resources.sourcePostgres.getId(),
      resources.targetPostgres.getId(),
    )
    assert.notEqual(
      resources.sourceRedis.getId(),
      resources.targetRedis.getId(),
    )
    assert.notEqual(
      resources.sourcePostgres.getName(),
      resources.targetPostgres.getName(),
    )
    assert.deepEqual(
      resources.sourcePostgres.getLabels()['planner.o02.run'],
      resources.targetPostgres.getLabels()['planner.o02.run'],
    )
    const targetMounts = await inspectMounts(resources.targetPostgres.getId())
    for (const mount of targetMounts) {
      if (mount.name !== undefined) ownedVolumeNames.add(mount.name)
    }
    assert.ok(
      sourceMounts.length > 0,
      'source PostgreSQL has no persistent mount',
    )
    assert.ok(
      targetMounts.length > 0,
      'target PostgreSQL has no persistent mount',
    )
    assert.equal(
      sourceMounts.some((sourceMount) =>
        targetMounts.some(
          (targetMount) => targetMount.source === sourceMount.source,
        ),
      ),
      false,
    )
    const targetRedisState = await redisSessionCount(
      resources.targetRedis.getConnectionUrl(),
    )
    assert.equal(targetRedisState.dbSize, 0)
    assert.equal(targetRedisState.sessions, 0)

    const restoreStartedAt = Date.now()
    await restoreWithPgRestore(resources.targetPostgres, artifact, key)
    const targetDatabaseUrl = resources.targetPostgres.getConnectionUri()
    await runCommand('pnpm', ['start:migrate'], {
      timeoutMs: 180_000,
      env: childEnvironment({ DATABASE_URL: targetDatabaseUrl }),
    })
    const targetPool = new Pool({ connectionString: targetDatabaseUrl })
    try {
      const [targetManifest, localMigrations, targetMigrations] =
        await Promise.all([
          captureManifest(targetPool),
          localMigrationInventory(),
          databaseMigrationInventory(targetPool),
        ])
      for (const category of Object.keys(sourceManifest.tables) as Array<
        keyof ManifestTables
      >) {
        compareSafeArrays(
          `manifest.${category}`,
          sourceManifest.tables[category],
          targetManifest.tables[category],
        )
      }
      compareSafeArrays(
        'report_payload_checksums',
        sourceManifest.reportPayloadChecksums,
        targetManifest.reportPayloadChecksums,
      )
      for (const checksum of targetManifest.reportPayloadChecksums) {
        compareSafeValues(
          'target.report_payload_checksum',
          checksum.stored,
          checksum.computed,
        )
      }
      compareSafeArrays(
        'migration_inventory',
        localMigrations,
        targetMigrations,
      )
      const restoreDurationMs = Date.now() - restoreStartedAt
      const totalDurationMs = Date.now() - drillStartedAt
      const manifestSummary = Object.entries(sourceManifest.tables)
        .map(
          ([name, rows]) =>
            `${name}=${rows.length}/${digest(rows).slice(0, 16)}`,
        )
        .join(' ')
      console.log(`manifest: ${manifestSummary}`)
      console.log(
        `migrations: count=${targetMigrations.length} digest=${digest(targetMigrations)}`,
      )
      console.log(
        `redis: source_dbsize=${sourceRedisState.dbSize} source_sessions=${sourceRedisState.sessions} target_dbsize=${targetRedisState.dbSize}`,
      )
      console.log(
        `durations_ms: backup=${backupDurationMs} restore_migrations_verification=${restoreDurationMs} total=${totalDurationMs}`,
      )
      console.log(
        'evidence boundary: local restore only; no production RPO/RTO, retention, PITR, off-host storage, hosted, CI, deployment, TLS/DNS, Telegram or OIDC claim',
      )
    } finally {
      await targetPool.end()
    }
  } catch (error: unknown) {
    drillFailure = safeError(error)
  }
  const cleanupFailures: Error[] = []
  try {
    await cleanup(resources, sourcePool, tempRoot, artifactPath)
  } catch (error: unknown) {
    cleanupFailures.push(safeError(error))
  }
  try {
    await scopedCleanupProof(tempRoot, [...ownedVolumeNames])
  } catch (error: unknown) {
    cleanupFailures.push(safeError(error))
  }
  if (drillFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [
        ...(drillFailure === undefined ? [] : [drillFailure]),
        ...cleanupFailures,
      ],
      'restore drill or cleanup failed',
    )
  }
}

async function main(): Promise<void> {
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  let key: Buffer | undefined
  let failure: Error | undefined
  try {
    key = requireKey()
    await drill(key)
  } catch (error: unknown) {
    failure = safeError(error)
  } finally {
    key?.fill(0)
  }
  if (interrupted) {
    console.error('planner restore smoke: INTERRUPTED')
    process.exitCode = 130
    return
  }
  if (failure !== undefined) {
    console.error(`planner restore smoke: FAILED: ${failure.message}`)
    process.exitCode = 1
    return
  }
  console.log('planner restore smoke: PASS')
}

void main().catch((error: unknown) => {
  console.error(`planner restore smoke: FAILED: ${safeError(error).message}`)
  process.exitCode = interrupted ? 130 : 1
})
