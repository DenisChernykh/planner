export class DraftGoalConfigValidationError extends Error {
  public constructor() {
    super('Draft goal config is structurally invalid')
    this.name = 'DraftGoalConfigValidationError'
  }
}

const CommandValidationError = DraftGoalConfigValidationError

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export type DraftGoalScopeV1 =
  | { readonly kind: 'personal'; readonly ownerMemberId: string | null }
  | { readonly kind: 'shared' }
export type DraftGoalRepetitionV1 =
  | { readonly kind: 'daily' }
  | { readonly kind: 'weekdays'; readonly weekdays: readonly Weekday[] }
  | { readonly kind: 'weekly'; readonly n: string | null }
  | { readonly kind: 'monthly'; readonly n: string | null }
  | { readonly kind: 'one_off'; readonly dueDate: string | null }
  | {
      readonly kind: 'weekly_planned_task'
      readonly weekOrdinal: '1' | '2' | '3' | '4' | '5' | null
      readonly taskText: string | null
    }
export type DraftGoalMeasurementV1 =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'quantity'
      readonly mode: 'targeted' | 'informational' | null
      readonly unit: string | null
      readonly precision: 0 | 1 | 2 | 3 | null
      readonly aggregation: 'add' | 'latest' | null
      readonly target: string | null
    }
  | {
      readonly kind: 'actual_time'
      readonly start: string | null
      readonly end: string | null
    }
  | {
      readonly kind: 'rating'
      readonly minimum: number | null
      readonly maximum: number | null
    }
  | {
      readonly kind: 'text'
    }
  | {
      readonly kind: 'checklist'
      readonly items: readonly {
        readonly itemId: string | null
        readonly label: string | null
      }[]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly {
        readonly variantId: string | null
        readonly label: string | null
        readonly unit: string | null
        readonly precision: 0 | 1 | 2 | 3 | null
        readonly target: string | null
      }[]
    }
export type DraftGoalCheckpointSatisfactionV1 =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'quantity'; readonly target: string | null }
  | {
      readonly kind: 'actual_time'
      readonly start: string | null
      readonly end: string | null
    }
  | { readonly kind: 'rating' }
  | { readonly kind: 'text' }
  | { readonly kind: 'checklist' }
  | { readonly kind: 'any_of' }
export type DraftGoalConfigV1 = {
  readonly schemaVersion: 1
  readonly scope: DraftGoalScopeV1
  readonly repetition: DraftGoalRepetitionV1
  readonly measurement: DraftGoalMeasurementV1
  readonly checkpoints: {
    readonly aggregation: 'independent' | 'all' | null
    readonly items: readonly {
      readonly checkpointId: string | null
      readonly name: string | null
      readonly deadline: string | null
      readonly satisfaction: DraftGoalCheckpointSatisfactionV1
    }[]
  } | null
}
export type SourceProvenanceV1 = {
  readonly schemaVersion: 1
  readonly sourceDocument: string
  readonly sourcePage: number
  readonly rawValue: string | null
  readonly rawDenominator: string | null
  readonly resolution: string
}

declare const goalConfigV1Brand: unique symbol
export type GoalScopeV1 =
  | { readonly kind: 'personal'; readonly ownerMemberId: string }
  | { readonly kind: 'shared' }
export type GoalRepetitionV1 =
  | { readonly kind: 'daily' }
  | {
      readonly kind: 'weekdays'
      readonly weekdays: readonly [Weekday, ...Weekday[]]
    }
  | { readonly kind: 'weekly'; readonly n: string }
  | { readonly kind: 'monthly'; readonly n: string }
  | { readonly kind: 'one_off'; readonly dueDate: string }
  | {
      readonly kind: 'weekly_planned_task'
      readonly weekOrdinal: '1' | '2' | '3' | '4' | '5'
      readonly taskText: string
    }
