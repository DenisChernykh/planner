import type { OpenAPIObject } from '@nestjs/swagger'

import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

import { CANONICAL_TRACKING_MONTH_PATTERN } from './tracking-query.dto'

function installTrackingSchemas(document: OpenAPIObject): void {
  const schemas = ((document.components ??= {}).schemas ??=
    {}) as unknown as Record<string, unknown>
  const uuid = {
    type: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  }
  const date = {
    type: 'string',
    format: 'date',
    pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$',
  }
  const nonnegative = { type: 'string', pattern: '^(?:0|[1-9][0-9]*)$' }
  const positive = { type: 'string', pattern: '^[1-9][0-9]*$' }
  const decimal = {
    type: 'string',
    pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
  }
  const nullableUuid = { ...uuid, nullable: true }
  const object = (
    properties: Record<string, unknown>,
    required: readonly string[],
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  })
  const ref = (name: string): Record<string, unknown> => ({
    $ref: `#/components/schemas/${name}`,
  })
  const oneOf = (
    names: readonly string[],
    discriminator?: string,
  ): Record<string, unknown> => ({
    oneOf: names.map(ref),
    ...(discriminator === undefined
      ? {}
      : { discriminator: { propertyName: discriminator } }),
  })

  schemas['TrackingExactRatioV1'] = object(
    { numerator: nonnegative, denominator: positive },
    ['numerator', 'denominator'],
  )
  schemas['TrackingAvailableMetricV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      exact: ref('TrackingExactRatioV1'),
      basisPoints: nonnegative,
    },
    ['available', 'exact', 'basisPoints'],
  )
  schemas['TrackingUnavailableMetricV1'] = object(
    {
      available: { type: 'boolean', enum: [false] },
      exact: { enum: [null] },
      basisPoints: { enum: [null] },
      reason: {
        type: 'string',
        enum: ['informational', 'no_applicable_units'],
      },
    },
    ['available', 'exact', 'basisPoints', 'reason'],
  )
  schemas['TrackingEvaluationMetricV1'] = oneOf([
    'TrackingAvailableMetricV1',
    'TrackingUnavailableMetricV1',
  ])
  schemas['TrackingCoverageV1'] = object(
    { filled: nonnegative, applicable: nonnegative },
    ['filled', 'applicable'],
  )
  schemas['TrackingScoreContributionV1'] = object(
    {
      score: {
        oneOf: [ref('TrackingExactRatioV1'), { enum: [null] }],
      },
      coverage: ref('TrackingCoverageV1'),
    },
    ['score', 'coverage'],
  )
  schemas['TrackingFlexiblePeriodProgressV1'] = object(
    {
      periodStart: date,
      periodEnd: date,
      periodTarget: nonnegative,
      actualEquivalentOccurrences: ref('TrackingExactRatioV1'),
      creditedOccurrences: ref('TrackingExactRatioV1'),
      overperformanceOccurrences: ref('TrackingExactRatioV1'),
    },
    [
      'periodStart',
      'periodEnd',
      'periodTarget',
      'actualEquivalentOccurrences',
      'creditedOccurrences',
      'overperformanceOccurrences',
    ],
  )
  schemas['TrackingGoalProgressV1'] = object(
    {
      formulaVersions: object(
        {
          calendar: {
            type: 'string',
            enum: ['planner.calendar-targets.v1'],
          },
          evaluation: {
            type: 'string',
            enum: ['planner.goal-evaluation.v1'],
          },
        },
        ['calendar', 'evaluation'],
      ),
      progress: ref('TrackingEvaluationMetricV1'),
      score: ref('TrackingEvaluationMetricV1'),
      overperformance: ref('TrackingEvaluationMetricV1'),
      coverage: ref('TrackingCoverageV1'),
      contribution: ref('TrackingScoreContributionV1'),
      periods: {
        type: 'array',
        maxItems: 6,
        items: ref('TrackingFlexiblePeriodProgressV1'),
      },
    },
    [
      'formulaVersions',
      'progress',
      'score',
      'overperformance',
      'coverage',
      'contribution',
      'periods',
    ],
  )

  const factValues: Record<string, unknown> = {
    TrackingBooleanFactValueV1: object(
      {
        kind: { type: 'string', enum: ['boolean'] },
        result: { type: 'string', enum: ['done', 'not_done'] },
      },
      ['kind', 'result'],
    ),
    TrackingQuantityFactValueV1: object(
      {
        kind: { type: 'string', enum: ['quantity'] },
        value: decimal,
      },
      ['kind', 'value'],
    ),
    TrackingTimeFactValueV1: object(
      {
        kind: { type: 'string', enum: ['actual_time'] },
        value: {
          type: 'string',
          pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
        },
      },
      ['kind', 'value'],
    ),
    TrackingRatingFactValueV1: object(
      {
        kind: { type: 'string', enum: ['rating'] },
        value: {
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991,
        },
      },
      ['kind', 'value'],
    ),
    TrackingTextFactValueV1: object(
      {
        kind: { type: 'string', enum: ['text'] },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        result: { type: 'string', enum: ['done', 'not_done'] },
      },
      ['kind', 'text', 'result'],
    ),
    TrackingChecklistFactValueV1: object(
      {
        kind: { type: 'string', enum: ['checklist_item'] },
        state: { type: 'string', enum: ['done', 'not_done'] },
      },
      ['kind', 'state'],
    ),
    TrackingOrFactValueV1: object(
      {
        kind: { type: 'string', enum: ['or_variant'] },
        value: decimal,
      },
      ['kind', 'value'],
    ),
  }
  Object.assign(schemas, factValues)
  schemas['TrackingFactValueV1'] = oneOf(Object.keys(factValues), 'kind')
  schemas['TrackingFactReadV1'] = object(
    {
      factRecordId: uuid,
      revision: positive,
      factKind: {
        type: 'string',
        enum: [
          'boolean',
          'quantity_add',
          'quantity_latest',
          'actual_time',
          'rating',
          'text',
          'checklist_item',
          'or_variant',
        ],
      },
      contributionId: nullableUuid,
      checklistItemId: nullableUuid,
      orVariantId: nullableUuid,
      revisionKind: { type: 'string', enum: ['recorded', 'tombstoned'] },
      value: { oneOf: [ref('TrackingFactValueV1'), { enum: [null] }] },
      recordedByMemberId: uuid,
    },
    [
      'factRecordId',
      'revision',
      'factKind',
      'contributionId',
      'checklistItemId',
      'orVariantId',
      'revisionKind',
      'value',
      'recordedByMemberId',
    ],
  )
  const state = {
    type: 'string',
    enum: ['no_data', 'partial', 'done', 'not_done'],
  }
  const facts = {
    type: 'array',
    maxItems: 10000,
    items: ref('TrackingFactReadV1'),
  }
  schemas['TrackingFixedExpectationV1'] = object(
    {
      fixedExpectationId: uuid,
      componentKind: {
        type: 'string',
        enum: ['goal', 'checkpoint', 'checklist_item'],
      },
      componentId: nullableUuid,
      state,
      facts,
    },
    ['fixedExpectationId', 'componentKind', 'componentId', 'state', 'facts'],
  )
  schemas['TrackingFlexiblePeriodV1'] = object(
    {
      flexiblePeriodId: uuid,
      periodKind: {
        type: 'string',
        enum: ['weekly', 'monthly', 'weekly_planned_task'],
      },
      ordinal: { type: 'integer', minimum: 1, maximum: 6 },
      periodStart: date,
      periodEnd: date,
      periodTarget: { type: 'integer', minimum: 0 },
      eligibleOnDate: { type: 'boolean' },
      expectedProgress: {
        oneOf: [{ type: 'integer', minimum: 0 }, { enum: [null] }],
      },
      actualProgress: {
        oneOf: [ref('TrackingExactRatioV1'), { enum: [null] }],
      },
      state,
      facts,
    },
    [
      'flexiblePeriodId',
      'periodKind',
      'ordinal',
      'periodStart',
      'periodEnd',
      'periodTarget',
      'eligibleOnDate',
      'expectedProgress',
      'actualProgress',
      'state',
      'facts',
    ],
  )
  const dayState = {
    type: 'string',
    enum: ['future', 'not_applicable', 'no_data', 'partial', 'filled'],
  }
  schemas['TrackingDayGoalV1'] = object(
    {
      planGoalSnapshotId: uuid,
      applicable: { type: 'boolean' },
      writable: { type: 'boolean' },
      state: dayState,
      coverage: ref('TrackingCoverageV1'),
      progress: ref('TrackingGoalProgressV1'),
      fixedExpectations: {
        type: 'array',
        maxItems: 10000,
        items: ref('TrackingFixedExpectationV1'),
      },
      flexiblePeriods: {
        type: 'array',
        maxItems: 6,
        items: ref('TrackingFlexiblePeriodV1'),
      },
    },
    [
      'planGoalSnapshotId',
      'applicable',
      'writable',
      'state',
      'coverage',
      'progress',
      'fixedExpectations',
      'flexiblePeriods',
    ],
  )
  schemas['TrackingDayReadV1'] = object(
    {
      localDate: date,
      state: dayState,
      coverage: ref('TrackingCoverageV1'),
      goals: {
        type: 'array',
        maxItems: 200,
        items: ref('TrackingDayGoalV1'),
      },
    },
    ['localDate', 'state', 'coverage', 'goals'],
  )
  schemas['TrackingGoalReadV1'] = object(
    {
      planGoalSnapshotId: uuid,
      sourceGoalSeriesId: uuid,
      title: { type: 'string', minLength: 1, maxLength: 200 },
      why: { type: 'string', minLength: 1, maxLength: 2000 },
      category: { type: 'string', minLength: 1, maxLength: 100 },
      displayOrder: { type: 'integer', minimum: 0, maximum: 199 },
      config: ref('PublishedGoalConfigV1'),
      calendar: ref('EligibleCalendarV1'),
      viewerAccess: {
        type: 'string',
        enum: ['personal_owner', 'shared', 'partner_read_only'],
      },
      progress: ref('TrackingGoalProgressV1'),
    },
    [
      'planGoalSnapshotId',
      'sourceGoalSeriesId',
      'title',
      'why',
      'category',
      'displayOrder',
      'config',
      'calendar',
      'viewerAccess',
      'progress',
    ],
  )

  const base = {
    queryLocalDate: date,
    targetMonth: {
      type: 'string',
      pattern: CANONICAL_TRACKING_MONTH_PATTERN,
    },
  }
  const draftFields = {
    ...base,
    state: { type: 'string', enum: ['draft'] },
    planMonthId: uuid,
    lifecycleRevision: positive,
    draftRevision: positive,
    focus: { type: 'string', minLength: 1, maxLength: 500 },
  }
  const publishedFields = {
    ...base,
    state: { type: 'string', enum: ['published'] },
    planMonthId: uuid,
    lifecycleRevision: positive,
    factsRevision: nonnegative,
    monthStatus: { type: 'string', enum: ['published', 'grace', 'closed'] },
    phase: { type: 'string', enum: ['future', 'active', 'grace', 'closed'] },
    publicationId: uuid,
    publicationRevision: positive,
    activeLocalDate: date,
    latePublication: { type: 'boolean' },
    focus: { type: 'string', minLength: 1, maxLength: 500 },
    goals: {
      type: 'array',
      maxItems: 200,
      items: ref('TrackingGoalReadV1'),
    },
  }
  const publishedRequired = [
    'schemaVersion',
    'queryLocalDate',
    'targetMonth',
    'state',
    'planMonthId',
    'lifecycleRevision',
    'factsRevision',
    'monthStatus',
    'phase',
    'publicationId',
    'publicationRevision',
    'activeLocalDate',
    'latePublication',
    'focus',
    'goals',
  ]
  for (const [prefix, schemaVersion] of [
    ['TrackingMonth', 'tracking.month.v1'],
    ['TrackingToday', 'tracking.today.v1'],
  ] as const) {
    schemas[`${prefix}NoPlanV1`] = object(
      {
        schemaVersion: { type: 'string', enum: [schemaVersion] },
        ...base,
        state: { type: 'string', enum: ['no_plan'] },
      },
      ['schemaVersion', 'queryLocalDate', 'targetMonth', 'state'],
    )
    schemas[`${prefix}DraftV1`] = object(
      {
        schemaVersion: { type: 'string', enum: [schemaVersion] },
        ...draftFields,
      },
      [
        'schemaVersion',
        'queryLocalDate',
        'targetMonth',
        'state',
        'planMonthId',
        'lifecycleRevision',
        'draftRevision',
        'focus',
      ],
    )
  }
  schemas['TrackingMonthPublishedV1'] = object(
    {
      schemaVersion: { type: 'string', enum: ['tracking.month.v1'] },
      ...publishedFields,
      days: {
        type: 'array',
        minItems: 28,
        maxItems: 31,
        items: ref('TrackingDayReadV1'),
      },
    },
    [...publishedRequired, 'days'],
  )
  schemas['TrackingTodayPublishedV1'] = object(
    {
      schemaVersion: { type: 'string', enum: ['tracking.today.v1'] },
      ...publishedFields,
      day: ref('TrackingDayReadV1'),
    },
    [...publishedRequired, 'day'],
  )
  schemas['TrackingMonthResponseV1'] = oneOf(
    [
      'TrackingMonthNoPlanV1',
      'TrackingMonthDraftV1',
      'TrackingMonthPublishedV1',
    ],
    'state',
  )
  schemas['TrackingTodayResponseV1'] = oneOf(
    [
      'TrackingTodayNoPlanV1',
      'TrackingTodayDraftV1',
      'TrackingTodayPublishedV1',
    ],
    'state',
  )
}

export const TRACKING_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'tracking',
      description: 'Channel-neutral Today and Month tracking read models.',
    },
  ],
  install: installTrackingSchemas,
}
