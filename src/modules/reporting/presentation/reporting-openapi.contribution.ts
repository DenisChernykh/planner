import type { OpenAPIObject } from '@nestjs/swagger'

import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

function installReportingSchemas(document: OpenAPIObject): void {
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

  schemas['ReportingExactRatioV1'] = object(
    {
      numerator: nonnegative,
      denominator: { ...nonnegative, pattern: '^[1-9][0-9]*$' },
    },
    ['numerator', 'denominator'],
  )
  schemas['ReportingAvailableMetricV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      exact: ref('ReportingExactRatioV1'),
      basisPoints: nonnegative,
    },
    ['available', 'exact', 'basisPoints'],
  )
  schemas['ReportingUnavailableMetricV1'] = object(
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
  schemas['ReportingMetricV1'] = {
    oneOf: [
      ref('ReportingAvailableMetricV1'),
      ref('ReportingUnavailableMetricV1'),
    ],
  }
  schemas['ReportingAvailableAggregateMetricV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      exact: ref('ReportingExactRatioV1'),
      basisPoints: nonnegative,
    },
    ['available', 'exact', 'basisPoints'],
  )
  schemas['ReportingUnavailableAggregateMetricV1'] = object(
    {
      available: { type: 'boolean', enum: [false] },
      exact: { enum: [null] },
      basisPoints: { enum: [null] },
      reason: { type: 'string', enum: ['no_scored_goals', 'no_fixed_units'] },
    },
    ['available', 'exact', 'basisPoints', 'reason'],
  )
  schemas['ReportingAggregateMetricV1'] = {
    oneOf: [
      ref('ReportingAvailableAggregateMetricV1'),
      ref('ReportingUnavailableAggregateMetricV1'),
    ],
  }
  schemas['ReportingHeatmapPointV1'] = object(
    {
      localDate: date,
      state: {
        type: 'string',
        enum: ['done', 'not_done', 'no_data', 'not_applicable'],
      },
    },
    ['localDate', 'state'],
  )
  const seriesPoint = (
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    object(
      {
        localDate: date,
        componentId: { ...uuid, nullable: true },
        value,
      },
      ['localDate', 'componentId', 'value'],
    )
  schemas['ReportingQuantitySeriesPointV1'] = seriesPoint({
    type: 'string',
    pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
  })
  schemas['ReportingActualTimeSeriesPointV1'] = seriesPoint({
    type: 'string',
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
  })
  schemas['ReportingRatingSeriesPointV1'] = seriesPoint({
    type: 'integer',
  })
  schemas['ReportingGoalSeriesV1'] = object(
    {
      heatmap: {
        type: 'array',
        maxItems: 31,
        items: ref('ReportingHeatmapPointV1'),
      },
      cumulativeQuantity: {
        oneOf: [
          { type: 'array', items: ref('ReportingQuantitySeriesPointV1') },
          { enum: [null] },
        ],
      },
      actualTime: {
        oneOf: [
          { type: 'array', items: ref('ReportingActualTimeSeriesPointV1') },
          { enum: [null] },
        ],
      },
      rating: {
        oneOf: [
          { type: 'array', items: ref('ReportingRatingSeriesPointV1') },
          { enum: [null] },
        ],
      },
    },
    ['heatmap', 'cumulativeQuantity', 'actualTime', 'rating'],
  )
  schemas['ReportingEvaluationMeasurementV1'] = {
    oneOf: [
      object({ kind: { type: 'string', enum: ['boolean'] } }, ['kind']),
      object(
        {
          kind: { type: 'string', enum: ['quantity'] },
          mode: { type: 'string', enum: ['targeted', 'informational'] },
          precision: { type: 'integer', enum: [0, 1, 2, 3] },
          aggregation: { type: 'string', enum: ['add', 'latest'] },
          target: { oneOf: [{ type: 'string' }, { enum: [null] }] },
        },
        ['kind', 'mode', 'precision', 'aggregation', 'target'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['actual_time'] },
          start: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          end: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        },
        ['kind', 'start', 'end'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['rating'] },
          minimum: { type: 'integer' },
          maximum: { type: 'integer' },
        },
        ['kind', 'minimum', 'maximum'],
      ),
      object({ kind: { type: 'string', enum: ['text'] } }, ['kind']),
      object(
        {
          kind: { type: 'string', enum: ['checklist'] },
          items: {
            type: 'array',
            minItems: 1,
            items: object({ itemId: { type: 'string' } }, ['itemId']),
          },
        },
        ['kind', 'items'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['any_of'] },
          variants: {
            type: 'array',
            minItems: 1,
            items: object(
              {
                variantId: { type: 'string' },
                precision: { type: 'integer', enum: [0, 1, 2, 3] },
                target: { type: 'string' },
              },
              ['variantId', 'precision', 'target'],
            ),
          },
        },
        ['kind', 'variants'],
      ),
    ],
  }
  schemas['ReportingCheckpointSatisfactionV1'] = {
    oneOf: [
      object({ kind: { type: 'string', enum: ['boolean'] } }, ['kind']),
      object(
        {
          kind: { type: 'string', enum: ['quantity'] },
          target: { type: 'string' },
        },
        ['kind', 'target'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['actual_time'] },
          start: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          end: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        },
        ['kind', 'start', 'end'],
      ),
      object({ kind: { type: 'string', enum: ['rating'] } }, ['kind']),
      object({ kind: { type: 'string', enum: ['text'] } }, ['kind']),
      object({ kind: { type: 'string', enum: ['checklist'] } }, ['kind']),
      object({ kind: { type: 'string', enum: ['any_of'] } }, ['kind']),
    ],
  }
  schemas['ReportingGoalFactValueV1'] = {
    oneOf: [
      object(
        {
          kind: { type: 'string', enum: ['boolean'] },
          result: { type: 'string', enum: ['done', 'not_done'] },
        },
        ['kind', 'result'],
      ),
      object({ kind: { type: 'string', enum: ['not_done'] } }, ['kind']),
      object(
        {
          kind: { type: 'string', enum: ['quantity_add'] },
          contributions: {
            type: 'array',
            minItems: 1,
            items: object(
              { contributionId: { type: 'string' }, value: { type: 'string' } },
              ['contributionId', 'value'],
            ),
          },
        },
        ['kind', 'contributions'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['quantity_latest'] },
          value: { type: 'string' },
        },
        ['kind', 'value'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['actual_time'] },
          value: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        },
        ['kind', 'value'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['rating'] },
          value: { type: 'integer' },
        },
        ['kind', 'value'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
          result: { type: 'string', enum: ['done', 'not_done'] },
        },
        ['kind', 'text', 'result'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['checklist'] },
          items: {
            type: 'array',
            items: object(
              {
                itemId: { type: 'string' },
                state: { type: 'string', enum: ['done', 'not_done'] },
              },
              ['itemId', 'state'],
            ),
          },
        },
        ['kind', 'items'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['any_of'] },
          variants: {
            type: 'array',
            items: object(
              { variantId: { type: 'string' }, value: { type: 'string' } },
              ['variantId', 'value'],
            ),
          },
        },
        ['kind', 'variants'],
      ),
    ],
  }
  schemas['ReportingGoalEvaluationFactV1'] = {
    oneOf: [
      object(
        {
          kind: { type: 'string', enum: ['fixed'] },
          expectationDate: date,
          value: { oneOf: [ref('ReportingGoalFactValueV1')] },
        },
        ['kind', 'expectationDate', 'value'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['fixed_checkpoints'] },
          expectationDate: date,
          checkpoints: {
            type: 'array',
            items: object(
              {
                checkpointId: { type: 'string' },
                value: ref('ReportingGoalFactValueV1'),
              },
              ['checkpointId', 'value'],
            ),
          },
        },
        ['kind', 'expectationDate', 'checkpoints'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['quota_occurrence'] },
          localDate: date,
          value: ref('ReportingGoalFactValueV1'),
        },
        ['kind', 'localDate', 'value'],
      ),
      object(
        {
          kind: { type: 'string', enum: ['weekly_planned_task'] },
          periodStart: date,
          periodEnd: date,
          result: { type: 'string', enum: ['done', 'not_done'] },
        },
        ['kind', 'periodStart', 'periodEnd', 'result'],
      ),
    ],
  }
  schemas['ReportingFactTargetFixedV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      kind: { type: 'string', enum: ['fixed'] },
      units: {
        type: 'array',
        items: object(
          {
            localDate: date,
            componentId: { ...uuid, nullable: true },
            fact: {
              oneOf: [ref('ReportingGoalFactValueV1'), { enum: [null] }],
            },
            target: object(
              {
                measurement: ref('ReportingEvaluationMeasurementV1'),
                satisfaction: {
                  oneOf: [
                    ref('ReportingCheckpointSatisfactionV1'),
                    { enum: [null] },
                  ],
                },
              },
              ['measurement', 'satisfaction'],
            ),
          },
          ['localDate', 'componentId', 'fact', 'target'],
        ),
      },
    },
    ['available', 'kind', 'units'],
  )
  schemas['ReportingFactTargetFlexibleV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      kind: { type: 'string', enum: ['flexible'] },
      periods: {
        type: 'array',
        items: object(
          {
            periodStart: date,
            periodEnd: date,
            fact: ref('ReportingExactRatioV1'),
            target: { type: 'string' },
          },
          ['periodStart', 'periodEnd', 'fact', 'target'],
        ),
      },
    },
    ['available', 'kind', 'periods'],
  )
  schemas['ReportingFactTargetWeeklyTaskV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      kind: { type: 'string', enum: ['weekly_planned_task'] },
      periods: {
        type: 'array',
        items: object(
          {
            periodStart: date,
            periodEnd: date,
            fact: { type: 'string', enum: ['done', 'not_done', 'no_data'] },
            target: { type: 'string', enum: ['done'] },
          },
          ['periodStart', 'periodEnd', 'fact', 'target'],
        ),
      },
    },
    ['available', 'kind', 'periods'],
  )
  schemas['ReportingFactTargetInformationalQuantityV1'] = object(
    {
      available: { type: 'boolean', enum: [true] },
      kind: { type: 'string', enum: ['informational_quantity'] },
      fact: { type: 'array', items: ref('ReportingGoalEvaluationFactV1') },
      measurement: object(
        {
          kind: { type: 'string', enum: ['quantity'] },
          mode: { type: 'string', enum: ['informational'] },
          precision: { type: 'integer', enum: [0, 1, 2, 3] },
          aggregation: { type: 'string', enum: ['add', 'latest'] },
          target: { enum: [null] },
        },
        ['kind', 'mode', 'precision', 'aggregation', 'target'],
      ),
      target: { enum: [null] },
    },
    ['available', 'kind', 'fact', 'measurement', 'target'],
  )
  schemas['ReportingFactTargetNotApplicableV1'] = object(
    {
      available: { type: 'boolean', enum: [false] },
      kind: { type: 'string', enum: ['not_applicable'] },
      fact: { enum: [null] },
      target: { enum: [null] },
      reason: { type: 'string', enum: ['no_applicable_units'] },
    },
    ['available', 'kind', 'fact', 'target', 'reason'],
  )
  schemas['ReportingFactTargetV1'] = {
    oneOf: [
      ref('ReportingFactTargetFixedV1'),
      ref('ReportingFactTargetFlexibleV1'),
      ref('ReportingFactTargetWeeklyTaskV1'),
      ref('ReportingFactTargetInformationalQuantityV1'),
      ref('ReportingFactTargetNotApplicableV1'),
    ],
  }
  schemas['ReportingPilotGoalV1'] = object(
    {
      planGoalSnapshotId: uuid,
      title: { type: 'string' },
      displayOrder: { type: 'integer', minimum: 0 },
      goalScore: ref('ReportingMetricV1'),
      progressPercent: ref('ReportingMetricV1'),
      factTarget: ref('ReportingFactTargetV1'),
      coverage: object({ filled: nonnegative, applicable: nonnegative }, [
        'filled',
        'applicable',
      ]),
      overperformance: ref('ReportingMetricV1'),
      series: ref('ReportingGoalSeriesV1'),
    },
    [
      'planGoalSnapshotId',
      'title',
      'displayOrder',
      'goalScore',
      'progressPercent',
      'factTarget',
      'coverage',
      'overperformance',
      'series',
    ],
  )
  schemas['ReportingPilotSectionV1'] = object(
    {
      kind: { type: 'string', enum: ['personal', 'shared'] },
      ownerMemberId: { ...uuid, nullable: true },
      monthScore: ref('ReportingAggregateMetricV1'),
      coverage: ref('ReportingAggregateMetricV1'),
      goals: { type: 'array', items: ref('ReportingPilotGoalV1') },
    },
    ['kind', 'ownerMemberId', 'monthScore', 'coverage', 'goals'],
  )
  schemas['ReportingPilotSourceV1'] = object(
    {
      spaceId: uuid,
      planMonthId: uuid,
      publicationId: uuid,
      publicationRevision: nonnegative,
      factsRevision: nonnegative,
      asOfLocalDate: date,
      formulaVersions: object(
        {
          calendar: { type: 'string', enum: ['planner.calendar-targets.v1'] },
          evaluation: { type: 'string', enum: ['planner.goal-evaluation.v1'] },
          scoreCoverage: {
            type: 'string',
            enum: ['planner.score-coverage.v1'],
          },
        },
        ['calendar', 'evaluation', 'scoreCoverage'],
      ),
    },
    [
      'spaceId',
      'planMonthId',
      'publicationId',
      'publicationRevision',
      'factsRevision',
      'asOfLocalDate',
      'formulaVersions',
    ],
  )
  schemas['PilotReportReadResponseV1'] = object(
    {
      schemaVersion: {
        type: 'string',
        enum: ['reporting.pilot-report-read.v1'],
      },
      status: { type: 'string', enum: ['current', 'preliminary', 'closed'] },
      source: ref('ReportingPilotSourceV1'),
      sections: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: ref('ReportingPilotSectionV1'),
      },
    },
    ['schemaVersion', 'status', 'source', 'sections'],
  )
}

export const REPORTING_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'reporting',
      description: 'Current, preliminary and closed pilot report read models.',
    },
  ],
  install: installReportingSchemas,
}