export type GoalMeasurementV1 =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'quantity'
      readonly mode: 'targeted'
      readonly unit: string
      readonly precision: 0 | 1 | 2 | 3
      readonly aggregation: 'add' | 'latest'
      readonly target: string
    }
  | {
      readonly kind: 'quantity'
      readonly mode: 'informational'
      readonly unit: string
      readonly precision: 0 | 1 | 2 | 3
      readonly aggregation: 'add' | 'latest'
      readonly target: null
    }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | {
      readonly kind: 'rating'
      readonly minimum: number
      readonly maximum: number
    }
  | { readonly kind: 'text' }
  | {
      readonly kind: 'checklist'
      readonly items: readonly [
        { readonly itemId: string; readonly label: string },
        ...{ readonly itemId: string; readonly label: string }[],
      ]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly [
        {
          readonly variantId: string
          readonly label: string
          readonly unit: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        },
        ...{
          readonly variantId: string
          readonly label: string
          readonly unit: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        }[],
      ]
    }
export type GoalCheckpointSatisfactionV1 =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'quantity'; readonly target: string }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | { readonly kind: 'rating' }
  | { readonly kind: 'text' }
  | { readonly kind: 'checklist' }
  | { readonly kind: 'any_of' }
export type GoalConfigV1 = {
  readonly schemaVersion: 1
  readonly scope: GoalScopeV1
  readonly repetition: GoalRepetitionV1
  readonly measurement: GoalMeasurementV1
  readonly checkpoints: {
    readonly aggregation: 'independent' | 'all'
    readonly items: readonly [
      {
        readonly checkpointId: string
        readonly name: string
        readonly deadline: string
        readonly satisfaction: GoalCheckpointSatisfactionV1
      },
      ...{
        readonly checkpointId: string
        readonly name: string
        readonly deadline: string
        readonly satisfaction: GoalCheckpointSatisfactionV1
      }[],
    ]
  } | null
  readonly [goalConfigV1Brand]: true
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u
const DATE = /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const MAX_COMPONENTS = 100

type RecordValue = Record<string, unknown>
type ComponentFamily = 'checklist' | 'any_of' | 'checkpoint'
type SnapshotOptions = {
  readonly mode: 'add' | 'update' | 'stored'
  readonly previousConfig?: DraftGoalConfigV1
  readonly generateId: () => string
}
type IdContext = {
  readonly options: SnapshotOptions
  readonly previous: ReadonlyMap<string, ComponentFamily>
  readonly allocated: Set<string>
}

function exact(
  value: unknown,
  alternatives: readonly (readonly string[])[],
): RecordValue {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CommandValidationError()
  }
  const ownKeys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        descriptors[key]?.get !== undefined ||
        descriptors[key]?.set !== undefined,
    )
  ) {
    throw new CommandValidationError()
  }
  const match = alternatives.some(
    (keys) =>
      ownKeys.length === keys.length &&
      ownKeys.every((key) => typeof key === 'string' && keys.includes(key)),
  )
  if (!match) throw new CommandValidationError()
  return value as RecordValue
}

function exactArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new CommandValidationError()
  }
  const ownKeys = Reflect.ownKeys(value)
  const expected = Array.from({ length: value.length }, (_, index) =>
    String(index),
  )
  expected.push('length')
  if (
    ownKeys.length !== expected.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new CommandValidationError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of expected) {
    const descriptor = descriptors[key]
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      throw new CommandValidationError()
    }
  }
  return value
}

function nullableString(
  value: unknown,
  maximum: number,
  requireNonWhitespace = true,
): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    [...value].length > maximum ||
    (requireNonWhitespace && !/\S/u.test(value))
  ) {
    throw new CommandValidationError()
  }
  return value
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (value === null) return null
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new CommandValidationError()
  }
  return value as T
}

function decimal(value: unknown, precision: number | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new CommandValidationError()
  }
  const scale = value.includes('.') ? value.length - value.indexOf('.') - 1 : 0
  if (precision !== null && scale > precision)
    throw new CommandValidationError()
  return value
}

function canonicalDate(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new CommandValidationError()
  }
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CommandValidationError()
  }
  return value
}

function canonicalTime(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !TIME.test(value)) {
    throw new CommandValidationError()
  }
  return value
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value)
}

