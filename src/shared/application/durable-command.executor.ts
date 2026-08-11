import type {
  ActorRef,
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from './application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from './application-command'
import { commandFingerprint } from './command-fingerprint'
import type {
  CommandReceiptKey,
  CommandReceiptPort,
  CompletedCommandReceipt,
} from './command-receipt.port'
import type { DatabaseTransactionPort } from './database-transaction.port'
import type { ProductClock } from './product-clock'

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function actorScope(actor: ActorRef): string {
  if (typeof actor !== 'object' || actor === null) {
    throw new CommandValidationError()
  }
  if (actor.kind === 'system') {
    if (actor.id !== 'planner-worker') throw new CommandValidationError()
    return 'system:planner-worker'
  }
  if (
    actor.kind === 'member' &&
    typeof actor.id === 'string' &&
    CANONICAL_UUID.test(actor.id)
  ) {
    return `member:${actor.id}`
  }
  throw new CommandValidationError()
}

function assertCommandIdentity(commandId: string): void {
  if (typeof commandId !== 'string' || !CANONICAL_UUID.test(commandId)) {
    throw new CommandValidationError()
  }
}

function resultFromReceipt<K extends string>(
  receipt: CompletedCommandReceipt,
  expectedKind: K,
): DurableCommandResultRef<K> {
  return validateResult(
    {
      kind: receipt.resultKind as K,
      aggregateId: receipt.aggregateId,
      aggregateRevision: receipt.aggregateRevision,
    },
    expectedKind,
  )
}

function validateResult<K extends string>(
  result: DurableCommandResultRef<K>,
  expectedKind: K,
): DurableCommandResultRef<K> {
  if (typeof result !== 'object' || result === null) {
    throw new CommandValidationError()
  }
  const kind = result.kind
  const aggregateId = result.aggregateId
  const aggregateRevision = result.aggregateRevision
  if (
    kind !== expectedKind ||
    typeof aggregateId !== 'string' ||
    !CANONICAL_UUID.test(aggregateId) ||
    typeof aggregateRevision !== 'bigint' ||
    aggregateRevision <= 0n
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    kind: expectedKind,
    aggregateId,
    aggregateRevision,
  })
}

export class DurableCommandExecutor implements CommandExecutor {
  public constructor(
    private readonly transaction: DatabaseTransactionPort,
    private readonly receipts: CommandReceiptPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    assertCommandIdentity(command.commandId)
    const scope = actorScope(command.trustedActor)
    const fingerprint = commandFingerprint(definition, command)
    const key: CommandReceiptKey = {
      actorScope: scope,
      commandType: definition.commandType,
      commandId: command.commandId,
    }
    return this.transaction.run(async () => {
      await this.receipts.acquireLock(key)
      const completed = await this.receipts.findCompleted(key)
      if (completed !== null) {
        if (completed.fingerprint !== fingerprint) {
          throw new CommandFingerprintConflictError()
        }
        return resultFromReceipt(completed, definition.resultKind)
      }

      const clockValue = this.clock.now()
      if (
        !(clockValue instanceof Date) ||
        !Number.isFinite(clockValue.getTime())
      ) {
        throw new CommandValidationError()
      }
      const occurredAt = new Date(clockValue.getTime())
      const occurredAtEpoch = occurredAt.getTime()
      const result = validateResult(
        await effect(Object.freeze({ occurredAt })),
        definition.resultKind,
      )
      if (occurredAt.getTime() !== occurredAtEpoch) {
        throw new CommandValidationError()
      }
      await this.receipts.insertCompleted({
        ...key,
        fingerprint,
        resultKind: result.kind,
        aggregateId: result.aggregateId,
        aggregateRevision: result.aggregateRevision,
        completedAt: new Date(occurredAtEpoch),
      })
      return result
    })
  }
}
