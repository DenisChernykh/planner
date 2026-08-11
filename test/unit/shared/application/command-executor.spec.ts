import type {
  ApplicationCommand,
  CanonicalJsonObject,
  CommandDefinition,
  CommandExecutionContext,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'
import type {
  CommandReceiptKey,
  CommandReceiptPort,
  CompletedCommandReceipt,
} from '@/shared/application/command-receipt.port'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

type Payload = { readonly value: string }
const definition: CommandDefinition<Payload, 'test.aggregate.v1'> = {
  commandType: 'test.change.v1',
  resultKind: 'test.aggregate.v1',
  toCanonicalPayload(payload): CanonicalJsonObject {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      Object.keys(payload).join(',') !== 'value' ||
      typeof payload.value !== 'string'
    ) {
      throw new CommandValidationError()
    }
    return { value: payload.value }
  },
}

function command(
  overrides: Partial<ApplicationCommand<Payload>> = {},
): ApplicationCommand<Payload> {
  return {
    commandId: '11111111-1111-4111-8111-111111111111',
    trustedActor: {
      kind: 'member',
      id: '22222222-2222-4222-8222-222222222222',
    },
    expectedRevision: 1n,
    payload: { value: 'after' },
    ...overrides,
  }
}

function keyText(key: CommandReceiptKey): string {
  return `${key.actorScope}|${key.commandType}|${key.commandId}`
}

class FakeReceiptPort implements CommandReceiptPort {
  public readonly events: string[] = []
  public receipts = new Map<string, CompletedCommandReceipt>()
  public rejectInsert = false

  public acquireLock(key: CommandReceiptKey): Promise<void> {
    this.events.push(`lock:${key.actorScope}`)
    return Promise.resolve()
  }

  public findCompleted(
    key: CommandReceiptKey,
  ): Promise<CompletedCommandReceipt | null> {
    this.events.push('find')
    return Promise.resolve(this.receipts.get(keyText(key)) ?? null)
  }

  public insertCompleted(receipt: CompletedCommandReceipt): Promise<void> {
    this.events.push('insert')
    if (this.rejectInsert) return Promise.reject(new Error('insert failed'))
    this.receipts.set(keyText(receipt), receipt)
    return Promise.resolve()
  }
}

class RollbackTransaction implements DatabaseTransactionPort {
  public constructor(private readonly receipts: FakeReceiptPort) {}

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.receipts.events.push('transaction')
    const snapshot = new Map(this.receipts.receipts)
    try {
      return await operation()
    } catch (error: unknown) {
      this.receipts.receipts = snapshot
      throw error
    }
  }
}

class CountingClock implements ProductClock {
  public calls = 0
  public value = new Date('2026-04-02T03:04:05.678Z')

  public now(): Date {
    this.calls += 1
    return new Date(this.value.getTime())
  }

  public today(): string {
    throw new Error('today is outside this command contract')
  }
}

function createHarness(): {
  readonly receipts: FakeReceiptPort
  readonly clock: CountingClock
  readonly executor: DurableCommandExecutor
} {
  const receipts = new FakeReceiptPort()
  const clock = new CountingClock()
  return {
    receipts,
    clock,
    executor: new DurableCommandExecutor(
      new RollbackTransaction(receipts),
      receipts,
      clock,
    ),
  }
}

const invalidResultCases: ReadonlyArray<readonly [string, unknown]> = [
  [
    'wrong kind',
    {
      kind: 'wrong',
      aggregateId: '33333333-3333-4333-8333-333333333333',
      aggregateRevision: 1n,
    },
  ],
  [
    'non-canonical ID',
    {
      kind: 'test.aggregate.v1',
      aggregateId: 'NOT-A-UUID',
      aggregateRevision: 1n,
    },
  ],
  [
    'non-positive revision',
    {
      kind: 'test.aggregate.v1',
      aggregateId: '33333333-3333-4333-8333-333333333333',
      aggregateRevision: 0n,
    },
  ],
  [
    'String object aggregate ID',
    {
      kind: 'test.aggregate.v1',
      aggregateId: new String('33333333-3333-4333-8333-333333333333'),
      aggregateRevision: 1n,
    },
  ],
  ...[
    ['number revision', 1],
    ['string revision', '1'],
    ['fraction revision', 1.5],
    ['NaN revision', Number.NaN],
    ['undefined revision', undefined],
    ['String object revision', new String('1')],
  ].map(([label, aggregateRevision]): readonly [string, unknown] => [
    label as string,
    {
      kind: 'test.aggregate.v1',
      aggregateId: '33333333-3333-4333-8333-333333333333',
      aggregateRevision,
    },
  ]),
]