function previousIds(
  config: DraftGoalConfigV1 | undefined,
): Map<string, ComponentFamily> {
  const result = new Map<string, ComponentFamily>()
  if (config?.measurement.kind === 'checklist') {
    for (const item of config.measurement.items) {
      if (item.itemId !== null) result.set(item.itemId, 'checklist')
    }
  }
  if (config?.measurement.kind === 'any_of') {
    for (const variant of config.measurement.variants) {
      if (variant.variantId !== null) result.set(variant.variantId, 'any_of')
    }
  }
  for (const checkpoint of config?.checkpoints?.items ?? []) {
    if (checkpoint.checkpointId !== null) {
      result.set(checkpoint.checkpointId, 'checkpoint')
    }
  }
  return result
}

function componentId(
  value: unknown,
  family: ComponentFamily,
  context: IdContext,
): string {
  if (value !== null && value !== undefined) {
    if (
      context.options.mode === 'stored' &&
      typeof value === 'string' &&
      UUID.test(value) &&
      !context.allocated.has(value)
    ) {
      context.allocated.add(value)
      return value
    }
    if (
      context.options.mode !== 'update' ||
      typeof value !== 'string' ||
      !UUID.test(value) ||
      context.previous.get(value) !== family ||
      context.allocated.has(value)
    ) {
      throw new CommandValidationError()
    }
    context.allocated.add(value)
    return value
  }
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const generated = context.options.generateId()
    if (
      UUID.test(generated) &&
      !context.previous.has(generated) &&
      !context.allocated.has(generated)
    ) {
      context.allocated.add(generated)
      return generated
    }
  }
  throw new CommandValidationError()
}

function scope(value: unknown): DraftGoalScopeV1 {
  const record = exact(value, [['kind'], ['kind', 'ownerMemberId']])
  const kind = record.kind
  if (kind === 'shared' && Reflect.ownKeys(record).length === 1) {
    return frozen({ kind })
  }
  if (kind === 'personal' && 'ownerMemberId' in record) {
    const ownerMemberId = record.ownerMemberId
    if (
      ownerMemberId !== null &&
      (typeof ownerMemberId !== 'string' || !UUID.test(ownerMemberId))
    ) {
      throw new CommandValidationError()
    }
    return frozen({ kind, ownerMemberId })
  }
  throw new CommandValidationError()
}

function repetition(value: unknown): DraftGoalRepetitionV1 {
  const record = exact(value, [
    ['kind'],
    ['kind', 'weekdays'],
    ['kind', 'n'],
    ['kind', 'dueDate'],
    ['kind', 'weekOrdinal', 'taskText'],
  ])
  switch (record.kind) {
    case 'daily':
      if (Reflect.ownKeys(record).length !== 1)
        throw new CommandValidationError()
      return frozen({ kind: 'daily' })
    case 'weekdays': {
      const values = exactArray(record.weekdays, 7).map((weekday) => {
        if (
          typeof weekday !== 'string' ||
          !WEEKDAYS.includes(weekday as Weekday)
        ) {
          throw new CommandValidationError()
        }
        return weekday as Weekday
      })
      for (let index = 1; index < values.length; index += 1) {
        if (
          WEEKDAYS.indexOf(values[index]!) <=
          WEEKDAYS.indexOf(values[index - 1]!)
        ) {
          throw new CommandValidationError()
        }
      }
      return frozen({ kind: 'weekdays', weekdays: frozen(values) })
    }
    case 'weekly':
    case 'monthly': {
      const n = record.n
      if (n !== null && (typeof n !== 'string' || !POSITIVE_INTEGER.test(n))) {
        throw new CommandValidationError()
      }
      return frozen({ kind: record.kind, n })
    }
    case 'one_off':
      return frozen({ kind: 'one_off', dueDate: canonicalDate(record.dueDate) })
    case 'weekly_planned_task':
      return frozen({
        kind: 'weekly_planned_task',
        weekOrdinal: enumValue(record.weekOrdinal, ['1', '2', '3', '4', '5']),
        taskText: nullableString(record.taskText, 500),
      })
    default:
      throw new CommandValidationError()
  }
}

