export const runtimeDefaults = Object.freeze({
  logging: Object.freeze({
    level: 'info' as const,
  }),
  http: Object.freeze({
    drainTimeoutMs: 6_000,
    shutdownGraceMs: 10_000,
  }),
  database: Object.freeze({
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 10_000,
    healthTimeoutMs: 1_000,
    transactionMaxWaitMs: 2_000,
    transactionTimeoutMs: 5_000,
  }),
  redis: Object.freeze({
    connectTimeoutMs: 2_000,
    commandTimeoutMs: 2_000,
    healthTimeoutMs: 2_500,
    shutdownTimeoutMs: 1_000,
  }),
  auth: Object.freeze({
    idleTimeoutMs: 604_800_000,
    absoluteTimeoutMs: 2_592_000_000,
    touchIntervalMs: 300_000,
  }),
  observability: Object.freeze({
    exporterTimeoutMs: 1_000,
    batchSpanScheduleDelayMs: 5_000,
    batchSpanExportTimeoutMs: 1_000,
  }),
})
