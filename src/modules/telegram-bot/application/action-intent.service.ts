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
import {
  compositeFingerprintForIntent,
  compositeIntentValue,
  executeCompositeFactIntent,
} from './composite-fact-command.mapper'
import {
  telegramIntentMessageLimit,
  telegramIntentPreviewText,
} from './telegram-today.renderer'
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
  readonly textResult: 'done' | 'not_done' | null
  readonly checklistItemId: string | null
  readonly checklistItemState: 'done' | 'not_done' | null
  readonly orVariantId: string | null
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
  const compositeKinds: readonly TelegramActionIntentKind[] = [
    'text',
    'checkpoint_text',
    'checklist_item',
    'checkpoint_checklist_item',
    'or_variant',
    'checkpoint_or_variant',
    'composite_checklist_item',
    'composite_or_variant',
  ]
  const payload =
    input.kind === 'boolean' || input.kind === 'quantity'
      ? preimage
      : compositeKinds.includes(input.kind)
        ? {
            ...preimage,
            checkpointId: input.checkpointId,
            checklistItemId: input.checklistItemId,
            checklistItemState: input.checklistItemState,
            orVariantId: input.orVariantId,
            textResult: input.textResult,
          }
        : { ...preimage, checkpointId: input.checkpointId }
  return createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
}

function fingerprint(
  member: MemberContext,
  intent: StoredTelegramActionIntent,
): string | null {
  if (intent.intentKind === 'boolean' || intent.intentKind === 'quantity') {
    return fingerprintForIntent(member, intent)
  }
  if (
    intent.intentKind === 'actual_time' ||
    intent.intentKind === 'rating' ||
    intent.intentKind === 'checkpoint_boolean' ||
    intent.intentKind === 'checkpoint_actual_time' ||
    intent.intentKind === 'checkpoint_rating'
  ) {
    return scalarFingerprintForIntent(member, intent)
  }
  return compositeFingerprintForIntent(member, intent)
}

function preview(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const value =
    intentValue(intent) ??
    scalarIntentValue(intent) ??
    compositeIntentValue(intent)
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
  textResult: 'done' | 'not_done' | null = null,
  checklistItemId: string | null = null,
  checklistItemState: 'done' | 'not_done' | null = null,
  orVariantId: string | null = null,
  ready = booleanResult !== null || checklistItemState !== null,
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
      textResult,
      checklistItemId,
      checklistItemState,
      orVariantId,
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
    textResult,
    checklistItemId,
    checklistItemState,
    orVariantId,
    expiresAt: new Date(now.getTime() + intentTtlMs),
  } as const
  if (!ready) {
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
    textValue: null,
    orVariantValue: null,
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
): 'quantity' | 'actual_time' | 'rating' | 'text' | 'or_variant' | null {
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
  if (intent.intentKind === 'text' || intent.intentKind === 'checkpoint_text') {
    return 'text'
  }
  if (
    intent.intentKind === 'or_variant' ||
    intent.intentKind === 'checkpoint_or_variant' ||
    intent.intentKind === 'composite_or_variant'
  ) {
    return 'or_variant'
  }
  return null
}

