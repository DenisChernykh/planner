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
import { resolvePlanningMember } from './planning-authorization'
import {
  PlanMonthNotFoundError,
  PlanMonthRevisionConflictError,
  PlanMonthReopenConflictError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'
import type { WorkspaceMemberResolver } from '@/modules/workspace'

export type ReopenMonthPayload = {
  readonly planMonthId: string
  readonly reason: string
}

export type ReopenMonthApplicationCommand = Omit<
  ApplicationCommand<ReopenMonthPayload>,
  'expectedRevision'
> & { readonly expectedRevision: bigint }

export type ReopenMonthPersistenceInput = ReopenMonthPayload & {
  readonly spaceId: string
  readonly memberId: string
  readonly actorScope: string
  readonly commandType: string
  readonly commandId: string
  readonly expectedRevision: bigint
  readonly occurredAt: Date
}

export type ReopenMonthPersistenceResult = {
  readonly planMonthId: string
  readonly lifecycleRevision: bigint
}

export interface ReopenMonthPersistencePort {
  reopen(
    input: ReopenMonthPersistenceInput,
  ): Promise<ReopenMonthPersistenceResult>
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

function snapshotPayload(value: unknown): ReopenMonthPayload {
  if (!exactObject(value, ['planMonthId', 'reason'])) {
    throw new CommandValidationError()
  }
  if (!isCanonicalPlanningUuid(value.planMonthId)) {
    throw new CommandValidationError()
  }
  if (
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0 ||
    value.reason.length > 2_000
  ) {
    throw new CommandValidationError()
  }
  return Object.freeze({
    planMonthId: value.planMonthId,
    reason: value.reason,
  })
}

export function canonicalReopenMonthPayload(
  value: ReopenMonthPayload,
): CanonicalJsonObject {
  return snapshotPayload(value)
}

export function snapshotReopenMonthCommand(
  value: unknown,
): ReopenMonthApplicationCommand {
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
  ReopenMonthPayload,
  'planning.plan-month.v1'
> = {
  commandType: 'planning.reopen-month.v1',
  resultKind: 'planning.plan-month.v1',
  toCanonicalPayload: canonicalReopenMonthPayload,
}

function publicError(error: unknown): boolean {
  return (
    error instanceof CommandValidationError ||
    error instanceof CommandFingerprintConflictError ||
    error instanceof PlanningAuthorizationDeniedError ||
    error instanceof PlanMonthNotFoundError ||
    error instanceof PlanMonthRevisionConflictError ||
    error instanceof PlanMonthReopenConflictError ||
    error instanceof PlanningDependencyUnavailableError
  )
}

export class ReopenMonthCommand {
  public constructor(
    private readonly executor: CommandExecutor,
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly months: ReopenMonthPersistencePort,
  ) {}

  public async execute(
    input: ReopenMonthApplicationCommand,
  ): Promise<DurableCommandResultRef<'planning.plan-month.v1'>> {
    try {
      const command = snapshotReopenMonthCommand(input)
      return await this.executor.execute(
        definition,
        command,
        async ({ occurredAt }) => {
          const member = await resolvePlanningMember(
            command.trustedActor,
            this.workspaceMembers,
          )
          const result = await this.months.reopen({
            ...command.payload,
            spaceId: member.spaceId,
            memberId: member.memberId,
            actorScope: actorScope(command.trustedActor),
            commandType: definition.commandType,
            commandId: command.commandId,
            expectedRevision: command.expectedRevision,
            occurredAt,
          })
          return Object.freeze({
            kind: definition.resultKind,
            aggregateId: result.planMonthId,
            aggregateRevision: result.lifecycleRevision,
          })
        },
      )
    } catch (error: unknown) {
      if (publicError(error)) throw error
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
