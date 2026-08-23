import assert from 'node:assert/strict'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  assertExternalDatabaseEmpty,
  validatePostgresEndpoint,
  validateRedisEndpoint,
} from './planner-restore-guards'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const runId = `o02-guard-${Date.now().toString(36)}`
const databaseName = `planner_o02_guard_${runId.replaceAll('-', '_')}`

async function main(): Promise<void> {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool | undefined
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(databaseName)
      .withUsername('planner')
      .withPassword('planner-test-only')
      .withName(`planner-${runId}`)
      .withLabels({ 'planner.o02.probe': runId })
      .start()
    const connectionUri = container.getConnectionUri()
    assert.throws(
      () =>
        validatePostgresEndpoint(
          `${connectionUri}?host=203.0.113.10&port=5432`,
          'probe database URL',
          'planner_o02_guard_',
        ),
      /query parameters or fragments/,
    )
    assert.throws(
      () =>
        validateRedisEndpoint(
          'redis://127.0.0.1:6379/0?host=203.0.113.10',
          'probe Redis URL',
        ),
      /query parameters or fragments/,
    )

    pool = new Pool({ connectionString: connectionUri })
    await assertExternalDatabaseEmpty(pool, databaseName)
    await pool.query(
      'CREATE VIEW public.o02_guard_probe_view AS SELECT 1 AS marker',
    )
    await assert.rejects(
      assertExternalDatabaseEmpty(pool, databaseName),
      /objects=.*relation=1/,
    )
    console.log(
      'guard probe: loopback query overrides rejected; non-table guard rejected',
    )
  } finally {
    await pool?.end().catch(() => undefined)
    await container?.stop().catch(() => undefined)
  }
  console.log('guard probe: PASS')
}

void main().catch((error: unknown) => {
  void error
  console.error('guard probe: FAILED')
  process.exitCode = 1
})