function measurement(
  value: unknown,
  context: IdContext,
): DraftGoalMeasurementV1 {
  const record = exact(value, [
    ['kind'],
    ['kind', 'mode', 'unit', 'precision', 'aggregation', 'target'],
    ['kind', 'start', 'end'],
    ['kind', 'minimum', 'maximum'],
    ['kind', 'items'],
    ['kind', 'variants'],
  ])
  switch (record.kind) {
    case 'boolean':
    case 'text':
      if (Reflect.ownKeys(record).length !== 1)
        throw new CommandValidationError()
      return frozen({ kind: record.kind })
    case 'quantity': {
      const precision = record.precision
      if (
        precision !== null &&
        (!Number.isInteger(precision) ||
          ![0, 1, 2, 3].includes(precision as number))
      ) {
        throw new CommandValidationError()
      }
      return frozen({
        kind: 'quantity',
        mode: enumValue(record.mode, ['targeted', 'informational']),
        unit: nullableString(record.unit, 500),
        precision: precision as 0 | 1 | 2 | 3 | null,
        aggregation: enumValue(record.aggregation, ['add', 'latest']),
        target: decimal(record.target, precision as number | null),
      })
    }
    case 'actual_time':
      return frozen({
        kind: 'actual_time',
        start: canonicalTime(record.start),
        end: canonicalTime(record.end),
      })
    case 'rating': {
      const minimum = record.minimum
      const maximum = record.maximum
      if (
        (minimum !== null && !Number.isSafeInteger(minimum)) ||
        (maximum !== null && !Number.isSafeInteger(maximum))
      ) {
        throw new CommandValidationError()
      }
      return frozen({
        kind: 'rating',
        minimum: minimum as number | null,
        maximum: maximum as number | null,
      })
    }
    case 'checklist': {
      const items = exactArray(record.items, MAX_COMPONENTS).map((item) => {
        const row = exact(item, [['label'], ['itemId', 'label']])
        return frozen({
          itemId: componentId(row.itemId, 'checklist', context),
          label: nullableString(row.label, 500),
        })
      })
      return frozen({ kind: 'checklist', items: frozen(items) })
    }
    case 'any_of': {
      const variants = exactArray(record.variants, MAX_COMPONENTS).map(
        (variant) => {
          const row = exact(variant, [
            ['label', 'unit', 'precision', 'target'],
            ['variantId', 'label', 'unit', 'precision', 'target'],
          ])
          const precision = row.precision
          if (
            precision !== null &&
            (!Number.isInteger(precision) ||
              ![0, 1, 2, 3].includes(precision as number))
          ) {
            throw new CommandValidationError()
          }
          return frozen({
            variantId: componentId(row.variantId, 'any_of', context),
            label: nullableString(row.label, 500),
            unit: nullableString(row.unit, 500),
            precision: precision as 0 | 1 | 2 | 3 | null,
            target: decimal(row.target, precision as number | null),
          })
        },
      )
      return frozen({ kind: 'any_of', variants: frozen(variants) })
    }
    default:
      throw new CommandValidationError()
  }
}

function satisfaction(
  value: unknown,
  parentMeasurement: DraftGoalMeasurementV1,
): DraftGoalCheckpointSatisfactionV1 {
  const record = exact(value, [
    ['kind'],
    ['kind', 'target'],
    ['kind', 'start', 'end'],
  ])
  switch (record.kind) {
    case 'boolean':
    case 'rating':
    case 'text':
    case 'checklist':
    case 'any_of':
      if (Reflect.ownKeys(record).length !== 1)
        throw new CommandValidationError()
      return frozen({ kind: record.kind })
    case 'quantity':
      return frozen({
        kind: 'quantity',
        target: decimal(
          record.target,
          parentMeasurement.kind === 'quantity'
            ? parentMeasurement.precision
            : null,
        ),
      })
    case 'actual_time':
      return frozen({
        kind: 'actual_time',
        start: canonicalTime(record.start),
        end: canonicalTime(record.end),
      })
    default:
      throw new CommandValidationError()
  }
}

function checkpoints(
  value: unknown,
  context: IdContext,
  parentMeasurement: DraftGoalMeasurementV1,
): DraftGoalConfigV1['checkpoints'] {
  if (value === null) return null
  const record = exact(value, [['aggregation', 'items']])
  const aggregation = enumValue(record.aggregation, ['independent', 'all'])
  const items = exactArray(record.items, MAX_COMPONENTS).map((item) => {
    const row = exact(item, [
      ['name', 'deadline', 'satisfaction'],
      ['checkpointId', 'name', 'deadline', 'satisfaction'],
    ])
    return frozen({
      checkpointId: componentId(row.checkpointId, 'checkpoint', context),
      name: nullableString(row.name, 500),
      deadline: canonicalTime(row.deadline),
      satisfaction: satisfaction(row.satisfaction, parentMeasurement),
    })
  })
  return frozen({ aggregation, items: frozen(items) })
}

