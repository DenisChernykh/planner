import { createHash, randomUUID } from 'node:crypto'

import type {
  TrackingApplication,
  TrackingDayGoalV1,
  TrackingFactReadV1,
  TrackingGoalReadV1,
  TrackingTodayReadModelV1,
} from '@/modules/tracking'
import type { MemberContext } from '@/modules/workspace'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  basicFactErrorOutcome,
  commandForIntent,
  fingerprintForIntent,
} from './basic-fact-command.mapper'
import type {
  StoredTelegramActionIntent,
  TelegramActionButton,
  TelegramActionIntentOffer,
  TelegramActionIntentPersistencePort,
  TelegramIntentOutcome,
} from './action-intent.types'

const intentTtlMs = 15 * 60 * 1_000
const canonicalDecimal = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u

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
  readonly kind: 'boolean' | 'quantity'
  readonly booleanResult: 'done' | 'not_done' | null
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        booleanResult: input.booleanResult,
        factsRevision: input.factsRevision.toString(10),
        goalId: input.goalId,
        kind: input.kind,
        localDate: input.localDate,
        memberId: input.member.memberId,
        publicationId: input.publicationId,
        spaceId: input.member.spaceId,
      }),
      'utf8',
    )
    .digest('hex')
}

function preview(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const value =
    intent.intentKind === 'boolean'
      ? intent.booleanResult === null
        ? null
        : { kind: 'boolean' as const, result: intent.booleanResult }
      : intent.quantityValue === null
        ? null
        : { kind: 'quantity' as const, value: intent.quantityValue }
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
  kind: 'boolean' | 'quantity',
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
      localDate: model.queryLocalDate,
      factsRevision: model.factsRevision,
      kind,
      booleanResult,
    }),
    spaceId: member.spaceId,
    memberId: member.memberId,
    publicationId: model.publicationId,
    planGoalSnapshotId: goal.planGoalSnapshotId,
    localDate: model.queryLocalDate,
    sourceFactsRevision: model.factsRevision,
    intentKind: kind,
    booleanResult,
    expiresAt: new Date(now.getTime() + intentTtlMs),
  } as const
  if (kind === 'quantity') {
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
    commandFingerprint: fingerprintForIntent(member, candidate),
  }
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
        goal.viewerAccess === 'partner_read_only' ||
        goal.config.checkpoints !== null
      ) {
        continue
      }
      const measurement = goal.config.measurement
      const facts = goalFacts(day)
      if (measurement.kind === 'boolean') {
        if (facts.some((fact) => fact.factKind === 'boolean')) continue
        for (const result of ['done', 'not_done'] as const) {
          const intent = await this.intents.offer(
            offerInput(member, model, goal, 'boolean', result, now),
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
          offerInput(member, model, goal, 'quantity', null, now),
          now,
        )
        buttons.push({
          text: `Ввести ${goal.title}`,
          actionIntentId: intent.actionIntentId,
        })
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
        if (current.intentKind === 'boolean') return preview(current)
        if (current.state === 'ready') return preview(current)
        if (current.state === 'awaiting_value') {
          return { kind: 'awaiting_quantity', title: current.title }
        }
        if (current.state !== 'offered') return { kind: 'stale' }
        const selected = await this.intents.selectQuantity({
          actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
          now,
        })
        return selected === null
          ? { kind: 'not_found' }
          : { kind: 'awaiting_quantity', title: selected.title }
      }),
    )
  }

  public acceptQuantity(
    member: MemberContext,
    rawValue: string,
  ): Promise<TelegramIntentOutcome | null> {
    return this.safeNullable(async () =>
      this.transaction.run(async () => {
        const now = this.clock.now()
        const intent = await this.intents.findAwaitingQuantity({
          spaceId: member.spaceId,
          memberId: member.memberId,
          now,
        })
        if (intent === null) return null
        const value = rawValue.trim()
        const match = canonicalDecimal.exec(value)
        if (
          match === null ||
          intent.precision === null ||
          (match[1]?.length ?? 0) > intent.precision
        ) {
          return { kind: 'invalid_quantity', title: intent.title }
        }
        const candidate = {
          ...intent,
          quantityValue: value,
          state: 'ready' as const,
        }
        const fingerprint = fingerprintForIntent(member, candidate)
        if (fingerprint === null) return { kind: 'stale' }
        const ready = await this.intents.setQuantityValue({
          actionIntentId: intent.actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
          value,
          commandFingerprint: fingerprint,
          now,
        })
        return ready === null ? { kind: 'stale' } : preview(ready)
      }),
    )
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
        const command = commandForIntent(member, intent)
        if (
          command === null ||
          intent.commandFingerprint === null ||
          fingerprintForIntent(member, intent) !== intent.commandFingerprint
        ) {
          return { kind: 'stale' }
        }
        const result = await this.tracking.recordFact.execute(command)
        await this.intents.markCompleted({
          actionIntentId,
          result,
          completedAt: now,
        })
        return {
          kind: 'completed',
          title: intent.title,
          result,
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
      return basicFactErrorOutcome(error) ?? { kind: 'dependency_unavailable' }
    }
  }

  private async safeNullable(
    operation: () => Promise<TelegramIntentOutcome | null>,
  ): Promise<TelegramIntentOutcome | null> {
    try {
      return await operation()
    } catch (error: unknown) {
      return basicFactErrorOutcome(error) ?? { kind: 'dependency_unavailable' }
    }
  }
}
