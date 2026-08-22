import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import {
  ReopenMonthCommand,
  canonicalReopenMonthPayload,
  type ReopenMonthApplicationCommand,
  type ReopenMonthPersistencePort,
} from '@/modules/planning/application/reopen-month.command'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import { CommandValidationError } from '@/shared/application/application-command'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'

const memberId = '11111111-1111-4111-8111-111111111111'
const spaceId = '22222222-2222-4222-8222-222222222222'
const planMonthId = '33333333-3333-4333-8333-333333333333'
const commandId = '44444444-4444-4444-8444-444444444444'

class ImmediateExecutor implements CommandExecutor {
  public calls = 0
  public definition: CommandDefinition<unknown, string> | undefined

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    this.calls += 1
    this.definition = definition as CommandDefinition<unknown, string>
    return effect({ occurredAt: new Date('2026-08-22T10:00:00.000Z') })
  }
}

class ShortCircuitExecutor implements CommandExecutor {
  public constructor(
    private readonly outcome:
      DurableCommandResultRef<'planning.plan-month.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    _definition: CommandDefinition<TPayload, K>,
    _command: ApplicationCommand<TPayload>,
    _effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    void _definition
    void _command
    void _effect
    if (this.outcome instanceof Error) return Promise.reject(this.outcome)
    return Promise.resolve(this.outcome as DurableCommandResultRef<K>)
  }
}

const workspaceMembers: WorkspaceMemberResolver = {
  resolveUser: () => Promise.reject(new Error('unexpected resolveUser')),
  resolveTelegramId: () => Promise.reject(new Error('unexpected telegram')),
  resolveMember: (id) =>
    Promise.resolve({ spaceId, memberId: id, userId: memberId }),
}

function command(): ReopenMonthApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member' as const, id: memberId },
    expectedRevision: 7n,
    payload: { planMonthId, reason: 'Исправить запись после сверки.' },
  }
}

function persistence(
  reopen: ReopenMonthPersistencePort['reopen'],
): ReopenMonthPersistencePort {
  return { reopen }
}

describe('L02 ReopenMonth application contract', () => {
  it('uses the member command and returns the new lifecycle revision', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const reopenMonth = new ReopenMonthCommand(
      executor,
      workspaceMembers,
      persistence((input) => {
        inputs.push(input)
        return Promise.resolve({ planMonthId, lifecycleRevision: 8n })
      }),
    )

    await expect(reopenMonth.execute(command())).resolves.toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: planMonthId,
      aggregateRevision: 8n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.reopen-month.v1',
      resultKind: 'planning.plan-month.v1',
    })
    expect(canonicalReopenMonthPayload(command().payload)).toEqual(
      command().payload,
    )
    expect(inputs).toEqual([
      {
        ...command().payload,
        spaceId,
        memberId,
        actorScope: `member:${memberId}`,
        commandType: 'planning.reopen-month.v1',
        commandId,
        expectedRevision: 7n,
        occurredAt: new Date('2026-08-22T10:00:00.000Z'),
      },
    ])
  })

  it.each([
    { ...command(), expectedRevision: 0n },
    { ...command(), trustedActor: { kind: 'system', id: 'planner-worker' } },
    { ...command(), payload: { planMonthId, reason: '   ' } },
    { ...command(), payload: { planMonthId, reason: 'x'.repeat(2_001) } },
    { ...command(), payload: { ...command().payload, extra: true } },
  ])('rejects invalid exact command %#', async (input) => {
    const executor = new ImmediateExecutor()
    const reopenMonth = new ReopenMonthCommand(
      executor,
      workspaceMembers,
      persistence(() => Promise.reject(new Error('unexpected persistence'))),
    )
    await expect(reopenMonth.execute(input as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
    expect(executor.calls).toBe(0)
  })

  it.each([
    [
      'replay',
      {
        kind: 'planning.plan-month.v1' as const,
        aggregateId: planMonthId,
        aggregateRevision: 8n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('preserves executor replay outcomes for %s', async (_label, outcome) => {
    const reopenMonth = new ReopenMonthCommand(
      new ShortCircuitExecutor(outcome),
      {
        ...workspaceMembers,
        resolveMember: () => Promise.reject(new Error('must not resolve')),
      },
      persistence(() => Promise.reject(new Error('must not persist'))),
    )
    const promise = reopenMonth.execute(command())
    if (outcome instanceof Error) {
      await expect(promise).rejects.toBe(outcome)
    } else {
      await expect(promise).resolves.toEqual(outcome)
    }
  })
})
