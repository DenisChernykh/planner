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
  executeTrackingIntent,
  trackingActionErrorOutcome,
  trackingFingerprintForIntent,
  trackingIntentValue,
} from './tracking-action.mapper'
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
const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Yekaterinburg',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function localDateAt(value: Date): string {
  return localDateFormatter.format(value)
}

function closeDayExpiresAt(now: Date, localDate: string): Date {
  const nextMidnight =
    Date.parse(`${localDate}T00:00:00+05:00`) + 24 * 60 * 60 * 1_000
  return new Date(Math.min(now.getTime() + intentTtlMs, nextMidnight))
}

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
  if (
    intent.intentKind.startsWith('correct_') ||
    intent.intentKind === 'delete_record' ||
    intent.intentKind === 'undo_record' ||
    intent.intentKind === 'close_day' ||
    intent.intentKind === 'weekly_task_result'
  ) {
    return trackingFingerprintForIntent(member, intent)
  }
  return compositeFingerprintForIntent(member, intent)
}

function preview(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  const value =
    intentValue(intent) ??
    scalarIntentValue(intent) ??
    compositeIntentValue(intent) ??
    trackingIntentValue(intent)
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
        reason: intent.reason,
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
    factRecordId: null,
    expectedRecordRevision: null,
    flexiblePeriodId: null,
    reason: null,
    closePreviewSchemaVersion: null,
    closePreviewHashVersion: null,
    closePreviewHash: null,
    closeUnresolvedCount: null,
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
    factRecordId: null,
    expectedRecordRevision: null,
    flexiblePeriodId: null,
    reason: null,
    closePreviewSchemaVersion: null,
    closePreviewHashVersion: null,
    closePreviewHash: null,
    closeUnresolvedCount: null,
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

function trackingOfferInput(input: {
  readonly member: MemberContext
  readonly model: Extract<
    TrackingTodayReadModelV1,
    { readonly state: 'published' }
  >
  readonly goal: TrackingGoalReadV1 | null
  readonly localDate: string
  readonly kind: TelegramActionIntentKind
  readonly factRecordId?: string | null
  readonly expectedRecordRevision?: bigint | null
  readonly flexiblePeriodId?: string | null
  readonly booleanResult?: 'done' | 'not_done' | null
  readonly textResult?: 'done' | 'not_done' | null
  readonly checklistItemState?: 'done' | 'not_done' | null
  readonly ready?: boolean
  readonly now: Date
}): TelegramActionIntentOffer {
  const actionIntentId = randomUUID()
  const base = {
    actionIntentId,
    semanticKey: createHash('sha256')
      .update(
        JSON.stringify({
          memberId: input.member.memberId,
          spaceId: input.member.spaceId,
          publicationId: input.model.publicationId,
          sourceFactsRevision: input.model.factsRevision.toString(10),
          localDate: input.localDate,
          kind: input.kind,
          factRecordId: input.factRecordId ?? null,
          expectedRecordRevision:
            input.expectedRecordRevision?.toString(10) ?? null,
          flexiblePeriodId: input.flexiblePeriodId ?? null,
          booleanResult: input.booleanResult ?? null,
          textResult: input.textResult ?? null,
          checklistItemState: input.checklistItemState ?? null,
        }),
        'utf8',
      )
      .digest('hex'),
    spaceId: input.member.spaceId,
    memberId: input.member.memberId,
    publicationId: input.model.publicationId,
    planGoalSnapshotId: input.goal?.planGoalSnapshotId ?? null,
    localDate: input.localDate,
    sourceFactsRevision: input.model.factsRevision,
    intentKind: input.kind,
    checkpointId: null,
    booleanResult: input.booleanResult ?? null,
    textResult: input.textResult ?? null,
    checklistItemId: null,
    checklistItemState: input.checklistItemState ?? null,
    orVariantId: null,
    factRecordId: input.factRecordId ?? null,
    expectedRecordRevision: input.expectedRecordRevision ?? null,
    flexiblePeriodId: input.flexiblePeriodId ?? null,
    reason: null,
    closePreviewSchemaVersion: null,
    closePreviewHashVersion: null,
    closePreviewHash: null,
    closeUnresolvedCount: null,
    expiresAt:
      input.kind === 'close_day'
        ? closeDayExpiresAt(input.now, input.localDate)
        : new Date(input.now.getTime() + intentTtlMs),
  } as const
  if (!(input.ready ?? false)) {
    return { ...base, state: 'offered', commandFingerprint: null }
  }
  const candidate: StoredTelegramActionIntent = {
    ...base,
    commandId: actionIntentId,
    currentFactsRevision: input.model.factsRevision,
    activePublicationId: input.model.publicationId,
    monthStatus: input.model.monthStatus,
    state: 'ready',
    quantityValue: null,
    actualTimeValue: null,
    ratingValue: null,
    textValue: null,
    orVariantValue: null,
    commandFingerprint: null,
    title: input.goal?.title ?? 'Закрыть день',
    unit: null,
    precision: null,
    aggregation: null,
    result: null,
  }
  return {
    ...base,
    state: 'ready',
    commandFingerprint: trackingFingerprintForIntent(input.member, candidate),
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
  if (intent.intentKind === 'correct_quantity') return 'quantity'
  if (intent.intentKind === 'correct_actual_time') return 'actual_time'
  if (intent.intentKind === 'correct_rating') return 'rating'
  if (intent.intentKind === 'correct_text') return 'text'
  if (intent.intentKind === 'correct_or_variant') return 'or_variant'
  return null
}

function awaiting(intent: StoredTelegramActionIntent): TelegramIntentOutcome {
  if (intent.state === 'awaiting_reason') {
    return { kind: 'awaiting_reason', title: intent.title }
  }
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
  return expectation.facts.some((fact) => fact.factKind !== 'fixed_not_done')
}

function finiteOutcome(error: unknown): TelegramIntentOutcome | null {
  const direct =
    basicFactErrorOutcome(error) ?? trackingActionErrorOutcome(error)
  if (direct !== null) return direct
  return error instanceof DatabaseTransactionRollbackOnlyError
    ? finiteOutcome(error.cause)
    : null
}

function isTrackingIntent(kind: TelegramActionIntentKind): boolean {
  return (
    kind.startsWith('correct_') ||
    kind === 'delete_record' ||
    kind === 'undo_record' ||
    kind === 'close_day' ||
    kind === 'weekly_task_result'
  )
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
    const now = this.clock.now()
    if (model.day.localDate !== localDateAt(now)) return Object.freeze([])
    const days = new Map(
      model.day.goals.map((value) => [value.planGoalSnapshotId, value]),
    )
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
    const addTrackingAction = async (
      offer: TelegramActionIntentOffer,
      text: string,
    ): Promise<void> => {
      const intent = await this.intents.offer(offer, now)
      buttons.push({ text, actionIntentId: intent.actionIntentId })
    }
    for (const goal of model.goals) {
      const day = days.get(goal.planGoalSnapshotId)
      if (
        day === undefined ||
        !day.writable ||
        goal.viewerAccess === 'partner_read_only'
      ) {
        continue
      }
      const facts = new Map(
        goalFacts(day).map((fact) => [fact.factRecordId, fact]),
      )
      for (const fact of facts.values()) {
        if (fact.factKind === 'fixed_not_done') continue
        const base = {
          member,
          model,
          goal,
          localDate: model.day.localDate,
          factRecordId: fact.factRecordId,
          expectedRecordRevision: fact.revision,
          now,
        } as const
        const label = `Исправить ${goal.title}`
        const storedKind = fact.value?.kind
        if (storedKind === 'fixed_not_done') continue
        const valueKind =
          storedKind ??
          (() => {
            switch (fact.factKind) {
              case 'boolean':
              case 'weekly_task_result':
                return 'boolean'
              case 'quantity_add':
              case 'quantity_latest':
                return 'quantity'
              case 'actual_time':
                return 'actual_time'
              case 'rating':
                return 'rating'
              case 'text':
                return 'text'
              case 'checklist_item':
                return 'checklist_item'
              case 'or_variant':
                return 'or_variant'
            }
          })()
        switch (valueKind) {
          case 'boolean':
            for (const result of ['done', 'not_done'] as const) {
              await addTrackingAction(
                trackingOfferInput({
                  ...base,
                  kind: 'correct_boolean',
                  booleanResult: result,
                }),
                `${result === 'done' ? '✓' : '✕'} ${label}`,
              )
            }
            break
          case 'quantity':
            await addTrackingAction(
              trackingOfferInput({ ...base, kind: 'correct_quantity' }),
              label,
            )
            break
          case 'actual_time':
            await addTrackingAction(
              trackingOfferInput({ ...base, kind: 'correct_actual_time' }),
              label,
            )
            break
          case 'rating':
            await addTrackingAction(
              trackingOfferInput({ ...base, kind: 'correct_rating' }),
              label,
            )
            break
          case 'text':
            for (const result of ['done', 'not_done'] as const) {
              await addTrackingAction(
                trackingOfferInput({
                  ...base,
                  kind: 'correct_text',
                  textResult: result,
                }),
                `${result === 'done' ? '✓' : '✕'} ${label}`,
              )
            }
            break
          case 'checklist_item':
            for (const state of ['done', 'not_done'] as const) {
              await addTrackingAction(
                trackingOfferInput({
                  ...base,
                  kind: 'correct_checklist_item',
                  checklistItemState: state,
                }),
                `${state === 'done' ? '✓' : '✕'} ${label}`,
              )
            }
            break
          case 'or_variant':
            await addTrackingAction(
              trackingOfferInput({ ...base, kind: 'correct_or_variant' }),
              label,
            )
            break
        }
        if (
          fact.revisionKind === 'recorded' &&
          goal.viewerAccess === 'personal_owner'
        ) {
          await addTrackingAction(
            trackingOfferInput({ ...base, kind: 'delete_record' }),
            `Удалить ${goal.title}`,
          )
        }
        if (fact.recordedByMemberId === member.memberId) {
          await addTrackingAction(
            trackingOfferInput({ ...base, kind: 'undo_record', ready: true }),
            `Отменить действие · ${goal.title}`,
          )
        }
      }
      for (const period of day.flexiblePeriods) {
        if (
          period.periodKind !== 'weekly_planned_task' ||
          !period.eligibleOnDate ||
          period.facts.some((fact) => fact.factKind === 'weekly_task_result')
        ) {
          continue
        }
        for (const result of ['done', 'not_done'] as const) {
          await addTrackingAction(
            trackingOfferInput({
              member,
              model,
              goal,
              localDate: model.day.localDate,
              kind: 'weekly_task_result',
              flexiblePeriodId: period.flexiblePeriodId,
              booleanResult: result,
              ready: true,
              now,
            }),
            `${result === 'done' ? '✓' : '✕'} задача недели · ${goal.title}`,
          )
        }
      }
    }
    if (model.day.closure.state === 'open') {
      await addTrackingAction(
        trackingOfferInput({
          member,
          model,
          goal: null,
          localDate: model.day.localDate,
          kind: 'close_day',
          now,
        }),
        'Закрыть день',
      )
    }
    return Object.freeze(buttons)
  }

  public select(
    member: MemberContext,
    actionIntentId: string,
  ): Promise<TelegramIntentOutcome> {
    return this.safe(async () => {
      const probe = await this.transaction.run(() =>
        this.intents.lockForMember({
          actionIntentId,
          spaceId: member.spaceId,
          memberId: member.memberId,
        }),
      )
      if (probe?.intentKind === 'close_day') {
        const now = this.clock.now()
        if (probe.state === 'completed' && probe.result !== null) {
          return {
            kind: 'completed',
            title: probe.title,
            result: probe.result,
          }
        }
        if (
          probe.expiresAt.getTime() <= now.getTime() ||
          probe.localDate !== localDateAt(now)
        ) {
          await this.transaction.run(() =>
            this.intents.markExpired(actionIntentId, now),
          )
          return { kind: 'expired' }
        }
        if (probe.state === 'ready') return preview(probe)
        if (probe.state !== 'offered') return { kind: 'stale' }
        const closePreview = await this.tracking.previewCloseDay.execute({
          trustedActor: { kind: 'member', id: member.memberId },
          publicationId: probe.publicationId,
          localDate: probe.localDate,
        })
        if (closePreview.state !== 'ready') return { kind: 'stale' }
        return this.transaction.run(async () => {
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
          if (
            current.expiresAt.getTime() <= now.getTime() ||
            current.localDate !== localDateAt(now)
          ) {
            await this.intents.markExpired(actionIntentId, now)
            return { kind: 'expired' }
          }
          if (
            current.state !== 'offered' ||
            current.currentFactsRevision !== closePreview.factsRevision
          ) {
            return { kind: 'stale' }
          }
          const candidate: StoredTelegramActionIntent = {
            ...current,
            state: 'ready',
            sourceFactsRevision: closePreview.factsRevision,
            closePreviewSchemaVersion: closePreview.schemaVersion,
            closePreviewHashVersion: closePreview.previewHashVersion,
            closePreviewHash: closePreview.previewHash,
            closeUnresolvedCount: closePreview.unresolved.length,
          }
          const commandFingerprint = fingerprint(member, candidate)
          if (commandFingerprint === null) return { kind: 'stale' }
          const ready = await this.intents.prepareCloseDay({
            actionIntentId,
            spaceId: member.spaceId,
            memberId: member.memberId,
            sourceFactsRevision: closePreview.factsRevision,
            previewSchemaVersion: closePreview.schemaVersion,
            previewHashVersion: closePreview.previewHashVersion,
            previewHash: closePreview.previewHash,
            unresolvedCount: closePreview.unresolved.length,
            commandFingerprint,
            now,
          })
          return ready === null ? { kind: 'stale' } : preview(ready)
        })
      }
      return this.transaction.run(async () => {
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
        if (isTrackingIntent(current.intentKind)) {
          if (current.state === 'ready') return preview(current)
          if (
            current.state === 'awaiting_value' ||
            current.state === 'awaiting_reason'
          ) {
            return awaiting(current)
          }
          if (current.state !== 'offered') return { kind: 'stale' }
          if (
            current.intentKind === 'correct_boolean' ||
            current.intentKind === 'correct_checklist_item' ||
            current.intentKind === 'delete_record'
          ) {
            const awaitingReason = await this.intents.beginReason({
              actionIntentId,
              spaceId: member.spaceId,
              memberId: member.memberId,
              now,
            })
            return awaitingReason === null
              ? { kind: 'stale' }
              : awaiting(awaitingReason)
          }
          const selected = await this.intents.selectValue({
            actionIntentId,
            spaceId: member.spaceId,
            memberId: member.memberId,
            now,
          })
          return selected === null ? { kind: 'stale' } : awaiting(selected)
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
      })
    })
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
        if (intent.state === 'awaiting_reason') {
          if (rawValue.trim().length === 0 || rawValue.length > 2_000) {
            return { kind: 'invalid_reason', title: intent.title }
          }
          const candidate: StoredTelegramActionIntent = {
            ...intent,
            state: 'ready',
            reason: rawValue,
          }
          const commandFingerprint = fingerprint(member, candidate)
          if (commandFingerprint === null) return { kind: 'stale' }
          const candidatePreview = preview(candidate)
          if (
            candidatePreview.kind !== 'preview' ||
            telegramIntentPreviewText(candidatePreview).length >
              telegramIntentMessageLimit
          ) {
            return { kind: 'invalid_reason', title: intent.title }
          }
          const ready = await this.intents.setReason({
            actionIntentId: intent.actionIntentId,
            spaceId: member.spaceId,
            memberId: member.memberId,
            reason: rawValue,
            commandFingerprint,
            now,
          })
          return ready === null ? { kind: 'stale' } : preview(ready)
        }
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
        const needsReason = intent.intentKind.startsWith('correct_')
        const commandFingerprint = needsReason
          ? null
          : fingerprint(member, candidate)
        if (!needsReason && commandFingerprint === null) {
          return { kind: 'stale' }
        }
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
          nextState: needsReason ? 'awaiting_reason' : 'ready',
          now,
        })
        return ready === null
          ? { kind: 'stale' }
          : needsReason
            ? awaiting(ready)
            : preview(ready)
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
        if (
          intent.intentKind === 'close_day' &&
          intent.localDate !== localDateAt(now)
        ) {
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
              : isTrackingIntent(intent.intentKind)
                ? await executeTrackingIntent(this.tracking, member, intent)
                : await executeCompositeFactIntent(
                    this.tracking,
                    member,
                    intent,
                  )
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
