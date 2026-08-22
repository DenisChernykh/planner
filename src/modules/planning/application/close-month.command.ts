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

export type CloseMonthPayload = {
  readonly planMonthId: string
}

export type CloseMonthApplicationCommand = ApplicationCommand<CloseMonthPayload>

export type CloseMonthPersistenceInput = CloseMonthPayload & {
  readonly commandId: string
  readonly occurredAt: Date
}

export type CloseMonthReportInput = {
  readonly spaceId: string
  readonly planMonthId: string
  readonly publicationId: string
  readonly asOfLocalDate: string
}

export type CloseMonthReportPersistenceInput = CloseMonthReportInput & {
  readonly publicationSnapshotHash: string
  readonly occurredAt: Date
}

export type CloseMonthReport = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly publicationRevision: bigint
  readonly factsRevision: bigint
  readonly formulaVersion: string
  readonly payload: unknown
}

export interface CloseMonthReportPort {
  build(input: CloseMonthReportInput): Promise<CloseMonthReport>
  persist(input: CloseMonthReportPersistenceInput): Promise<{
    readonly reportRevisionId: string
    readonly revision: bigint
    readonly factsRevision: bigint
  }>
}

export type CloseMonthPersistenceResult = {
  readonly reportRevisionId: string
  readonly reportRevision: bigint
  readonly lifecycleRevision: bigint
}

export interface CloseMonthLifecycleRepositoryPort {
  readonly findDueMonthGrace?: (input: {
    readonly currentLocalDate: string
    readonly limit: number
  }) => Promise<
    readonly {
      readonly commandId: string
      readonly planMonthId: string
      readonly expectedRevision: string
    }[]
  >
  readonly startMonthGrace?: (
    input: StartMonthGracePersistenceInput,
  ) => Promise<StartMonthGracePersistenceResult>
  readonly transitionDueGrace?: (input: {
    readonly currentLocalDate: string
    readonly limit: number
    readonly occurredAt: Date
  }) => Promise<void>
  findDueMonthClosures(input: {
    readonly currentLocalDate: string
    readonly limit: number
  }): Promise<
    readonly { readonly commandId: string; readonly planMonthId: string }[]
  >
  closeMonth(
    input: CloseMonthPersistenceInput,
    report: CloseMonthReportPort,
  ): Promise<CloseMonthPersistenceResult>
}

export type StartMonthGracePersistenceInput = {
  readonly planMonthId: string
  readonly expectedRevision: bigint
  readonly commandId: string
  readonly occurredAt: Date
}

export type StartMonthGracePersistenceResult = {
  readonly lifecycleRevision: bigint
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

function snapshotPayload(value: unknown): CloseMonthPayload {
  if (!exactObject(value, ['planMonthId'])) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.planMonthId)) {
    throw new CommandValidationError()
  }
  return Object.freeze({ planMonthId: value.planMonthId })
}

export function canonicalCloseMonthPayload(
  value: CloseMonthPayload,
): CanonicalJsonObject {
  return snapshotPayload(value)
}

export function snapshotCloseMonthCommand(
  value: unknown,
): CloseMonthApplicationCommand {
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

export class CloseMonthNoWorkError extends Error {
  public constructor() {
    super('The monthly plan is not due for close')
    this.name = 'CloseMonthNoWorkError'
  }
}

const definition: CommandDefinition<
  CloseMonthPayload,
  'planning.report-revision.v1'
> = {
  commandType: 'planning.close-month.v1',
  resultKind: 'planning.report-revision.v1',
  toCanonicalPayload: canonicalCloseMonthPayload,
}

export class CloseMonthCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly lifecycle: CloseMonthLifecycleRepositoryPort,
    private readonly report: CloseMonthReportPort = {
      build: () =>
        Promise.reject(
          new Error('CloseMonth report participant is not configured'),
        ),
      persist: () =>
        Promise.reject(
          new Error('CloseMonth report participant is not configured'),
        ),
    },
  ) {}

  public async execute(
    input: CloseMonthApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.report-revision.v1'>> {
    const command = snapshotCloseMonthCommand(input)
    try {
      return await this.executor.execute(
        definition,
        command,
        async (context) => {
          const result = await this.lifecycle.closeMonth(
            {
              ...command.payload,
              commandId: command.commandId,
              occurredAt: context.occurredAt,
            },
            this.report,
          )
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: result.reportRevisionId,
            aggregateRevision: result.reportRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof CommandFingerprintConflictError ||
        error instanceof CloseMonthNoWorkError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
