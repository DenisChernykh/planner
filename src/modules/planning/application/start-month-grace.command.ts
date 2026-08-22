import type {
  ApplicationCommand,
  CanonicalJsonObject,
  CommandDefinition,
  CommandExecutor,
  DurableCommandResultRef,
} from '@/shared/application/application-command'
import {
  CommandFingerprintConflictError,
  CommandValidationError,
} from '@/shared/application/application-command'

import { isCanonicalPlanningUuid } from '../domain/planning-values'
import { PlanningDependencyUnavailableError } from './planning-errors'
import type {
  CloseMonthLifecycleRepositoryPort,
  StartMonthGracePersistenceInput,
} from './close-month.command'

export type StartMonthGracePayload = {
  readonly planMonthId: string
}

export type StartMonthGraceApplicationCommand =
  ApplicationCommand<StartMonthGracePayload>

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
  )
}

function snapshotPayload(value: unknown): StartMonthGracePayload {
  if (!exactObject(value, ['planMonthId'])) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.planMonthId)) {
    throw new CommandValidationError()
  }
  return Object.freeze({ planMonthId: value.planMonthId })
}

export function canonicalStartMonthGracePayload(
  value: StartMonthGracePayload,
): CanonicalJsonObject {
  return snapshotPayload(value)
}

export function snapshotStartMonthGraceCommand(
  value: unknown,
): StartMonthGraceApplicationCommand {
  if (
    !exactObject(value, [
      'commandId',
      'trustedActor',
      'expectedRevision',
      'payload',
    ])
  ) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.commandId)) {
    throw new CommandValidationError()
  }
  if (
    !exactObject(value.trustedActor, ['kind', 'id']) ||
    value.trustedActor.kind !== 'system' ||
    value.trustedActor.id !== 'planner-worker'
  ) {
    throw new CommandValidationError()
  }
  if (
    typeof value.expectedRevision !== 'bigint' ||
    value.expectedRevision <= 0n
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    commandId: value.commandId,
    trustedActor: Object.freeze({
      kind: 'system' as const,
      id: 'planner-worker' as const,
    }),
    expectedRevision: value.expectedRevision,
    payload: snapshotPayload(value.payload),
  })
}

export class StartMonthGraceNoWorkError extends Error {
  public constructor() {
    super('The monthly plan is not due to start grace')
    this.name = 'StartMonthGraceNoWorkError'
  }
}

const definition: CommandDefinition<
  StartMonthGracePayload,
  'planning.plan-month.v1'
> = {
  commandType: 'planning.start-month-grace.v1',
  resultKind: 'planning.plan-month.v1',
  toCanonicalPayload: canonicalStartMonthGracePayload,
}

export class StartMonthGraceCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly lifecycle: CloseMonthLifecycleRepositoryPort,
  ) {}

  public async execute(
    input: StartMonthGraceApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-month.v1'>> {
    const command = snapshotStartMonthGraceCommand(input)
    try {
      return await this.executor.execute(
        definition,
        command,
        async (context) => {
          if (this.lifecycle.startMonthGrace === undefined) {
            throw new StartMonthGraceNoWorkError()
          }
          const payload: StartMonthGracePersistenceInput = {
            planMonthId: command.payload.planMonthId,
            expectedRevision: command.expectedRevision!,
            commandId: command.commandId,
            occurredAt: context.occurredAt,
          }
          const result = await this.lifecycle.startMonthGrace(payload)
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: command.payload.planMonthId,
            aggregateRevision: result.lifecycleRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof CommandFingerprintConflictError ||
        error instanceof StartMonthGraceNoWorkError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
