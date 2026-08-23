import type { WorkspaceMemberResolver } from '@/modules/workspace'
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
import { actorScope } from '@/shared/application/durable-command.executor'

import { isCanonicalPlanningUuid } from '../domain/planning-values'
import type { CloseMonthReportPort } from './close-month.command'
import { resolvePlanningMember } from './planning-authorization'
import {
  PlanMonthNotFoundError,
  PlanMonthRecloseConflictError,
  PlanMonthRevisionConflictError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

export type RecloseMonthPayload = {
  readonly planMonthId: string
}

export type RecloseMonthApplicationCommand = Omit<
  ApplicationCommand<RecloseMonthPayload>,
  'expectedRevision'
> & { readonly expectedRevision: bigint }

export type RecloseMonthPersistenceInput = RecloseMonthPayload & {
  readonly spaceId: string
  readonly memberId: string
  readonly actorScope: string
  readonly commandType: string
  readonly commandId: string
  readonly expectedRevision: bigint
  readonly occurredAt: Date
}

export type RecloseMonthPersistenceResult = {
  readonly reportRevisionId: string
  readonly reportRevision: bigint
  readonly lifecycleRevision: bigint
}

export interface RecloseMonthPersistencePort {
  reclose(
    input: RecloseMonthPersistenceInput,
    report: CloseMonthReportPort,
  ): Promise<RecloseMonthPersistenceResult>
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

function snapshotPayload(value: unknown): RecloseMonthPayload {
  if (!exactObject(value, ['planMonthId'])) throw new CommandValidationError()
  if (!isCanonicalPlanningUuid(value.planMonthId)) {
    throw new CommandValidationError()
  }
  return Object.freeze({ planMonthId: value.planMonthId })
}

export function canonicalRecloseMonthPayload(
  value: RecloseMonthPayload,
): CanonicalJsonObject {
  return snapshotPayload(value)
}

export function snapshotRecloseMonthCommand(
  value: unknown,
): RecloseMonthApplicationCommand {
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
    value.trustedActor.kind !== 'member' ||
    !isCanonicalPlanningUuid(value.trustedActor.id)
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
      kind: 'member' as const,
      id: value.trustedActor.id,
    }),
    expectedRevision: value.expectedRevision,
    payload: snapshotPayload(value.payload),
  })
}

const definition: CommandDefinition<
  RecloseMonthPayload,
  'planning.report-revision.v1'
> = {
  commandType: 'planning.reclose-month.v1',
  resultKind: 'planning.report-revision.v1',
  toCanonicalPayload: canonicalRecloseMonthPayload,
}

function publicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanMonthNotFoundError ||
    error instanceof PlanMonthRevisionConflictError ||
    error instanceof PlanMonthRecloseConflictError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class RecloseMonthCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly months: RecloseMonthPersistencePort,
    private readonly report: CloseMonthReportPort,
  ) {}

  public async execute(
    input: RecloseMonthApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.report-revision.v1'>> {
    try {
      const command = snapshotRecloseMonthCommand(input)
      return await this.executor.execute(
        definition,
        command,
        async ({ occurredAt }) => {
          const member = await resolvePlanningMember(
            command.trustedActor,
            this.workspaceMembers,
          )
          const result = await this.months.reclose(
            {
              ...command.payload,
              spaceId: member.spaceId,
              memberId: member.memberId,
              actorScope: actorScope(command.trustedActor),
              commandType: definition.commandType,
              commandId: command.commandId,
              expectedRevision: command.expectedRevision,
              occurredAt,
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
      if (publicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
