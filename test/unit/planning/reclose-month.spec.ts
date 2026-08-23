import type { CloseMonthReportPort } from '@/modules/planning/application/close-month.command'
import {
  RecloseMonthCommand,
  canonicalRecloseMonthPayload,
  type RecloseMonthApplicationCommand,
  type RecloseMonthPersistencePort,
} from '@/modules/planning/application/reclose-month.command'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import type {
  ApplicationCommand,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'

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
    return effect({ occurredAt: new Date('2026-08-23T10:00:00.000Z') })
  }
}

class ShortCircuitExecutor implements CommandExecutor {
  public constructor(
    private readonly outcome:
      DurableCommandResultRef<'planning.report-revision.v1'> | Error,
  ) {}

  public execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>> {
    void definition
    void command
    void effect
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

const report = {} as CloseMonthReportPort

function command(): RecloseMonthApplicationCommand {
  return {
    commandId,
    trustedActor: { kind: 'member', id: memberId },
    expectedRevision: 9n,
    payload: { planMonthId },
  }
}

describe('L03 RecloseMonth application contract', () => {
  it('uses the member command and returns the appended report revision', async () => {
    const executor = new ImmediateExecutor()
    const inputs: unknown[] = []
    const months: RecloseMonthPersistencePort = {
      reclose: (input, receivedReport) => {
        inputs.push(input)
        expect(receivedReport).toBe(report)
        return Promise.resolve({
          reportRevisionId: '55555555-5555-4555-8555-555555555555',
          reportRevision: 2n,
          lifecycleRevision: 10n,
        })
      },
    }
    const reclose = new RecloseMonthCommand(
      executor,
      workspaceMembers,
      months,
      report,
    )

    await expect(reclose.execute(command())).resolves.toEqual({
      kind: 'planning.report-revision.v1',
      aggregateId: '55555555-5555-4555-8555-555555555555',
      aggregateRevision: 2n,
    })
    expect(executor.definition).toMatchObject({
      commandType: 'planning.reclose-month.v1',
      resultKind: 'planning.report-revision.v1',
    })
    expect(canonicalRecloseMonthPayload(command().payload)).toEqual(
      command().payload,
    )
    expect(inputs).toEqual([
      {
        planMonthId,
        spaceId,
        memberId,
        actorScope: `member:${memberId}`,
        commandType: 'planning.reclose-month.v1',
        commandId,
        expectedRevision: 9n,
        occurredAt: new Date('2026-08-23T10:00:00.000Z'),
      },
    ])
  })

  it.each([
    { ...command(), expectedRevision: 0n },
    { ...command(), trustedActor: { kind: 'system', id: 'planner-worker' } },
    { ...command(), payload: { planMonthId, extra: true } },
  ])('rejects invalid exact command %#', async (input) => {
    const executor = new ImmediateExecutor()
    const reclose = new RecloseMonthCommand(
      executor,
      workspaceMembers,
      { reclose: () => Promise.reject(new Error('unexpected persistence')) },
      report,
    )
    await expect(reclose.execute(input as never)).rejects.toBeInstanceOf(
      CommandValidationError,
    )
    expect(executor.calls).toBe(0)
  })

  it.each([
    [
      'replay',
      {
        kind: 'planning.report-revision.v1' as const,
        aggregateId: '55555555-5555-4555-8555-555555555555',
        aggregateRevision: 2n,
      },
    ],
    ['fingerprint conflict', new CommandFingerprintConflictError()],
  ])('preserves executor outcomes for %s', async (_label, outcome) => {
    const reclose = new RecloseMonthCommand(
      new ShortCircuitExecutor(outcome),
      {
        ...workspaceMembers,
        resolveMember: () => Promise.reject(new Error('must not resolve')),
      },
      { reclose: () => Promise.reject(new Error('must not persist')) },
      report,
    )
    const promise = reclose.execute(command())
    if (outcome instanceof Error) {
      await expect(promise).rejects.toBe(outcome)
    } else {
      await expect(promise).resolves.toEqual(outcome)
    }
  })
})
