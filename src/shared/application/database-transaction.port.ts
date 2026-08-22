export type DatabaseTransactionOptions = {
  readonly mode?: 'default' | 'repeatable_read_only'
}

/** Runs one application operation inside a module-local database transaction. */
export interface DatabaseTransactionPort {
  run<T>(
    operation: () => Promise<T>,
    options?: DatabaseTransactionOptions,
  ): Promise<T>
}

/** Injection token for later product-module transaction participants. */
export const DATABASE_TRANSACTION_PORT: unique symbol = Symbol(
  'DATABASE_TRANSACTION_PORT',
)

/** Prevents an outer transaction from committing after a nested failure. */
export class DatabaseTransactionRollbackOnlyError extends Error {
  public constructor(cause: unknown) {
    super('Database transaction is marked rollback-only', { cause })
    this.name = 'DatabaseTransactionRollbackOnlyError'
  }
}
