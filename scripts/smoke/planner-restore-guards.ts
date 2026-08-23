import { Client, type Pool, type PoolClient } from 'pg'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function parseLoopbackUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${label} must not contain query parameters or fragments`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use a loopback host`)
  }
  return url
}

export function validatePostgresEndpoint(
  value: string,
  label: string,
  databasePrefix: string,
): { readonly databaseName: string } {
  const url = parseLoopbackUrl(value, label)
  const client = new Client({ connectionString: value })
  if (!LOOPBACK_HOSTS.has(client.host) || client.host.includes(',')) {
    throw new Error(`${label} effective host must be loopback`)
  }
  const databaseName = client.database ?? ''
  if (!databaseName.startsWith(databasePrefix)) {
    throw new Error(`${label} effective database must start ${databasePrefix}`)
  }
  const authorityDatabase = decodeURIComponent(url.pathname.slice(1))
  if (authorityDatabase !== databaseName) {
    throw new Error(`${label} effective database does not match URL authority`)
  }
  return { databaseName }
}

export function validateRedisEndpoint(value: string, label: string): void {
  const url = parseLoopbackUrl(value, label)
  if (url.hostname.includes(',')) {
    throw new Error(`${label} must use one loopback host`)
  }
}

export async function assertExternalDatabaseEmpty(
  pool: Pick<Pool, 'connect'>,
  expectedDatabaseName: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await assertCurrentDatabase(client, expectedDatabaseName)
    const customSchemas = await client.query<{ readonly name: string }>(
      `SELECT nspname AS name
         FROM pg_catalog.pg_namespace
        WHERE nspname <> 'public'
          AND nspname NOT IN ('pg_catalog', 'information_schema')
          AND nspname NOT LIKE 'pg_toast%'
          AND nspname NOT LIKE 'pg_temp_%'
        ORDER BY nspname`,
    )
    if (customSchemas.rowCount !== 0) {
      throw new Error('External E01 database has custom schemas')
    }
    const objects = await client.query<{
      readonly category: string
      readonly count: string
    }>(
      `WITH user_namespaces AS (
             SELECT oid
               FROM pg_catalog.pg_namespace
              WHERE nspname = 'public'
                 OR (nspname <> 'pg_catalog'
                 AND nspname <> 'information_schema'
                 AND nspname NOT LIKE 'pg_toast%'
                 AND nspname NOT LIKE 'pg_temp_%')
           ), objects AS (
             SELECT 'relation' AS category
               FROM pg_catalog.pg_class relation
               JOIN user_namespaces namespace
                 ON namespace.oid = relation.relnamespace
              WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
             UNION ALL
             SELECT 'function' AS category
               FROM pg_catalog.pg_proc procedure
               JOIN user_namespaces namespace
                 ON namespace.oid = procedure.pronamespace
             UNION ALL
             SELECT CASE type.typtype
                      WHEN 'e' THEN 'enum'
                      WHEN 'd' THEN 'domain'
                      WHEN 'c' THEN 'composite'
                      WHEN 'r' THEN 'range'
                      WHEN 'm' THEN 'multirange'
                    END AS category
               FROM pg_catalog.pg_type type
               JOIN user_namespaces namespace
                 ON namespace.oid = type.typnamespace
              WHERE type.typtype IN ('e', 'd', 'c', 'r', 'm')
             UNION ALL
             SELECT 'extension' AS category
               FROM pg_catalog.pg_extension extension
               JOIN user_namespaces namespace
                 ON namespace.oid = extension.extnamespace
           )
        SELECT category, count(*)::text AS count
          FROM objects
         GROUP BY category
         ORDER BY category`,
    )
    if (objects.rowCount !== 0) {
      const summary = objects.rows
        .map((row) => `${row.category}=${row.count}`)
        .join(',')
      throw new Error(
        `External E01 database must be empty before migrations (objects=${summary})`,
      )
    }
  } finally {
    client.release()
  }
}

async function assertCurrentDatabase(
  client: PoolClient,
  expectedDatabaseName: string,
): Promise<void> {
  const currentDatabase = await client.query<{ readonly name: string }>(
    'SELECT current_database() AS name',
  )
  if (currentDatabase.rows[0]?.name !== expectedDatabaseName) {
    throw new Error('External E01 connected to an unexpected database')
  }
}
