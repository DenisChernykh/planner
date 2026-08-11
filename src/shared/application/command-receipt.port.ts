export type CommandReceiptKey = {
  readonly actorScope: string
  readonly commandType: string
  readonly commandId: string
}

export type CompletedCommandReceipt = CommandReceiptKey & {
  readonly fingerprint: string
  readonly resultKind: string
  readonly aggregateId: string
  readonly aggregateRevision: bigint
  readonly completedAt: Date
}

export interface CommandReceiptPort {
  acquireLock(key: CommandReceiptKey): Promise<void>
  findCompleted(key: CommandReceiptKey): Promise<CompletedCommandReceipt | null>
  insertCompleted(receipt: CompletedCommandReceipt): Promise<void>
}

export const COMMAND_RECEIPT_PORT: unique symbol = Symbol(
  'COMMAND_RECEIPT_PORT',
)