export function snapshotDraftGoalConfig(
  value: unknown,
  options: SnapshotOptions,
): DraftGoalConfigV1 {
  const record = exact(value, [
    ['schemaVersion', 'scope', 'repetition', 'measurement', 'checkpoints'],
  ])
  const schemaVersion = record.schemaVersion
  if (schemaVersion !== 1) throw new CommandValidationError()
  const context: IdContext = {
    options,
    previous: previousIds(options.previousConfig),
    allocated: new Set(),
  }
  const parsedMeasurement = measurement(record.measurement, context)
  const result = {
    schemaVersion,
    scope: scope(record.scope),
    repetition: repetition(record.repetition),
    measurement: parsedMeasurement,
    checkpoints: checkpoints(record.checkpoints, context, parsedMeasurement),
  } as const
  return frozen(result)
}

export function snapshotStoredDraftGoalConfig(
  value: unknown,
): DraftGoalConfigV1 {
  return snapshotDraftGoalConfig(value, {
    mode: 'stored',
    generateId: () => '',
  })
}

export function snapshotSourceProvenance(
  value: unknown,
): SourceProvenanceV1 | null {
  if (value === null) return null
  const record = exact(value, [
    [
      'schemaVersion',
      'sourceDocument',
      'sourcePage',
      'rawValue',
      'rawDenominator',
      'resolution',
    ],
  ])
  if (record.schemaVersion !== 1) throw new CommandValidationError()
  const sourceDocument = nullableString(record.sourceDocument, 500)
  const resolution = nullableString(record.resolution, 500)
  if (
    sourceDocument === null ||
    resolution === null ||
    !Number.isSafeInteger(record.sourcePage) ||
    (record.sourcePage as number) <= 0
  ) {
    throw new CommandValidationError()
  }
  return frozen({
    schemaVersion: 1,
    sourceDocument,
    sourcePage: record.sourcePage as number,
    rawValue: nullableString(record.rawValue, 2_000, false),
    rawDenominator: nullableString(record.rawDenominator, 2_000, false),
    resolution,
  })
}

function signature(config: DraftGoalConfigV1): string {
  const measurementSignature = (() => {
    const value = config.measurement
    switch (value.kind) {
      case 'quantity':
        return [
          value.kind,
          value.mode,
          value.unit,
          value.precision,
          value.aggregation,
        ]
      case 'checklist':
        return [value.kind, ...value.items.map((item) => item.itemId).sort()]
      case 'any_of':
        return [
          value.kind,
          ...value.variants
            .map((variant) => [
              variant.variantId,
              variant.unit,
              variant.precision,
            ])
            .sort((left, right) =>
              String(left[0]) < String(right[0])
                ? -1
                : String(left[0]) > String(right[0])
                  ? 1
                  : 0,
            ),
        ]
      default:
        return [value.kind]
    }
  })()
  const checkpointSignature =
    config.checkpoints === null
      ? null
      : [
          config.checkpoints.aggregation,
          ...config.checkpoints.items
            .map((item) => [item.checkpointId, item.satisfaction.kind])
            .sort((left, right) =>
              String(left[0]) < String(right[0])
                ? -1
                : String(left[0]) > String(right[0])
                  ? 1
                  : 0,
            ),
        ]
  return JSON.stringify([
    config.scope.kind,
    config.scope.kind === 'personal' ? config.scope.ownerMemberId : null,
    measurementSignature,
    checkpointSignature,
  ])
}

export function draftGoalSeriesDecision(
  before: DraftGoalConfigV1,
  after: DraftGoalConfigV1,
): 'continue' | 'new' {
  return signature(before) === signature(after) ? 'continue' : 'new'
}

export function isPositiveDecimal(value: string): boolean {
  return DECIMAL.test(value) && /[1-9]/u.test(value.replace('.', ''))
}
