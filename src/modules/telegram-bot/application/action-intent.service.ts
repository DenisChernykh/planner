import { createHash, randomUUID } from 'node:crypto'

import type {
  TrackingDayGoalV1,
  TrackingFactReadV1,
  TrackingFixedExpectationV1,
  TrackingGoalReadV1,
  TrackingTodayReadModelV1,
  TrackingApplication,
} from '@/modules/tracking'
import type { MemberContext } from '@/modules/workspace'
import {
  DatabaseTransactionRollbackOnlyError,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  basicFactErrorOutcome,
  executeBasicFactIntent,
  fingerprintForIntent,
  intentValue,
} from './basic-fact-command.mapper'
import {
  executeScalarFactIntent,
  scalarFingerprintForIntent,
  scalarIntentValue,
} from './scalar-fact-command.mapper'
import type {
  StoredTelegramActionIntent,
  TelegramActionButton,
  TelegramActionIntentKind,
  TelegramActionIntentOffer,
  TelegramActionIntentPersistencePort,
  TelegramIntentOutcome,
} from './action-intent.types'

const intentTtlMs = 15 * 60 * 1_000
const canonicalDecimal = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u
const canonicalTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u
const canonicalInteger = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u

function goalFacts(day: TrackingDayGoalV1): readonly TrackingFactReadV1[] {
  return [
    ...day.fixedExpectations.flatMap((expectation) => expectation.facts),
    ...day.flexiblePeriods.flatMap((period) => period.facts),
  ]
}

function semanticKey(input: {
  readonly member: MemberContext
  readonly publicationId: string
  readonly goalId: string
  readonly localDate: string
  readonly factsRevision: bigint
  readonly kind: TelegramActionIntentKind
  readonly checkpointId: string | null
  readonly booleanResult: 'done' | 'not_done' | null
}): string {
  const preimage = {
    booleanResult: input.booleanResult,
    factsRevision: input.factsRevision.toString(10),
    goalId: input.goalId,
    kind: input.kind,
    localDate: input.localDate,
    memberId: input.member.memberId,
    publicationId: input.publicationId,
    spaceId: input.member.spaceId,
  }
  return createHash('sha256')
    .update(
      JSON.stringify(
        input.kind === 'boolean' || input.kind === 'quantity'
          ? preimage
          : { ...preimage, checkpointId: input.checkpointId },
      ),
      'utf8',
    )
    .digest('hex')
}

function fingerprint(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  return intent.intentKind === 'boolean' || intent.intentKind === 'quantity'
    ? fingerprintForIntent(member, intent)
    : scalarFingerprintForIntent(member, intent)
}

function preview(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const value = intentValue(intent) ?? scalarIntentValue(intent)
  return value === null
    ? { kind: 'stale' }
    : {
        kind: 'preview',
        actionIntentId: intent.actionIntentId,
        title: intent.title,
        localDate: intent.localDate,
        value,
        unit: intent.unit,
        aggregation: intent.aggregation,
      }
}

function offerInput(
  member: MemberContext,
  model: Extract<TrackingTodayReadModelV1, { readonly state: 'published' }>,
  goal: TrackingGoalReadV1,
  localDate: string,
  kind: TelegramActionIntentKind,
  checkpointId: string | null,
  booleanResult: 'done' | 'not_done' | null,
  now: Date,
): TelegramActionIntentOffer {
  const actionIntentId = randomUUID()
  const base = {
    actionIntentId,
    semanticKey: semanticKey({
      member,
      publicationId: model.publicationId,
      goalId: goal.planGoalSnapshotId,
      localDate,
      factsRevision: model.factsRevision,
      kind,
      checkpointId,
      booleanResult,
    }),
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: model.publicationId,
    planGoalSnapshotId: goal.planGoalSnapshotId,
    localDate,
    sourceFactsRevision: model.factsRevision,
    intentKind: kind,
    checkpointId,
    booleanResult,
    expiresAt: new Date(now.getTime() + intentTtlMs),
  } as const
  if (booleanResult === null) {
    return { ...base, state: 'offered', commandFingerprint: null }
  }
  const candidate: StoredTelegramActionIntent = {
    ...base,
    commandId: actionIntentId,
    currentFactsRevision: model.factsRevision,
    activePublicationId: model.publicationId,
    monthStatus: model.monthStatus,
    state: 'ready',
    quantityValue: null,
    actualTimeValue: null,
    ratingValue: null,
    commandFingerprint: null,
    title: goal.title,
    unit: null,
    precision: null,
    aggregation: null,
    result: null,
  }
  return {
    ...base,
    state: 'ready',
    commandFingerprint: fingerprint(member, candidate),
  }
}

