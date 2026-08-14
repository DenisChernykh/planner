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

const LOCAL_DATE = /^([0-9]{4})-(0[1-9]|1[0-2])-([0-9]{2})$/u

export type CloseWeekPayload = {
  readonly publicationId: string
  readonly periodStart: string
  readonly periodEnd: string
}

export type CloseWeekApplicationCommand = ApplicationCommand<CloseWeekPayload>

export type DueWeekGroup = CloseWeekPayload & {
  readonly commandId: string
}

export type CloseWeekPersistenceInput = CloseWeekPayload & {
  readonly commandId: string
  readonly occurredAt: Date
}

export type CloseWeekPersistenceResult = {
  readonly actionId: string
  readonly factsRevision: bigint
}

export interface DueLifecycleRepositoryPort {
  findDueWeekGroups(input: {
    readonly currentLocalDate: string
    readonly limit: number
  }): Promise<readonly DueWeekGroup[]>
  closeWeek(
    input: CloseWeekPersistenceInput,
  ): Promise<CloseWeekPersistenceResult>
}

export class CloseWeekNoWorkError extends Error {
  public constructor() {
    super('The weekly period has no unresolved planned tasks')
    this.name = 'CloseWeekNoWorkError'
  }
}

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
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return (
    ownKeys.length === keys.length &&
    ownKeys.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        descriptors[key]?.get === undefined &&
        descriptors[key]?.set === undefined,
    )
  )
}

function localDate(value: unknown): string {
  if (typeof value !== 'string') throw new CommandValidationError()
  const match = LOCAL_DATE.exec(value)
  if (match === null) throw new CommandValidationError()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || year > 9999 || day < 1 || day > days[month - 1]!) {
    throw new CommandValidationError()
  }
  return value
}

function snapshotPayload(value: unknown): CloseWeekPayload {
  if (!exactObject(value, ['publicationId', 'periodStart', 'periodEnd'])) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.publicationId)) {
    throw new CommandValidationError()
  }
  const periodStart = localDate(value.periodStart)
  const periodEnd = localDate(value.periodEnd)
  if (periodStart > periodEnd) throw new CommandValidationError()
  return Object.freeze({
    publicationId: value.publicationId,
    periodStart,
    periodEnd,
  })
}

export function canonicalCloseWeekPayload(
  value: CloseWeekPayload,
): CanonicalJsonObject {
  return snapshotPayload(value)
}

export function snapshotCloseWeekCommand(
  value: unknown,
): CloseWeekApplicationCommand {
  if (!exactObject(value, ['commandId', 'trustedActor', 'payload'])) {
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
  return Object.freeze({
    commandId: value.commandId,
    trustedActor: Object.freeze({
      kind: 'system' as const,
      id: 'planner-worker' as const,
    }),
    payload: snapshotPayload(value.payload),
  })
}

const definition: CommandDefinition<
  CloseWeekPayload,
  'planning.week-close.v1'
> = {
  commandType: 'planning.close-week.v1',
  resultKind: 'planning.week-close.v1',
  toCanonicalPayload: canonicalCloseWeekPayload,
}

export class CloseWeekCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly lifecycle: DueLifecycleRepositoryPort,
  ) {}

  public async execute(
    input: CloseWeekApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.week-close.v1'>> {
    const command = snapshotCloseWeekCommand(input)
    try {
      return await this.executor.execute(
        definition,
        command,
        async (context) => {
          const result = await this.lifecycle.closeWeek({
            ...command.payload,
            commandId: command.commandId,
            occurredAt: context.occurredAt,
          })
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: result.actionId,
            aggregateRevision: result.factsRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof CommandFingerprintConflictError ||
        error instanceof CloseWeekNoWorkError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
