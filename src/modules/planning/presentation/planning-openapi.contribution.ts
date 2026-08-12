import type { OpenAPIObject } from '@nestjs/swagger'

import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

function installPlanningGoalSchemas(document: OpenAPIObject): void {
  const schemas = ((document.components ??= {}).schemas ??=
    {}) as unknown as Record<string, unknown>
  const uuid = {
    type: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  }
  const nullableString = (
    schema: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: 'string',
    nullable: true,
    ...schema,
  })
  const object = (
    properties: Record<string, unknown>,
    required: readonly string[],
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  })
  const discriminator = (
    names: readonly string[],
    mapping: Record<string, string>,
  ): Record<string, unknown> => ({
    oneOf: names.map((name) => ({ $ref: `#/components/schemas/${name}` })),
    discriminator: { propertyName: 'kind', mapping },
  })
  schemas['PersonalGoalScopeV1'] = object(
    {
      kind: { type: 'string', enum: ['personal'] },
      ownerMemberId: { ...uuid, nullable: true },
    },
    ['kind', 'ownerMemberId'],
  )
  schemas['SharedGoalScopeV1'] = object(
    { kind: { type: 'string', enum: ['shared'] } },
    ['kind'],
  )
  schemas['DraftGoalScopeV1'] = discriminator(
    ['PersonalGoalScopeV1', 'SharedGoalScopeV1'],
    {
      personal: '#/components/schemas/PersonalGoalScopeV1',
      shared: '#/components/schemas/SharedGoalScopeV1',
    },
  )
  const repetitionSchemas: Record<string, unknown> = {
    DailyRepetitionV1: object({ kind: { type: 'string', enum: ['daily'] } }, [
      'kind',
    ]),
    WeekdaysRepetitionV1: object(
      {
        kind: { type: 'string', enum: ['weekdays'] },
        weekdays: {
          type: 'array',
          maxItems: 7,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          },
        },
      },
      ['kind', 'weekdays'],
    ),
    WeeklyRepetitionV1: object(
      {
        kind: { type: 'string', enum: ['weekly'] },
        n: nullableString({ pattern: '^[1-9][0-9]*$' }),
      },
      ['kind', 'n'],
    ),
    MonthlyRepetitionV1: object(
      {
        kind: { type: 'string', enum: ['monthly'] },
        n: nullableString({ pattern: '^[1-9][0-9]*$' }),
      },
      ['kind', 'n'],
    ),
    OneOffRepetitionV1: object(
      {
        kind: { type: 'string', enum: ['one_off'] },
        dueDate: nullableString({
          format: 'date',
          pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$',
        }),
      },
      ['kind', 'dueDate'],
    ),
    WeeklyPlannedTaskRepetitionV1: object(
      {
        kind: { type: 'string', enum: ['weekly_planned_task'] },
        weekOrdinal: nullableString({ enum: ['1', '2', '3', '4', '5'] }),
        taskText: nullableString({ pattern: '\\S', maxLength: 500 }),
      },
      ['kind', 'weekOrdinal', 'taskText'],
    ),
  }
  Object.assign(schemas, repetitionSchemas)
  schemas['DraftGoalRepetitionV1'] = discriminator(
    Object.keys(repetitionSchemas),
    {
      daily: '#/components/schemas/DailyRepetitionV1',
      weekdays: '#/components/schemas/WeekdaysRepetitionV1',
      weekly: '#/components/schemas/WeeklyRepetitionV1',
      monthly: '#/components/schemas/MonthlyRepetitionV1',
      one_off: '#/components/schemas/OneOffRepetitionV1',
      weekly_planned_task: '#/components/schemas/WeeklyPlannedTaskRepetitionV1',
    },
  )
  schemas['UpdateChecklistItemV1'] = object(
    {
      itemId: { ...uuid, nullable: true },
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
    },
    ['label'],
  )
  schemas['UpdateAnyOfVariantV1'] = object(
    {
      variantId: { ...uuid, nullable: true },
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
      unit: nullableString({ pattern: '\\S', maxLength: 500 }),
      precision: {
        type: 'integer',
        enum: [0, 1, 2, 3],
        nullable: true,
      },
      target: nullableString({ pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' }),
    },
    ['label', 'unit', 'precision', 'target'],
  )
  const measurementSchemas: Record<string, unknown> = {
    BooleanMeasurementV1: object(
      { kind: { type: 'string', enum: ['boolean'] } },
      ['kind'],
    ),
    QuantityMeasurementV1: object(
      {
        kind: { type: 'string', enum: ['quantity'] },
        mode: {
          type: 'string',
          enum: ['targeted', 'informational'],
          nullable: true,
        },
        unit: nullableString({ pattern: '\\S', maxLength: 500 }),
        precision: {
          type: 'integer',
          enum: [0, 1, 2, 3],
          nullable: true,
        },
        aggregation: {
          type: 'string',
          enum: ['add', 'latest'],
          nullable: true,
        },
        target: nullableString({
          pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
        }),
      },
      ['kind', 'mode', 'unit', 'precision', 'aggregation', 'target'],
    ),
    ActualTimeMeasurementV1: object(
      {
        kind: { type: 'string', enum: ['actual_time'] },
        start: nullableString({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
        end: nullableString({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
      },
      ['kind', 'start', 'end'],
    ),
    RatingMeasurementV1: object(
      {
        kind: { type: 'string', enum: ['rating'] },
        minimum: {
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991,
          nullable: true,
        },
        maximum: {
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991,
          nullable: true,
        },
      },
      ['kind', 'minimum', 'maximum'],
    ),
    TextMeasurementV1: object({ kind: { type: 'string', enum: ['text'] } }, [
      'kind',
    ]),
    UpdateChecklistMeasurementV1: object(
      {
        kind: { type: 'string', enum: ['checklist'] },
        items: {
          type: 'array',
          maxItems: 100,
          items: { $ref: '#/components/schemas/UpdateChecklistItemV1' },
        },
      },
      ['kind', 'items'],
    ),
    UpdateAnyOfMeasurementV1: object(
      {
        kind: { type: 'string', enum: ['any_of'] },
        variants: {
          type: 'array',
          maxItems: 100,
          items: { $ref: '#/components/schemas/UpdateAnyOfVariantV1' },
        },
      },
      ['kind', 'variants'],
    ),
  }
  Object.assign(schemas, measurementSchemas)
  schemas['UpdateDraftGoalMeasurementV1'] = discriminator(
    Object.keys(measurementSchemas),
    {
      boolean: '#/components/schemas/BooleanMeasurementV1',
      quantity: '#/components/schemas/QuantityMeasurementV1',
      actual_time: '#/components/schemas/ActualTimeMeasurementV1',
      rating: '#/components/schemas/RatingMeasurementV1',
      text: '#/components/schemas/TextMeasurementV1',
      checklist: '#/components/schemas/UpdateChecklistMeasurementV1',
      any_of: '#/components/schemas/UpdateAnyOfMeasurementV1',
    },
  )
  const satisfactionSchemas: Record<string, unknown> = {
    BooleanCheckpointSatisfactionV1: object(
      { kind: { type: 'string', enum: ['boolean'] } },
      ['kind'],
    ),
    QuantityCheckpointSatisfactionV1: object(
      {
        kind: { type: 'string', enum: ['quantity'] },
        target: nullableString({
          pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
        }),
      },
      ['kind', 'target'],
    ),
    ActualTimeCheckpointSatisfactionV1: object(
      {
        kind: { type: 'string', enum: ['actual_time'] },
        start: nullableString({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
        end: nullableString({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
      },
      ['kind', 'start', 'end'],
    ),
    RatingCheckpointSatisfactionV1: object(
      { kind: { type: 'string', enum: ['rating'] } },
      ['kind'],
    ),
    TextCheckpointSatisfactionV1: object(
      { kind: { type: 'string', enum: ['text'] } },
      ['kind'],
    ),
    ChecklistCheckpointSatisfactionV1: object(
      { kind: { type: 'string', enum: ['checklist'] } },
      ['kind'],
    ),
    AnyOfCheckpointSatisfactionV1: object(
      { kind: { type: 'string', enum: ['any_of'] } },
      ['kind'],
    ),
  }
  Object.assign(schemas, satisfactionSchemas)
  schemas['DraftGoalCheckpointSatisfactionV1'] = discriminator(
    Object.keys(satisfactionSchemas),
    {
      boolean: '#/components/schemas/BooleanCheckpointSatisfactionV1',
      quantity: '#/components/schemas/QuantityCheckpointSatisfactionV1',
      actual_time: '#/components/schemas/ActualTimeCheckpointSatisfactionV1',
      rating: '#/components/schemas/RatingCheckpointSatisfactionV1',
      text: '#/components/schemas/TextCheckpointSatisfactionV1',
      checklist: '#/components/schemas/ChecklistCheckpointSatisfactionV1',
      any_of: '#/components/schemas/AnyOfCheckpointSatisfactionV1',
    },
  )
  schemas['UpdateDraftGoalCheckpointV1'] = object(
    {
      checkpointId: { ...uuid, nullable: true },
      name: nullableString({ pattern: '\\S', maxLength: 500 }),
      deadline: nullableString({
        pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
      }),
      satisfaction: {
        $ref: '#/components/schemas/DraftGoalCheckpointSatisfactionV1',
      },
    },
    ['name', 'deadline', 'satisfaction'],
  )
  schemas['UpdateDraftGoalCheckpointsV1'] = object(
    {
      aggregation: {
        type: 'string',
        enum: ['independent', 'all'],
        nullable: true,
      },
      items: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/UpdateDraftGoalCheckpointV1' },
      },
    },
    ['aggregation', 'items'],
  )
  schemas['AddChecklistItemV1'] = object(
    {
      itemId: { enum: [null] },
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
    },
    ['label'],
  )
  schemas['AddAnyOfVariantV1'] = object(
    {
      variantId: { enum: [null] },
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
      unit: nullableString({ pattern: '\\S', maxLength: 500 }),
      precision: {
        type: 'integer',
        enum: [0, 1, 2, 3],
        nullable: true,
      },
      target: nullableString({
        pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
      }),
    },
    ['label', 'unit', 'precision', 'target'],
  )
  schemas['AddChecklistMeasurementV1'] = object(
    {
      kind: { type: 'string', enum: ['checklist'] },
      items: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/AddChecklistItemV1' },
      },
    },
    ['kind', 'items'],
  )
  schemas['AddAnyOfMeasurementV1'] = object(
    {
      kind: { type: 'string', enum: ['any_of'] },
      variants: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/AddAnyOfVariantV1' },
      },
    },
    ['kind', 'variants'],
  )
  schemas['AddDraftGoalMeasurementV1'] = discriminator(
    [
      'BooleanMeasurementV1',
      'QuantityMeasurementV1',
      'ActualTimeMeasurementV1',
      'RatingMeasurementV1',
      'TextMeasurementV1',
      'AddChecklistMeasurementV1',
      'AddAnyOfMeasurementV1',
    ],
    {
      boolean: '#/components/schemas/BooleanMeasurementV1',
      quantity: '#/components/schemas/QuantityMeasurementV1',
      actual_time: '#/components/schemas/ActualTimeMeasurementV1',
      rating: '#/components/schemas/RatingMeasurementV1',
      text: '#/components/schemas/TextMeasurementV1',
      checklist: '#/components/schemas/AddChecklistMeasurementV1',
      any_of: '#/components/schemas/AddAnyOfMeasurementV1',
    },
  )
  schemas['AddDraftGoalCheckpointV1'] = object(
    {
      checkpointId: { enum: [null] },
      name: nullableString({ pattern: '\\S', maxLength: 500 }),
      deadline: nullableString({
        pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
      }),
      satisfaction: {
        $ref: '#/components/schemas/DraftGoalCheckpointSatisfactionV1',
      },
    },
    ['name', 'deadline', 'satisfaction'],
  )
  schemas['AddDraftGoalCheckpointsV1'] = object(
    {
      aggregation: {
        type: 'string',
        enum: ['independent', 'all'],
        nullable: true,
      },
      items: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/AddDraftGoalCheckpointV1' },
      },
    },
    ['aggregation', 'items'],
  )
  schemas['AddDraftGoalConfigV1'] = object(
    {
      schemaVersion: { type: 'integer', enum: [1] },
      scope: { $ref: '#/components/schemas/DraftGoalScopeV1' },
      repetition: { $ref: '#/components/schemas/DraftGoalRepetitionV1' },
      measurement: { $ref: '#/components/schemas/AddDraftGoalMeasurementV1' },
      checkpoints: {
        type: 'object',
        allOf: [{ $ref: '#/components/schemas/AddDraftGoalCheckpointsV1' }],
        nullable: true,
      },
    },
    ['schemaVersion', 'scope', 'repetition', 'measurement', 'checkpoints'],
  )
  schemas['StoredChecklistItemV1'] = object(
    {
      itemId: uuid,
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
    },
    ['itemId', 'label'],
  )
  schemas['StoredAnyOfVariantV1'] = object(
    {
      variantId: uuid,
      label: nullableString({ pattern: '\\S', maxLength: 500 }),
      unit: nullableString({ pattern: '\\S', maxLength: 500 }),
      precision: {
        type: 'integer',
        enum: [0, 1, 2, 3],
        nullable: true,
      },
      target: nullableString({
        pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
      }),
    },
    ['variantId', 'label', 'unit', 'precision', 'target'],
  )
  schemas['StoredChecklistMeasurementV1'] = object(
    {
      kind: { type: 'string', enum: ['checklist'] },
      items: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/StoredChecklistItemV1' },
      },
    },
    ['kind', 'items'],
  )
  schemas['StoredAnyOfMeasurementV1'] = object(
    {
      kind: { type: 'string', enum: ['any_of'] },
      variants: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/StoredAnyOfVariantV1' },
      },
    },
    ['kind', 'variants'],
  )
  schemas['StoredDraftGoalMeasurementV1'] = discriminator(
    [
      'BooleanMeasurementV1',
      'QuantityMeasurementV1',
      'ActualTimeMeasurementV1',
      'RatingMeasurementV1',
      'TextMeasurementV1',
      'StoredChecklistMeasurementV1',
      'StoredAnyOfMeasurementV1',
    ],
    {
      boolean: '#/components/schemas/BooleanMeasurementV1',
      quantity: '#/components/schemas/QuantityMeasurementV1',
      actual_time: '#/components/schemas/ActualTimeMeasurementV1',
      rating: '#/components/schemas/RatingMeasurementV1',
      text: '#/components/schemas/TextMeasurementV1',
      checklist: '#/components/schemas/StoredChecklistMeasurementV1',
      any_of: '#/components/schemas/StoredAnyOfMeasurementV1',
    },
  )
  schemas['StoredDraftGoalCheckpointV1'] = object(
    {
      checkpointId: uuid,
      name: nullableString({ pattern: '\\S', maxLength: 500 }),
      deadline: nullableString({
        pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
      }),
      satisfaction: {
        $ref: '#/components/schemas/DraftGoalCheckpointSatisfactionV1',
      },
    },
    ['checkpointId', 'name', 'deadline', 'satisfaction'],
  )
  schemas['StoredDraftGoalCheckpointsV1'] = object(
    {
      aggregation: {
        type: 'string',
        enum: ['independent', 'all'],
        nullable: true,
      },
      items: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/StoredDraftGoalCheckpointV1' },
      },
    },
    ['aggregation', 'items'],
  )
  schemas['UpdateDraftGoalConfigV1'] = object(
    {
      schemaVersion: { type: 'integer', enum: [1] },
      scope: { $ref: '#/components/schemas/DraftGoalScopeV1' },
      repetition: { $ref: '#/components/schemas/DraftGoalRepetitionV1' },
      measurement: {
        $ref: '#/components/schemas/UpdateDraftGoalMeasurementV1',
      },
      checkpoints: {
        type: 'object',
        allOf: [{ $ref: '#/components/schemas/UpdateDraftGoalCheckpointsV1' }],
        nullable: true,
      },
    },
    ['schemaVersion', 'scope', 'repetition', 'measurement', 'checkpoints'],
  )
  schemas['StoredDraftGoalConfigV1'] = object(
    {
      schemaVersion: { type: 'integer', enum: [1] },
      scope: { $ref: '#/components/schemas/DraftGoalScopeV1' },
      repetition: { $ref: '#/components/schemas/DraftGoalRepetitionV1' },
      measurement: {
        $ref: '#/components/schemas/StoredDraftGoalMeasurementV1',
      },
      checkpoints: {
        type: 'object',
        allOf: [{ $ref: '#/components/schemas/StoredDraftGoalCheckpointsV1' }],
        nullable: true,
      },
    },
    ['schemaVersion', 'scope', 'repetition', 'measurement', 'checkpoints'],
  )
  schemas['SourceProvenanceV1'] = object(
    {
      schemaVersion: { type: 'integer', enum: [1] },
      sourceDocument: { type: 'string', pattern: '\\S', maxLength: 500 },
      sourcePage: {
        type: 'integer',
        minimum: 1,
        maximum: 9007199254740991,
      },
      rawValue: nullableString({ maxLength: 2000 }),
      rawDenominator: nullableString({ maxLength: 2000 }),
      resolution: { type: 'string', pattern: '\\S', maxLength: 500 },
    },
    [
      'schemaVersion',
      'sourceDocument',
      'sourcePage',
      'rawValue',
      'rawDenominator',
      'resolution',
    ],
  )
  schemas['PublishBlockerV1'] = object(
    {
      planGoalId: uuid,
      pointer: {
        type: 'string',
        pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
      },
      code: {
        type: 'string',
        enum: ['required', 'empty_collection', 'incompatible'],
      },
      detail: {
        type: 'string',
        enum: [
          'Required value is missing.',
          'At least one item is required.',
          'Values are incompatible.',
        ],
      },
    },
    ['planGoalId', 'pointer', 'code', 'detail'],
  )
  schemas['DraftGoalViewV1'] = object(
    {
      planGoalId: uuid,
      goalDefinitionId: uuid,
      goalDefinitionVersionId: uuid,
      goalSeriesId: uuid,
      title: {
        type: 'string',
        pattern: '\\S',
        minLength: 1,
        maxLength: 200,
      },
      why: {
        type: 'string',
        pattern: '\\S',
        minLength: 1,
        maxLength: 2000,
      },
      category: {
        type: 'string',
        pattern: '\\S',
        minLength: 1,
        maxLength: 100,
      },
      displayOrder: { type: 'integer', minimum: 0, maximum: 199 },
      configRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
      config: { $ref: '#/components/schemas/StoredDraftGoalConfigV1' },
      sourceProvenance: {
        type: 'object',
        allOf: [{ $ref: '#/components/schemas/SourceProvenanceV1' }],
        nullable: true,
      },
      blockers: {
        type: 'array',
        items: { $ref: '#/components/schemas/PublishBlockerV1' },
      },
    },
    [
      'planGoalId',
      'goalDefinitionId',
      'goalDefinitionVersionId',
      'goalSeriesId',
      'title',
      'why',
      'category',
      'displayOrder',
      'configRevision',
      'config',
      'sourceProvenance',
      'blockers',
    ],
  )
  schemas['DraftEditorResponseV1'] = object(
    {
      planMonthId: uuid,
      spaceId: uuid,
      targetMonth: {
        type: 'string',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
      },
      status: { type: 'string', enum: ['draft'] },
      focus: {
        type: 'string',
        pattern: '\\S',
        minLength: 1,
        maxLength: 500,
      },
      planMonthRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
      draftRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
      goals: {
        type: 'array',
        maxItems: 200,
        items: { $ref: '#/components/schemas/DraftGoalViewV1' },
      },
      blockers: {
        type: 'array',
        items: { $ref: '#/components/schemas/PublishBlockerV1' },
      },
    },
    [
      'planMonthId',
      'spaceId',
      'targetMonth',
      'status',
      'focus',
      'planMonthRevision',
      'draftRevision',
      'goals',
      'blockers',
    ],
  )
  schemas['PublicationPreviewBlockerV1'] = object(
    {
      planGoalId: { ...uuid, nullable: true },
      pointer: {
        type: 'string',
        pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
      },
      code: {
        type: 'string',
        enum: ['required', 'empty_collection', 'incompatible'],
      },
      detail: {
        type: 'string',
        enum: [
          'Required value is missing.',
          'At least one item is required.',
          'Values are incompatible.',
          'due date is outside target month',
          'week ordinal is not present in target month',
          'Target month is not current or next.',
        ],
      },
    },
    ['planGoalId', 'pointer', 'code', 'detail'],
  )
  schemas['PublicationPreviewGoalBlockerV1'] = object(
    {
      planGoalId: uuid,
      pointer: {
        type: 'string',
        pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
      },
      code: {
        type: 'string',
        enum: ['required', 'empty_collection', 'incompatible'],
      },
      detail: {
        type: 'string',
        enum: [
          'Required value is missing.',
          'At least one item is required.',
          'Values are incompatible.',
          'due date is outside target month',
          'week ordinal is not present in target month',
        ],
      },
    },
    ['planGoalId', 'pointer', 'code', 'detail'],
  )
  schemas['PublicationPreviewActivationV1'] = object(
    {
      mode: {
        type: 'string',
        enum: ['immediate', 'scheduled', 'blocked'],
      },
      activeLocalDate: {
        type: 'string',
        format: 'date',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$',
      },
      latePublication: { type: 'boolean' },
    },
    ['mode', 'activeLocalDate', 'latePublication'],
  )
  schemas['FixedEligibleCalendarV1'] = object(
    {
      targetMonth: {
        type: 'string',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
      },
      activeLocalDate: { type: 'string', format: 'date' },
      timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
      kind: { type: 'string', enum: ['fixed'] },
      expectationDates: {
        type: 'array',
        maxItems: 31,
        items: { type: 'string', format: 'date' },
      },
    },
    ['targetMonth', 'activeLocalDate', 'timeZone', 'kind', 'expectationDates'],
  )
  schemas['QuotaCalendarPeriodV1'] = object(
    {
      cadence: { type: 'string', enum: ['weekly', 'monthly'] },
      ordinal: { type: 'integer', minimum: 1, maximum: 6 },
      periodStart: { type: 'string', format: 'date' },
      periodEnd: { type: 'string', format: 'date' },
      periodDays: { type: 'integer', minimum: 1, maximum: 31 },
      activeDates: {
        type: 'array',
        maxItems: 31,
        items: { type: 'string', format: 'date' },
      },
      eligibleDates: {
        type: 'array',
        maxItems: 31,
        items: { type: 'string', format: 'date' },
      },
      periodTarget: { type: 'integer', minimum: 0, maximum: 31 },
    },
    [
      'cadence',
      'ordinal',
      'periodStart',
      'periodEnd',
      'periodDays',
      'activeDates',
      'eligibleDates',
      'periodTarget',
    ],
  )
  schemas['QuotaEligibleCalendarV1'] = object(
    {
      targetMonth: {
        type: 'string',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
      },
      activeLocalDate: { type: 'string', format: 'date' },
      timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
      kind: { type: 'string', enum: ['quota'] },
      cadence: { type: 'string', enum: ['weekly', 'monthly'] },
      periods: {
        type: 'array',
        maxItems: 6,
        items: { $ref: '#/components/schemas/QuotaCalendarPeriodV1' },
      },
    },
    [
      'targetMonth',
      'activeLocalDate',
      'timeZone',
      'kind',
      'cadence',
      'periods',
    ],
  )
  schemas['WeeklyPlannedTaskPeriodV1'] = object(
    {
      cadence: { type: 'string', enum: ['weekly'] },
      ordinal: { type: 'integer', minimum: 1, maximum: 5 },
      periodStart: { type: 'string', format: 'date' },
      periodEnd: { type: 'string', format: 'date' },
      periodTarget: { type: 'integer', enum: [1] },
    },
    ['cadence', 'ordinal', 'periodStart', 'periodEnd', 'periodTarget'],
  )
  schemas['WeeklyPlannedTaskEligibleCalendarV1'] = object(
    {
      targetMonth: {
        type: 'string',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
      },
      activeLocalDate: { type: 'string', format: 'date' },
      timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
      kind: { type: 'string', enum: ['weekly_planned_task'] },
      periods: {
        type: 'array',
        maxItems: 1,
        items: {
          $ref: '#/components/schemas/WeeklyPlannedTaskPeriodV1',
        },
      },
    },
    ['targetMonth', 'activeLocalDate', 'timeZone', 'kind', 'periods'],
  )
  schemas['EligibleCalendarV1'] = discriminator(
    [
      'FixedEligibleCalendarV1',
      'QuotaEligibleCalendarV1',
      'WeeklyPlannedTaskEligibleCalendarV1',
    ],
    {
      fixed: '#/components/schemas/FixedEligibleCalendarV1',
      quota: '#/components/schemas/QuotaEligibleCalendarV1',
      weekly_planned_task:
        '#/components/schemas/WeeklyPlannedTaskEligibleCalendarV1',
    },
  )
  schemas['PublicationCalculatedTargetV1'] = object(
    {
      planGoalId: uuid,
      formulaVersion: {
        type: 'string',
        enum: ['planner.calendar-targets.v1'],
      },
      calendar: { $ref: '#/components/schemas/EligibleCalendarV1' },
    },
    ['planGoalId', 'formulaVersion', 'calendar'],
  )
  schemas['PublicationPreviewFormulaVersionsV1'] = object(
    {
      calendarTargets: {
        type: 'string',
        enum: ['planner.calendar-targets.v1'],
      },
      goalEvaluation: {
        type: 'string',
        enum: ['planner.goal-evaluation.v1'],
      },
      scoreCoverage: {
        type: 'string',
        enum: ['planner.score-coverage.v1'],
      },
    },
    ['calendarTargets', 'goalEvaluation', 'scoreCoverage'],
  )
  const draftGoalView = schemas['DraftGoalViewV1'] as {
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
  }
  schemas['PublicationPreviewGoalV1'] = object(
    {
      ...draftGoalView.properties,
      blockers: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/PublicationPreviewGoalBlockerV1',
        },
      },
    },
    draftGoalView.required,
  )
  schemas['PublicationPreviewResponseV1'] = object(
    {
      schemaVersion: {
        type: 'string',
        enum: ['planner.publication-preview.v1'],
      },
      planMonthId: uuid,
      spaceId: uuid,
      targetMonth: {
        type: 'string',
        pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$',
      },
      status: { type: 'string', enum: ['draft'] },
      planMonthRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
      draftRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
      previewHashVersion: {
        type: 'string',
        enum: ['planner.publication-preview-hash.v1'],
      },
      previewHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      activation: {
        $ref: '#/components/schemas/PublicationPreviewActivationV1',
      },
      focus: {
        type: 'string',
        pattern: '\\S',
        minLength: 1,
        maxLength: 500,
      },
      goals: {
        type: 'array',
        maxItems: 200,
        items: { $ref: '#/components/schemas/PublicationPreviewGoalV1' },
      },
      calculatedTargets: {
        type: 'array',
        maxItems: 200,
        items: { $ref: '#/components/schemas/PublicationCalculatedTargetV1' },
      },
      blockers: {
        type: 'array',
        items: { $ref: '#/components/schemas/PublicationPreviewBlockerV1' },
      },
      formulaVersions: {
        $ref: '#/components/schemas/PublicationPreviewFormulaVersionsV1',
      },
    },
    [
      'schemaVersion',
      'planMonthId',
      'spaceId',
      'targetMonth',
      'status',
      'planMonthRevision',
      'draftRevision',
      'previewHashVersion',
      'previewHash',
      'activation',
      'focus',
      'goals',
      'calculatedTargets',
      'blockers',
      'formulaVersions',
    ],
  )
  schemas['DraftMutationResponseV1'] = object(
    {
      kind: { type: 'string', enum: ['planning.plan-draft.v1'] },
      aggregateId: uuid,
      aggregateRevision: { type: 'string', pattern: '^[1-9][0-9]*$' },
    },
    ['kind', 'aggregateId', 'aggregateRevision'],
  )
}

export const PLANNING_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'planning',
      description: 'Versioned goal catalog and monthly planning.',
    },
  ],
  problemCodeComponents: [
    {
      componentName: 'GoalDefinitionConflictProblemResponseDto',
      codes: [
        'GOAL_DEFINITION_REVISION_CONFLICT',
        'GOAL_DEFINITION_STATE_CONFLICT',
      ],
    },
    {
      componentName: 'DraftConflictProblemResponseDto',
      codes: ['DRAFT_REVISION_CONFLICT'],
    },
  ],
  install: installPlanningGoalSchemas,
}