function awaiting(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const kind = inputKind(intent)
  if (kind === 'quantity') {
    return { kind: 'awaiting_quantity', title: intent.title }
  }
  if (kind === 'text') return { kind: 'awaiting_text', title: intent.title }
  if (kind === 'or_variant') {
    return { kind: 'awaiting_or_variant', title: intent.title }
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
    const addAction = async (input: {
      readonly goal: TrackingGoalReadV1
      readonly kind: TelegramActionIntentKind
      readonly checkpointId: string | null
      readonly booleanResult?: 'done' | 'not_done' | null
      readonly textResult?: 'done' | 'not_done' | null
      readonly checklistItemId?: string | null
      readonly checklistItemState?: 'done' | 'not_done' | null
      readonly orVariantId?: string | null
      readonly ready?: boolean
      readonly text: string
    }): Promise<void> => {
      const intent = await this.intents.offer(
        offerInput(
          member,
          model,
          input.goal,
          model.day.localDate,
          input.kind,
          input.checkpointId,
          input.booleanResult ?? null,
          now,
          input.textResult ?? null,
          input.checklistItemId ?? null,
          input.checklistItemState ?? null,
          input.orVariantId ?? null,
          input.ready ?? false,
        ),
        now,
      )
      buttons.push({ text: input.text, actionIntentId: intent.actionIntentId })
    }
    const hasFact = (
      expectation: TrackingFixedExpectationV1,
      factKind: TrackingFactReadV1['factKind'],
      componentId?: string,
    ): boolean =>
      expectation.facts.some(
        (fact) =>
          fact.factKind === factKind &&
          (componentId === undefined ||
            fact.checklistItemId === componentId ||
            fact.orVariantId === componentId),
      )
    const hasPeriodFact = (
      period: TrackingDayGoalV1['flexiblePeriods'][number],
      factKind: TrackingFactReadV1['factKind'],
      componentId: string,
    ): boolean =>
      period.facts.some(
        (fact) =>
          fact.factKind === factKind &&
          (fact.checklistItemId === componentId ||
            fact.orVariantId === componentId),
      )
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
            await addAction({
              goal,
              kind: 'boolean',
              checkpointId: null,
              booleanResult: result,
              ready: true,
              text: `${result === 'done' ? '✓' : '✕'} ${goal.title}`,
            })
          }
        } else if (measurement.kind === 'quantity') {
          if (
            measurement.aggregation === 'latest' &&
            facts.some((fact) => fact.factKind === 'quantity_latest')
          ) {
            continue
          }
          await addAction({
            goal,
            kind: 'quantity',
            checkpointId: null,
            text: `Ввести ${goal.title}`,
          })
        } else if (
          (measurement.kind === 'actual_time' ||
            measurement.kind === 'rating') &&
          day.fixedExpectations.some(
            (value) => value.componentKind === 'goal' && !hasRecord(value),
          )
        ) {
          await addAction({
            goal,
            kind: measurement.kind,
            checkpointId: null,
            text: `Ввести ${goal.title}`,
          })
        } else if (measurement.kind === 'text') {
          const expectation = day.fixedExpectations.find(
            (value) => value.componentKind === 'goal',
          )
          if (expectation !== undefined && !hasFact(expectation, 'text')) {
            for (const result of ['done', 'not_done'] as const) {
              await addAction({
                goal,
                kind: 'text',
                checkpointId: null,
                textResult: result,
                text: `${result === 'done' ? '✓' : '✕'} ${goal.title}`,
              })
            }
          }
        } else if (measurement.kind === 'checklist') {
          for (const expectation of day.fixedExpectations) {
            if (
              expectation.componentKind !== 'checklist_item' ||
              expectation.componentId === null ||
              hasFact(expectation, 'checklist_item')
            ) {
              continue
            }
            const item = measurement.items.find(
              (value) => value.itemId === expectation.componentId,
            )
            if (item === undefined) continue
            for (const state of ['done', 'not_done'] as const) {
              await addAction({
                goal,
                kind: 'checklist_item',
                checkpointId: null,
                checklistItemId: item.itemId,
                checklistItemState: state,
                ready: true,
                text: `${state === 'done' ? '✓' : '✕'} ${goal.title} · ${item.label}`,
              })
            }
          }
        } else if (measurement.kind === 'any_of') {
          const expectation = day.fixedExpectations.find(
            (value) => value.componentKind === 'goal',
          )
          if (expectation !== undefined) {
            for (const variant of measurement.variants) {
              if (
                variant.variantId === null ||
                hasFact(expectation, 'or_variant', variant.variantId)
              ) {
                continue
              }
              await addAction({
                goal,
                kind: 'or_variant',
                checkpointId: null,
                orVariantId: variant.variantId,
                text: `Ввести ${goal.title} · ${variant.label}`,
              })
            }
          }
        }
        if (measurement.kind === 'checklist' || measurement.kind === 'any_of') {
          for (const period of day.flexiblePeriods) {
            if (!period.eligibleOnDate) continue
            if (measurement.kind === 'checklist') {
              for (const item of measurement.items) {
                if (
                  item.itemId === null ||
                  hasPeriodFact(period, 'checklist_item', item.itemId)
                ) {
                  continue
                }
                for (const state of ['done', 'not_done'] as const) {
                  await addAction({
                    goal,
                    kind: 'composite_checklist_item',
                    checkpointId: null,
                    checklistItemId: item.itemId,
                    checklistItemState: state,
                    ready: true,
                    text: `${state === 'done' ? '✓' : '✕'} ${goal.title} · ${item.label}`,
                  })
                }
              }
            } else {
              for (const variant of measurement.variants) {
                if (
                  variant.variantId === null ||
                  hasPeriodFact(period, 'or_variant', variant.variantId)
                ) {
                  continue
                }
                await addAction({
                  goal,
                  kind: 'composite_or_variant',
                  checkpointId: null,
                  orVariantId: variant.variantId,
                  text: `Ввести ${goal.title} · ${variant.label}`,
                })
              }
            }
          }
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
          expectation.componentId === null
        ) {
          continue
        }
        const checkpoint = checkpoints.get(expectation.componentId)
        if (checkpoint === undefined) continue
        const satisfaction = checkpoint.satisfaction
        const kind = `checkpoint_${satisfaction.kind}` as const
        if (
          kind !== 'checkpoint_checklist' &&
          kind !== 'checkpoint_any_of' &&
          hasRecord(expectation)
        ) {
          continue
        }
        if (kind === 'checkpoint_boolean') {
          for (const result of ['done', 'not_done'] as const) {
            await addAction({
              goal,
              kind,
              checkpointId: expectation.componentId,
              booleanResult: result,
              ready: true,
              text: `${result === 'done' ? '✓' : '✕'} ${goal.title} · ${checkpoint.name}`,
            })
          }
        } else if (
          kind === 'checkpoint_actual_time' ||
          kind === 'checkpoint_rating'
        ) {
          await addAction({
            goal,
            kind,
            checkpointId: expectation.componentId,
            text: `Ввести ${goal.title} · ${checkpoint.name}`,
          })
        } else if (kind === 'checkpoint_text') {
          for (const result of ['done', 'not_done'] as const) {
            await addAction({
              goal,
              kind,
              checkpointId: expectation.componentId,
              textResult: result,
              text: `${result === 'done' ? '✓' : '✕'} ${goal.title} · ${checkpoint.name}`,
            })
          }
        } else if (kind === 'checkpoint_checklist') {
          if (measurement.kind !== 'checklist') continue
          for (const item of measurement.items) {
            if (
              item.itemId === null ||
              hasFact(expectation, 'checklist_item', item.itemId)
            ) {
              continue
            }
            for (const state of ['done', 'not_done'] as const) {
              await addAction({
                goal,
                kind: 'checkpoint_checklist_item',
                checkpointId: expectation.componentId,
                checklistItemId: item.itemId,
                checklistItemState: state,
                ready: true,
                text: `${state === 'done' ? '✓' : '✕'} ${goal.title} · ${checkpoint.name} · ${item.label}`,
              })
            }
          }
        } else if (kind === 'checkpoint_any_of') {
          if (measurement.kind !== 'any_of') continue
          for (const variant of measurement.variants) {
            if (
              variant.variantId === null ||
              hasFact(expectation, 'or_variant', variant.variantId)
            ) {
              continue
            }
            await addAction({
              goal,
              kind: 'checkpoint_or_variant',
              checkpointId: expectation.componentId,
              orVariantId: variant.variantId,
              text: `Ввести ${goal.title} · ${checkpoint.name} · ${variant.label}`,
            })
          }
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
          current.intentKind === 'checkpoint_boolean' ||
          current.intentKind === 'checklist_item' ||
          current.intentKind === 'checkpoint_checklist_item' ||
          current.intentKind === 'composite_checklist_item'
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
        let textValue: string | null = null
        let orVariantValue: string | null = null
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
        } else if (kind === 'text') {
          if (value.length === 0) {
            return { kind: 'invalid_text', title: intent.title }
          }
          textValue = rawValue
        } else if (kind === 'or_variant') {
          const match = canonicalDecimal.exec(value)
          if (
            match === null ||
            intent.precision === null ||
            (match[1]?.length ?? 0) > intent.precision
          ) {
            return { kind: 'invalid_or_variant', title: intent.title }
          }
          orVariantValue = value
        } else {
          return { kind: 'stale' }
        }
        const candidate: StoredTelegramActionIntent = {
          ...intent,
          quantityValue,
          actualTimeValue,
          ratingValue,
          textValue,
          orVariantValue,
          state: 'ready',
        }
        const candidatePreview = preview(candidate)
        if (
          candidatePreview.kind !== 'preview' ||
          telegramIntentPreviewText(candidatePreview).length >
            telegramIntentMessageLimit
        ) {
          return kind === 'text'
            ? { kind: 'invalid_text', title: intent.title }
            : kind === 'or_variant'
              ? { kind: 'invalid_or_variant', title: intent.title }
              : kind === 'quantity'
                ? { kind: 'invalid_quantity', title: intent.title }
                : { kind: 'stale' }
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
          textValue,
          orVariantValue,
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
            : intent.intentKind === 'actual_time' ||
                intent.intentKind === 'rating' ||
                intent.intentKind === 'checkpoint_boolean' ||
                intent.intentKind === 'checkpoint_actual_time' ||
                intent.intentKind === 'checkpoint_rating'
              ? await executeScalarFactIntent(this.tracking, member, intent)
              : await executeCompositeFactIntent(this.tracking, member, intent)
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