describe('DurableCommandExecutor', () => {
  it('locks and checks receipt before one clock read and effect, then inserts the typed ref with the same timestamp', async () => {
    const { receipts, clock, executor } = createHarness()
    const effect = jest.fn(
      ({
        occurredAt,
      }: CommandExecutionContext): Promise<
        DurableCommandResultRef<'test.aggregate.v1'>
      > => {
        receipts.events.push(`effect:${occurredAt.toISOString()}`)
        return Promise.resolve({
          kind: 'test.aggregate.v1',
          aggregateId: '33333333-3333-4333-8333-333333333333',
          aggregateRevision: 2n,
        })
      },
    )

    await expect(
      executor.execute(definition, command(), effect),
    ).resolves.toEqual({
      kind: 'test.aggregate.v1',
      aggregateId: '33333333-3333-4333-8333-333333333333',
      aggregateRevision: 2n,
    })
    expect(receipts.events).toEqual([
      'transaction',
      'lock:member:22222222-2222-4222-8222-222222222222',
      'find',
      'effect:2026-04-02T03:04:05.678Z',
      'insert',
    ])
    expect(clock.calls).toBe(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect([...receipts.receipts.values()][0]?.completedAt.toISOString()).toBe(
      '2026-04-02T03:04:05.678Z',
    )
  })

  it('replays a completed typed ref without clock or effect after time advances', async () => {
    const { receipts, clock, executor } = createHarness()
    const first = jest.fn(() =>
      Promise.resolve({
        kind: 'test.aggregate.v1' as const,
        aggregateId: '33333333-3333-4333-8333-333333333333',
        aggregateRevision: 2n,
      }),
    )
    const result = await executor.execute(definition, command(), first)
    clock.value = new Date('2030-01-01T00:00:00.000Z')
    const replayEffect = jest.fn(() => Promise.resolve(result))

    await expect(
      executor.execute(definition, command(), replayEffect),
    ).resolves.toEqual(result)
    expect(clock.calls).toBe(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(replayEffect).not.toHaveBeenCalled()
    expect(receipts.events.slice(-2)).toEqual([
      'lock:member:22222222-2222-4222-8222-222222222222',
      'find',
    ])
  })

  it('projects an accessor result once to the exact frozen ref returned by replay', async () => {
    const { clock, executor } = createHarness()
    const reads = { kind: 0, aggregateId: 0, aggregateRevision: 0 }
    const effectResult = Object.defineProperties(
      { extra: 'must-not-escape' },
      {
        kind: {
          enumerable: true,
          get: () => {
            reads.kind += 1
            return 'test.aggregate.v1'
          },
        },
        aggregateId: {
          enumerable: true,
          get: () => {
            reads.aggregateId += 1
            return '33333333-3333-4333-8333-333333333333'
          },
        },
        aggregateRevision: {
          enumerable: true,
          get: () => {
            reads.aggregateRevision += 1
            return 2n
          },
        },
      },
    ) as DurableCommandResultRef<'test.aggregate.v1'> & {
      readonly extra: string
    }
    const effect = jest.fn(() => Promise.resolve(effectResult))

    const fresh = await executor.execute(definition, command(), effect)
    const replay = await executor.execute(definition, command(), () =>
      Promise.reject(new Error('replay effect must not run')),
    )
    const exact = {
      kind: 'test.aggregate.v1',
      aggregateId: '33333333-3333-4333-8333-333333333333',
      aggregateRevision: 2n,
    }

    expect({ fresh, replay, reads }).toEqual({
      fresh: exact,
      replay: exact,
      reads: { kind: 1, aggregateId: 1, aggregateRevision: 1 },
    })
    expect(Object.isFrozen(fresh)).toBe(true)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(clock.calls).toBe(1)
  })

  it('returns same-key fingerprint conflict before clock, permission-like effect or result validation', async () => {
    const { clock, executor } = createHarness()
    await executor.execute(definition, command(), () =>
      Promise.resolve({
        kind: 'test.aggregate.v1',
        aggregateId: '33333333-3333-4333-8333-333333333333',
        aggregateRevision: 2n,
      }),
    )
    const permission = jest.fn(() =>
      Promise.reject(new Error('permission must not run')),
    )

    await expect(
      executor.execute(
        definition,
        command({ payload: { value: 'different' } }),
        permission,
      ),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)
    expect(clock.calls).toBe(1)
    expect(permission).not.toHaveBeenCalled()
  })

  it.each([
    [
      'member scope',
      { kind: 'member', id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    ],
    ['invalid command ID', undefined],
  ])(
    'rejects non-canonical %s before opening a transaction',
    async (_label, actor) => {
      const { receipts, executor } = createHarness()
      await expect(
        executor.execute(
          definition,
          command(
            actor === undefined
              ? { commandId: 'not-a-uuid' }
              : {
                  trustedActor:
                    actor as ApplicationCommand<Payload>['trustedActor'],
                },
          ),
          () =>
            Promise.resolve({
              kind: 'test.aggregate.v1',
              aggregateId: '33333333-3333-4333-8333-333333333333',
              aggregateRevision: 2n,
            }),
        ),
      ).rejects.toBeInstanceOf(CommandValidationError)
      expect(receipts.events).toEqual([])
    },
  )

  it('uses the exact finite system actor scope', async () => {
    const { receipts, executor } = createHarness()
    await executor.execute(
      definition,
      command({ trustedActor: { kind: 'system', id: 'planner-worker' } }),
      () =>
        Promise.resolve({
          kind: 'test.aggregate.v1',
          aggregateId: '33333333-3333-4333-8333-333333333333',
          aggregateRevision: 2n,
        }),
    )
    expect(receipts.events).toContain('lock:system:planner-worker')
  })

  it.each([
    ['number', 1],
    ['string', '1'],
    ['fraction', 1.5],
    ['NaN', Number.NaN],
    ['undefined own property', undefined],
    ['String object', new String('1')],
  ])(
    'rejects runtime %s expectedRevision before opening a transaction',
    async (_label, value) => {
      const { receipts, executor } = createHarness()
      const malformed = {
        ...command(),
        expectedRevision: value,
      } as unknown as ApplicationCommand<Payload>
      await expect(
        executor.execute(definition, malformed, () =>
          Promise.resolve({
            kind: 'test.aggregate.v1',
            aggregateId: '33333333-3333-4333-8333-333333333333',
            aggregateRevision: 2n,
          }),
        ),
      ).rejects.toBeInstanceOf(CommandValidationError)
      expect(receipts.events).toEqual([])
    },
  )

  it.each([
    ['number command ID', 1, '22222222-2222-4222-8222-222222222222'],
    ['undefined command ID', undefined, '22222222-2222-4222-8222-222222222222'],
    [
      'String object command ID',
      new String('11111111-1111-4111-8111-111111111111'),
      '22222222-2222-4222-8222-222222222222',
    ],
    ['number actor ID', '11111111-1111-4111-8111-111111111111', 1],
    ['undefined actor ID', '11111111-1111-4111-8111-111111111111', undefined],
    [
      'String object actor ID',
      '11111111-1111-4111-8111-111111111111',
      new String('22222222-2222-4222-8222-222222222222'),
    ],
  ])(
    'rejects runtime %s without string coercion',
    async (_label, commandId, actorId) => {
      const { receipts, executor } = createHarness()
      const malformed = {
        ...command(),
        commandId,
        trustedActor: { kind: 'member', id: actorId },
      } as unknown as ApplicationCommand<Payload>
      await expect(
        executor.execute(definition, malformed, () =>
          Promise.resolve({
            kind: 'test.aggregate.v1',
            aggregateId: '33333333-3333-4333-8333-333333333333',
            aggregateRevision: 2n,
          }),
        ),
      ).rejects.toBeInstanceOf(CommandValidationError)
      expect(receipts.events).toEqual([])
    },
  )

  it.each(invalidResultCases)(
    'rolls back receipt completion for %s result',
    async (_label, result) => {
      const { receipts, executor } = createHarness()
      await expect(
        executor.execute(definition, command(), () =>
          Promise.resolve(
            result as DurableCommandResultRef<'test.aggregate.v1'>,
          ),
        ),
      ).rejects.toBeInstanceOf(CommandValidationError)
      expect(receipts.receipts.size).toBe(0)
    },
  )

  it('leaves no completed receipt when insert fails and executes a later retry again', async () => {
    const { receipts, executor } = createHarness()
    const effect = jest.fn(() =>
      Promise.resolve({
        kind: 'test.aggregate.v1' as const,
        aggregateId: '33333333-3333-4333-8333-333333333333',
        aggregateRevision: 2n,
      }),
    )
    receipts.rejectInsert = true
    await expect(
      executor.execute(definition, command(), effect),
    ).rejects.toThrow('insert failed')
    expect(receipts.receipts.size).toBe(0)

    receipts.rejectInsert = false
    await expect(
      executor.execute(definition, command(), effect),
    ).resolves.toMatchObject({
      aggregateRevision: 2n,
    })
    expect(effect).toHaveBeenCalledTimes(2)
    expect(receipts.receipts.size).toBe(1)
  })

  it('rejects effect mutation of occurredAt and rolls back without a receipt', async () => {
    const { receipts, clock, executor } = createHarness()
    await expect(
      executor.execute(definition, command(), ({ occurredAt }) => {
        occurredAt.setTime(new Date('2030-01-01T00:00:00.000Z').getTime())
        return Promise.resolve({
          kind: 'test.aggregate.v1',
          aggregateId: '33333333-3333-4333-8333-333333333333',
          aggregateRevision: 2n,
        })
      }),
    ).rejects.toBeInstanceOf(CommandValidationError)
    expect(clock.calls).toBe(1)
    expect(receipts.receipts.size).toBe(0)
  })
})