function inputKind(
  intent: StoredTelegramActionIntent,
): 'quantity' | 'actual_time' | 'rating' | null {
  if (intent.intentKind === 'quantity') return 'quantity'
  if (
    intent.intentKind === 'actual_time' ||
    intent.intentKind === 'checkpoint_actual_time'
  ) {
    return 'actual_time'
  }
  if (
    intent.intentKind === 'rating' ||
    intent.intentKind === 'checkpoint_rating'
  ) {
    return 'rating'
  }
  return null
}

function awaiting(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const kind = inputKind(intent)
  if (kind === 'quantity') {
    return { kind: 'awaiting_quantity', title: intent.title }
  }
  return kind === null
    ? { kind: 'stale' }
    : { kind: 'awaiting_scalar', title: intent.title, inputKind: kind }
}

function hasRecord(expectation: TrackingFixedExpectationV1): boolean {
  return expectation.facts.length > 0
}

function finiteOutcome(error: unknown): TelegramIntentOutcome | null {
  const direct = basicFactErrorOutcome(error)
  if (direct !== null) return direct
  return error instanceof DatabaseTransactionRollbackOnlyError
    ? basicFactErrorOutcome(error.cause)
    : null
}

export class TelegramActionIntentService {
  public constructor(
    private readonly intents: TelegramActionIntentPersistencePort,
    private readonly tracking: TrackingApplication,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async offerTodayActions(
    member: MemberContext,
    model: TrackingTodayReadModelV1,
  ): Promise<readonly TelegramActionButton[]> {
    if (
      model.state !== 'published' ||
      model.phase === 'future' ||
      model.monthStatus === 'closed'
    ) {
      return Object.freeze([])
    }
    const days = new Map(
      model.day.goals.map((value) => [value.planGoalSnapshotId, value]),
    )
    const now = this.clock.now()
    const buttons: TelegramActionButton[] = []
    for (const goal of model.goals) {
      const day = days.get(goal.planGoalSnapshotId)
      if (
        day === undefined ||
        !day.writable ||
        goal.viewerAccess === 'partner_read_only'
      ) {
        continue
      }
      const measurement = goal.config.measurement
      const facts = goalFacts(day)
      if (goal.config.checkpoints === null) {
        if (measurement.kind === 'boolean') {
          if (facts.some((fact) => fact.factKind === 'boolean')) continue
          for (const result of ['done', 'not_done'] as const) {
            const intent = await this.intents.offer(
              offerInput(
                member,
                model,
                goal,
                model.day.localDate,
                'boolean',
                null,
                result,
                now,
              ),
              now,
            )
            buttons.push({
              text: `${result === 'done' ? '✓' : '✕'} ${goal.title}`,
              actionIntentId: intent.actionIntentId,
            })
          }
        } else if (measurement.kind === 'quantity') {
          if (
            measurement.aggregation === 'latest' &&
            facts.some((fact) => fact.factKind === 'quantity_latest')
          ) {
            continue
          }
          const intent = await this.intents.offer(
            offerInput(
              member,
              model,
              goal,
              model.day.localDate,
              'quantity',
              null,
              null,
              now,
            ),
            now,
          )
          buttons.push({
            text: `Ввести ${goal.title}`,
            actionIntentId: intent.actionIntentId,
          })
        } else if (
          (measurement.kind === 'actual_time' ||
            measurement.kind === 'rating') &&
          day.fixedExpectations.some(
            (value) => value.componentKind === 'goal' && !hasRecord(value),
          )
        ) {
          const intent = await this.intents.offer(
            offerInput(
              member,
              model,
              goal,
              model.day.localDate,
              measurement.kind,
              null,
              null,
              now,
            ),
            now,
          )
          buttons.push({
            text: `Ввести ${goal.title}`,
            actionIntentId: intent.actionIntentId,
          })
        }
        continue
      }

      const checkpoints = new Map(
        goal.config.checkpoints.items.map((value) => [
          value.checkpointId,
          value,
        ]),
      )
      for (const expectation of day.fixedExpectations) {
        if (
          expectation.componentKind !== 'checkpoint' ||
          expectation.componentId === null ||
          hasRecord(expectation)
        ) {
          continue
        }
        const checkpoint = checkpoints.get(expectation.componentId)
        if (checkpoint === undefined) continue
        const satisfaction = checkpoint.satisfaction
        const kind = `checkpoint_${satisfaction.kind}` as const
        if (
          kind !== 'checkpoint_boolean' &&
          kind !== 'checkpoint_actual_time' &&
          kind !== 'checkpoint_rating'
        ) {
          continue
        }
        const results =
          kind === 'checkpoint_boolean'
            ? (['done', 'not_done'] as const)
            : ([null] as const)
        for (const result of results) {
          const intent = await this.intents.offer(
            offerInput(
              member,
              model,
              goal,
              model.day.localDate,
              kind,
              expectation.componentId,
              result,
              now,
            ),
            now,
          )
          buttons.push({
            text:
              result === null
                ? `Ввести ${goal.title} · ${checkpoint.name}`
                : `${result === 'done' ? '✓' : '✕'} ${goal.title} · ${checkpoint.name}`,
            actionIntentId: intent.actionIntentId,
          })
        }
      }
    }
    return Object.freeze(buttons)
  }

  public select(
    member: MemberContext,
    actionIntentId: string,
  ): Promise<TelegramIntentOutcome> {
    return this.safe(async () =>
      this.transaction.run(async () => {
        const now = this.clock.now()
        const current = await this.intents.lockForMember({
          actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
        })
        if (current === null) return { kind: 'not_found' }
        if (current.state === 'completed' && current.result !== null) {
          return {
            kind: 'completed',
            title: current.title,
            result: current.result,
          }
        }
        if (current.expiresAt.getTime() <= now.getTime()) {
          await this.intents.markExpired(actionIntentId, now)
          return { kind: 'expired' }
        }
        if (
          current.intentKind === 'boolean' ||
          current.intentKind === 'checkpoint_boolean'
        ) {
          return preview(current)
        }
        if (current.state === 'awaiting_value') return awaiting(current)
        if (current.state !== 'offered' && current.state !== 'ready') {
          return { kind: 'stale' }
        }
        const selected = await this.intents.selectValue({
          actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
          now,
        })
        return selected === null ? { kind: 'not_found' } : awaiting(selected)
      }),
    )
  }

  public acceptValue(
    member: MemberContext,
    rawValue: string,
  ): Promise<TelegramIntentOutcome | null> {
    return this.safeNullable(async () =>
      this.transaction.run(async () => {
        const now = this.clock.now()
        const intent = await this.intents.findAwaitingValue({
          spaceId: member.spaceId,
          memberId: member.memberId,
          now,
        })
        if (intent === null) return null
        const value = rawValue.trim()
        const kind = inputKind(intent)
        let quantityValue: string | null = null
        let actualTimeValue: string | null = null
        let ratingValue: bigint | null = null
        if (kind === 'quantity') {
          const match = canonicalDecimal.exec(value)
          if (
            match === null ||
            intent.precision === null ||
            (match[1]?.length ?? 0) > intent.precision
          ) {
            return { kind: 'invalid_quantity', title: intent.title }
          }
          quantityValue = value
        } else if (kind === 'actual_time') {
          if (!canonicalTime.test(value)) {
            return {
              kind: 'invalid_scalar',
              title: intent.title,
              inputKind: kind,
            }
          }
          actualTimeValue = value
        } else if (kind === 'rating') {
          if (!canonicalInteger.test(value)) {
            return {
              kind: 'invalid_scalar',
              title: intent.title,
              inputKind: kind,
            }
          }
          ratingValue = BigInt(value)
          if (
            ratingValue < BigInt(Number.MIN_SAFE_INTEGER) ||
            ratingValue > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            return {
              kind: 'invalid_scalar',
              title: intent.title,
              inputKind: kind,
            }
          }
        } else {
          return { kind: 'stale' }
        }
        const candidate: StoredTelegramActionIntent = {
          ...intent,
          quantityValue,
          actualTimeValue,
          ratingValue,
          state: 'ready',
        }
        const commandFingerprint = fingerprint(member, candidate)
        if (commandFingerprint === null) return { kind: 'stale' }
        const ready = await this.intents.setValue({
          actionIntentId: intent.actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
          quantityValue,
          actualTimeValue,
          ratingValue,
          commandFingerprint,
          now,
        })
        return ready === null ? { kind: 'stale' } : preview(ready)
      }),
    )
  }

  public acceptQuantity(
    member: MemberContext,
    rawValue: string,
  ): Promise<TelegramIntentOutcome | null> {
    return this.acceptValue(member, rawValue)
  }

  public confirm(
    member: MemberContext,
    actionIntentId: string,
  ): Promise<TelegramIntentOutcome> {
    return this.safe(async () =>
      this.transaction.run(async () => {
        const now = this.clock.now()
        const intent = await this.intents.lockForMember({
          actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
        })
        if (intent === null) return { kind: 'not_found' }
        if (intent.state === 'completed' && intent.result !== null) {
          return {
            kind: 'completed',
            title: intent.title,
            result: intent.result,
          }
        }
        if (intent.expiresAt.getTime() <= now.getTime()) {
          await this.intents.markExpired(actionIntentId, now)
          return { kind: 'expired' }
        }
        if (intent.monthStatus === 'closed') return { kind: 'blocked' }
        if (
          intent.activePublicationId !== intent.publicationId ||
          intent.currentFactsRevision !== intent.sourceFactsRevision ||
          intent.state !== 'ready'
        ) {
          return { kind: 'stale' }
        }
        const outcome =
          intent.intentKind === 'boolean' || intent.intentKind === 'quantity'
            ? await executeBasicFactIntent(this.tracking, member, intent)
            : await executeScalarFactIntent(this.tracking, member, intent)
        if (outcome.kind !== 'completed') return outcome
        await this.intents.markCompleted({
          actionIntentId,
          result: outcome.result,
          completedAt: now,
        })
        return {
          kind: 'completed',
          title: intent.title,
          result: outcome.result,
        }
      }),
    )
  }

  private async safe(
    operation: () => Promise<TelegramIntentOutcome>,
  ): Promise<TelegramIntentOutcome> {
    try {
      return await operation()
    } catch (error: unknown) {
      return finiteOutcome(error) ?? { kind: 'dependency_unavailable' }
    }
  }

  private async safeNullable(
    operation: () => Promise<TelegramIntentOutcome | null>,
  ): Promise<TelegramIntentOutcome | null> {
    try {
      return await operation()
    } catch (error: unknown) {
      return finiteOutcome(error) ?? { kind: 'dependency_unavailable' }
    }
  }
}
