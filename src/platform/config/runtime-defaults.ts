export const runtimeDefaults = Object.freeze({
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
})
