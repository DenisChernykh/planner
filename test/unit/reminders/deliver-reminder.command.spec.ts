import { WorkspaceTelegramRecipientNotFoundError } from '@/modules/workspace/application/workspace-errors'
import { DeliverReminderCommand } from '@/modules/reminders/application/deliver-reminder.command'
import { ReminderIntentClaimStaleError } from '@/modules/reminders/application/reminder-errors'
import type {
  ReminderAttemptPersistencePort,
  ReminderOccurrenceClaim,
  ReminderRenderedContentV1,
  ReminderDeliveryTransportPort,
} from '@/modules/reminders/application/reminder.types'

const now = new Date('2026-03-30T05:00:00.000Z')
const claim: ReminderOccurrenceClaim = {
  occurrenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  recipientMemberId: '44444444-4444-4444-8444-444444444444',
  localDate: '2026-03-30',
  slotKind: 'morning',
  dueAt: new Date('2026-03-30T04:00:00.000Z'),
  expiresAt: new Date('2026-03-30T09:00:00.000Z'),
  fencingToken: 3n,
}
const content: ReminderRenderedContentV1 = {
  schemaVersion: 'reminders.rendered-content.v1',
  localDate: '2026-03-30',
  slotKind: 'morning',
  focus: 'Фокус',
  items: [
    {
      kind: 'fixed',
      goalId: '99999999-9999-4999-8999-999999999999',
      componentId: null,
      title: 'Вода',
      state: 'pending',
      remaining: null,
      expectedProgress: null,
      actualProgress: null,
    },
  ],
  actions: [],
}

function makeAttempt(
  inspect: Awaited<
    ReturnType<ReminderAttemptPersistencePort['inspectPrepared']>
  >,
  begin: Awaited<
    ReturnType<ReminderAttemptPersistencePort['beginDispatch']>
  > = { kind: 'dispatch' },
): jest.Mocked<ReminderAttemptPersistencePort> {
  return {
    inspectPrepared: jest.fn().mockResolvedValue(inspect),
    beginDispatch: jest.fn().mockResolvedValue(begin),
    completePrepared: jest.fn().mockResolvedValue(true),
    completeDispatch: jest.fn().mockResolvedValue(true),
  }
}

function makeCommand(
  attempts: ReminderAttemptPersistencePort,
  recipient: bigint | Error = 123456789n,
  transportOutcome: Awaited<
    ReturnType<ReminderDeliveryTransportPort['send']>
  > = {
    kind: 'accepted',
  },
): {
  readonly command: DeliverReminderCommand
  readonly recipients: {
    readonly resolveTelegramRecipient: jest.Mock
  }
  readonly transport: jest.Mocked<ReminderDeliveryTransportPort>
} {
  const transport: jest.Mocked<ReminderDeliveryTransportPort> = {
    send: jest.fn().mockResolvedValue(transportOutcome),
  }
  const recipients = {
    resolveTelegramRecipient: jest.fn().mockImplementation(() => {
      if (recipient instanceof Error) return Promise.reject(recipient)
      return Promise.resolve(recipient)
    }),
  }
  const command = new DeliverReminderCommand(
    attempts,
    recipients,
    transport,
    { run: async <T>(operation: () => Promise<T>) => operation() },
    { now: () => now, today: () => '2026-03-30' },
  )
  return { command, recipients, transport }
}

const input = {
  claim,
  leaseOwner: 'worker-n03',
  intentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  attemptId: 'f1111111-1111-4111-8111-111111111111',
  signal: new AbortController().signal,
}

describe('DeliverReminderCommand', () => {
  it('resolves the allowlisted recipient, sends once, and persists accepted', async () => {
    const attempts = makeAttempt({
      kind: 'prepared',
      intentId: input.intentId,
      recipientMemberId: claim.recipientMemberId,
      content,
    })
    const { command, recipients, transport } = makeCommand(attempts)

    await expect(
      command.execute({
        ...input,
        claim: {
          ...claim,
          recipientMemberId: '55555555-5555-4555-8555-555555555555',
        },
      }),
    ).resolves.toEqual({
      attemptId: input.attemptId,
      outcome: { kind: 'accepted' },
    })
    expect(recipients.resolveTelegramRecipient.mock.calls).toEqual([
      [claim.recipientMemberId],
    ])
    expect(transport.send.mock.calls).toHaveLength(1)
    expect(attempts.completeDispatch.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ outcome: { kind: 'accepted' } }),
    )
  })

  it('records resolver absence as terminal without retrying', async () => {
    const attempts = makeAttempt({
      kind: 'prepared',
      intentId: input.intentId,
      recipientMemberId: claim.recipientMemberId,
      content,
    })
    const { command, transport } = makeCommand(
      attempts,
      new WorkspaceTelegramRecipientNotFoundError(),
    )

    await expect(command.execute(input)).resolves.toEqual({
      attemptId: input.attemptId,
      outcome: { kind: 'terminal', reason: 'provider_rejected' },
    })
    expect(transport.send.mock.calls).toHaveLength(0)
  })

  it('records transient resolver failures as retryable before dispatching', async () => {
    const attempts = makeAttempt({
      kind: 'prepared',
      intentId: input.intentId,
      recipientMemberId: claim.recipientMemberId,
      content,
    })
    const { command, transport } = makeCommand(
      attempts,
      new Error('database unavailable'),
    )

    await expect(command.execute(input)).resolves.toEqual({
      attemptId: input.attemptId,
      outcome: {
        kind: 'retryable',
        reason: 'provider_error',
        retryAfterSeconds: null,
      },
    })
    expect(attempts.completePrepared.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        outcome: {
          kind: 'retryable',
          reason: 'provider_error',
          retryAfterSeconds: null,
        },
      }),
    )
    expect(transport.send.mock.calls).toHaveLength(0)
  })

  it('never sends after a terminal replay or stale claim', async () => {
    const terminal = makeAttempt({
      kind: 'terminal',
      outcome: { kind: 'ambiguous', reason: 'timeout' },
    })
    const replay = makeCommand(terminal)
    await expect(replay.command.execute(input)).resolves.toEqual({
      attemptId: input.attemptId,
      outcome: { kind: 'ambiguous', reason: 'timeout' },
    })
    expect(replay.transport.send.mock.calls).toHaveLength(0)

    const recovering = makeAttempt(
      { kind: 'dispatching' },
      {
        kind: 'terminal',
        outcome: { kind: 'ambiguous', reason: 'transport_error' },
      },
    )
    const recoveredCommand = makeCommand(recovering)
    await expect(recoveredCommand.command.execute(input)).resolves.toEqual({
      attemptId: input.attemptId,
      outcome: { kind: 'ambiguous', reason: 'transport_error' },
    })
    expect(
      recoveredCommand.recipients.resolveTelegramRecipient.mock.calls,
    ).toHaveLength(0)
    expect(recoveredCommand.transport.send.mock.calls).toHaveLength(0)

    const stale = makeAttempt({ kind: 'stale' })
    const staleCommand = makeCommand(stale)
    await expect(staleCommand.command.execute(input)).rejects.toBeInstanceOf(
      ReminderIntentClaimStaleError,
    )
    expect(staleCommand.transport.send.mock.calls).toHaveLength(0)
  })
})
