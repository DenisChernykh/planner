import type {
  DraftGoalConfigV1,
  GoalConfigV1,
  SourceProvenanceV1,
} from '../domain/goal-config'
import {
  snapshotSourceProvenance,
  snapshotStoredDraftGoalConfig,
} from '../domain/goal-config'
import { validateGoalConfig } from '../domain/goal-validation'

export const APRIL_PLAN_SEED_SCHEMA_VERSION =
  'planner.april-plan-seed.v1' as const

type SeedOwner = 'memberA' | 'memberB' | 'shared'
type SeedConfigV1 = Omit<DraftGoalConfigV1, 'scope'>

export type AprilPlanSeedGoalV1 = {
  readonly seedGoalKey: string
  readonly title: string
  readonly why: string
  readonly category: string
  readonly owner: SeedOwner
  readonly config: SeedConfigV1
  readonly sourceProvenance: SourceProvenanceV1
}

export type ResolvedAprilPlanSeedGoalV1 = Omit<
  AprilPlanSeedGoalV1,
  'owner' | 'config'
> & {
  readonly config: GoalConfigV1
}

export type ResolvedAprilPlanSeedV1 = {
  readonly schemaVersion: typeof APRIL_PLAN_SEED_SCHEMA_VERSION
  readonly seedId: 'april-plan'
  readonly seedVersion: 1
  readonly sourceDocument: 'monthly-plan-template'
  readonly renderedPageCount: 7
  readonly focus: 'Показатель 108'
  readonly goals: readonly ResolvedAprilPlanSeedGoalV1[]
}

const NO_CHECKPOINTS = null
const SOURCE_DOCUMENT = 'monthly-plan-template' as const

function freezeData<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeData(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor) {
        freezeData(descriptor.value)
      }
    }
    return Object.freeze(value)
  }
  return value
}

function componentId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function provenance(
  sourcePage: number,
  rawValue: string,
  rawDenominator: string | null,
  resolution: string,
): SourceProvenanceV1 {
  const result = snapshotSourceProvenance({
    schemaVersion: 1,
    sourceDocument: SOURCE_DOCUMENT,
    sourcePage,
    rawValue,
    rawDenominator,
    resolution,
  })
  if (result === null) throw new TypeError('April seed provenance is required')
  return result
}

function dailyBoolean(): SeedConfigV1 {
  return {
    schemaVersion: 1,
    repetition: { kind: 'daily' },
    measurement: { kind: 'boolean' },
    checkpoints: NO_CHECKPOINTS,
  }
}

function quotaBoolean(kind: 'weekly' | 'monthly', n: string): SeedConfigV1 {
  return {
    schemaVersion: 1,
    repetition: { kind, n },
    measurement: { kind: 'boolean' },
    checkpoints: NO_CHECKPOINTS,
  }
}

function targetedQuantity(
  repetition: SeedConfigV1['repetition'],
  unit: string,
  aggregation: 'add' | 'latest',
  target: string,
): SeedConfigV1 {
  return {
    schemaVersion: 1,
    repetition,
    measurement: {
      kind: 'quantity',
      mode: 'targeted',
      unit,
      precision: 0,
      aggregation,
      target,
    },
    checkpoints: NO_CHECKPOINTS,
  }
}

function informationalQuantity(
  unit: string,
  aggregation: 'add' | 'latest',
): SeedConfigV1 {
  return {
    schemaVersion: 1,
    repetition: { kind: 'monthly', n: '1' },
    measurement: {
      kind: 'quantity',
      mode: 'informational',
      unit,
      precision: 0,
      aggregation,
      target: null,
    },
    checkpoints: NO_CHECKPOINTS,
  }
}

function goal(
  seedGoalKey: string,
  title: string,
  why: string,
  category: string,
  owner: SeedOwner,
  config: SeedConfigV1,
  sourceProvenance: SourceProvenanceV1,
): AprilPlanSeedGoalV1 {
  return {
    seedGoalKey,
    title,
    why,
    category,
    owner,
    config,
    sourceProvenance,
  }
}

const GOALS: readonly AprilPlanSeedGoalV1[] = [
  goal(
    'memberB_wake_time',
    'Показатель 103',
    'Показатель 165',
    'Режим',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'daily' },
      measurement: { kind: 'actual_time', start: '08:00', end: '09:30' },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(1, 'Показатель 102', '/30', 'Показатель 063'),
  ),
  goal(
    'memberB_sleep_time',
    'Показатель 082',
    'Показатель 142',
    'Режим',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'daily' },
      measurement: { kind: 'actual_time', start: '21:00', end: '23:00' },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(1, 'Показатель 081', '/30', 'Показатель 064'),
  ),
  goal(
    'goal_29',
    'Утро без телефона',
    'Показатель 143',
    'Режим',
    'memberB',
    targetedQuantity({ kind: 'daily' }, 'минуты', 'add', '60'),
    provenance(1, 'Показатель 004', '/30', 'Показатель 092'),
  ),
  goal(
    'goal_22',
    'Показатель 086',
    'псих состояние',
    'Самочувствие',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'daily' },
      measurement: { kind: 'rating', minimum: 1, maximum: 10 },
      checkpoints: {
        aggregation: 'independent',
        items: [
          {
            checkpointId: componentId(1),
            name: 'утро',
            deadline: '12:00',
            satisfaction: { kind: 'rating' },
          },
          {
            checkpointId: componentId(2),
            name: 'день',
            deadline: '18:00',
            satisfaction: { kind: 'rating' },
          },
          {
            checkpointId: componentId(3),
            name: 'вечер',
            deadline: '22:00',
            satisfaction: { kind: 'rating' },
          },
        ],
      },
    },
    provenance(1, 'Показатель 094', null, 'Показатель 130'),
  ),
  goal(
    'memberB_water',
    'Вода 1200 мл',
    'здоровье и красота',
    'Здоровье',
    'memberB',
    targetedQuantity({ kind: 'daily' }, 'мл', 'add', '1200'),
    provenance(1, 'Показатель 046', '/30', 'Показатель 065'),
  ),
  goal(
    'goal_36',
    'День без сладкого',
    'здоровье и красота',
    'Питание',
    'memberB',
    quotaBoolean('monthly', '26'),
    provenance(1, 'Показатель 056', '/26', 'Показатель 129'),
  ),
  goal(
    'memberB_meal_schedule',
    'Режим питания',
    'Показатель 151',
    'Питание',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'daily' },
      measurement: { kind: 'boolean' },
      checkpoints: {
        aggregation: 'all',
        items: [
          {
            checkpointId: componentId(4),
            name: 'завтрак до 9:30',
            deadline: '09:30',
            satisfaction: { kind: 'boolean' },
          },
          {
            checkpointId: componentId(5),
            name: 'обед 11:30–12:30',
            deadline: '12:30',
            satisfaction: { kind: 'boolean' },
          },
          {
            checkpointId: componentId(6),
            name: 'ужин 18:30–20:00',
            deadline: '20:00',
            satisfaction: { kind: 'boolean' },
          },
        ],
      },
    },
    provenance(2, 'Показатель 118', '/30', 'Показатель 045'),
  ),
  goal(
    'memberB_fresh_juice',
    'Свежевыжатый сок',
    'здоровье и красота',
    'Питание',
    'memberB',
    quotaBoolean('monthly', '8'),
    provenance(2, 'Показатель 047', '/8', 'Flexible monthly Boolean N=8.'),
  ),
  goal(
    'memberB_vitamin_d',
    'Витамин D',
    'здоровье',
    'Здоровье',
    'memberB',
    dailyBoolean(),
    provenance(2, 'Показатель 031', '/30', 'Ежедневный Boolean.'),
  ),
  goal(
    'memberB_iron',
    'Железо',
    'здоровье',
    'Здоровье',
    'memberB',
    dailyBoolean(),
    provenance(2, 'ЖЕЛЕЗО – здоровье', '/30', 'Ежедневный Boolean.'),
  ),
  goal(
    'memberB_hair_care',
    'Уход за волосами',
    'здоровье и красота',
    'Уход',
    'memberB',
    quotaBoolean('monthly', '8'),
    provenance(2, 'Показатель 125', '/8', 'Flexible monthly Boolean N=8.'),
  ),
  goal(
    'memberB_face_massage',
    'Массаж лица',
    'Показатель 182',
    'Уход',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'monthly', n: '8' },
      measurement: {
        kind: 'any_of',
        variants: [
          {
            variantId: componentId(7),
            label: 'сделать массаж лица',
            unit: 'раз',
            precision: 0,
            target: '1',
          },
          {
            variantId: componentId(8),
            label: 'Показатель 186',
            unit: 'раз',
            precision: 0,
            target: '1',
          },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(2, 'Показатель 126', '/8', 'Показатель 083'),
  ),
  goal(
    'memberB_meditations',
    'Медитации',
    'Показатель 169',
    'Самочувствие',
    'memberB',
    quotaBoolean('monthly', '16'),
    provenance(3, 'Показатель 123', '/20', 'Показатель 095'),
  ),
  goal(
    'goal_14',
    'Показатель 060',
    'Показатель 146',
    'Самочувствие',
    'memberB',
    dailyBoolean(),
    provenance(3, 'Показатель 070', '/30', 'Показатель 067'),
  ),
  goal(
    'memberB_fitness',
    'Показатель 136',
    'Показатель 162',
    'Активность',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'any_of',
        variants: [
          {
            variantId: componentId(9),
            label: 'фитнес-клуб',
            unit: 'раз',
            precision: 0,
            target: '1',
          },
          {
            variantId: componentId(10),
            label: 'тренировка дома',
            unit: 'раз',
            precision: 0,
            target: '1',
          },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(3, 'Показатель 101', '/8', 'Показатель 059'),
  ),
  goal(
    'memberB_mfr',
    'МФР',
    'Показатель 173',
    'Активность',
    'memberB',
    quotaBoolean('monthly', '8'),
    provenance(3, 'Показатель 124', '/8', 'Показатель 016'),
  ),
  goal(
    'memberB_steps',
    '7000 шагов',
    'регулярная ходьба',
    'Активность',
    'memberB',
    targetedQuantity({ kind: 'weekly', n: '5' }, 'шаги', 'latest', '7000'),
    provenance(3, 'Показатель 109', '/20', 'Показатель 028'),
  ),
  goal(
    'goal_31',
    'Показатель 138',
    'Показатель 005',
    'Развитие',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'any_of',
        variants: [
          {
            variantId: componentId(11),
            label: 'чтение',
            unit: 'страницы',
            precision: 0,
            target: '100',
          },
          {
            variantId: componentId(12),
            label: 'аудиокнига',
            unit: 'минуты',
            precision: 0,
            target: '60',
          },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(3, 'Показатель 110', '/8', 'Показатель 027'),
  ),
  goal(
    'shared_activity',
    'Показатель 127',
    'Показатель 194',
    'Отношения',
    'shared',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'any_of',
        variants: [
          ['фитнес-клуб', 13],
          ['кино', 14],
          ['свидание', 15],
          ['увлечение', 16],
          ['прогулка', 17],
        ].map(([label, id]) => ({
          variantId: componentId(id as number),
          label: label as string,
          unit: 'раз',
          precision: 0 as const,
          target: '1',
        })),
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(4, 'Показатель 007', '/10', 'Показатель 058'),
  ),
  goal(
    'memberB_relax_evening',
    'Расслабляющий вечер',
    'Показатель 174',
    'Самочувствие',
    'memberB',
    quotaBoolean('monthly', '8'),
    provenance(4, 'Показатель 119', '/8', 'Показатель 017'),
  ),
  goal(
    'memberB_new_skill',
    'Урок нового навыка',
    'Показатель 171',
    'Развитие',
    'memberB',
    quotaBoolean('weekly', '1'),
    provenance(4, 'Показатель 002', '/4', 'Показатель 025'),
  ),
  goal(
    'goal_32',
    'Показатель 111',
    'Показатель 141',
    'Контент',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'checklist',
        items: [
          { itemId: componentId(18), label: 'вк' },
          { itemId: componentId(19), label: 'Дзен' },
          { itemId: componentId(20), label: 'тик-ток' },
          { itemId: componentId(21), label: 'инст' },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(4, 'Показатель 079', '/8', 'Показатель 015'),
  ),
  goal(
    'goal_08',
    'Показатель 112',
    'Показатель 024',
    'Контент',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'checklist',
        items: [
          { itemId: componentId(22), label: 'Telegram' },
          { itemId: componentId(23), label: 'Дзен' },
          { itemId: componentId(24), label: 'MAX' },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(4, 'Показатель 080', '/8', 'Показатель 014'),
  ),
  goal(
    'goal_09',
    'Показатель 075',
    'Показатель 183',
    'Работа',
    'memberB',
    targetedQuantity({ kind: 'monthly', n: '1' }, 'коллаборации', 'add', '7'),
    provenance(5, 'Показатель 077', null, 'Показатель 021'),
  ),
  goal(
    'goal_17',
    'Поиск работы Участник А',
    'Показатель 172',
    'Работа',
    'memberB',
    quotaBoolean('weekly', '3'),
    provenance(5, 'Показатель 100', '/12', 'Показатель 037'),
  ),
  goal(
    'goal_41',
    'Показатель 097',
    'Показатель 191',
    'Проект',
    'memberB',
    quotaBoolean('weekly', '5'),
    provenance(5, 'Показатель 098', '/20', 'Показатель 026'),
  ),
  goal(
    'memberB_promote_memberA',
    'Командная публикация',
    'Показатель 176',
    'Контент',
    'memberB',
    {
      schemaVersion: 1,
      repetition: { kind: 'weekly', n: '2' },
      measurement: {
        kind: 'any_of',
        variants: [
          {
            variantId: componentId(25),
            label: 'ролик',
            unit: 'публикация',
            precision: 0,
            target: '1',
          },
          {
            variantId: componentId(26),
            label: 'Показатель 168',
            unit: 'публикация',
            precision: 0,
            target: '1',
          },
          {
            variantId: componentId(27),
            label: 'Показатель 018',
            unit: 'публикация',
            precision: 0,
            target: '1',
          },
        ],
      },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(5, 'Показатель 107', '/8', 'Показатель 038'),
  ),
  goal(
    'memberA_fitness',
    'Фитнес Участник А',
    'Показатель 162',
    'Активность',
    'memberA',
    quotaBoolean('weekly', '2'),
    provenance(5, 'Показатель 050', '/8', 'Показатель 034'),
  ),
  goal(
    'memberA_steps',
    '7000 шагов Участник А',
    'регулярная ходьба',
    'Активность',
    'memberA',
    targetedQuantity({ kind: 'weekly', n: '5' }, 'шаги', 'latest', '7000'),
    provenance(5, 'Показатель 109', '/20', 'Показатель 035'),
  ),
  goal(
    'goal_04',
    'Показатель 053',
    'Показатель 161',
    'Питание',
    'memberA',
    dailyBoolean(),
    provenance(5, 'Показатель 052', '/30', 'Показатель 036'),
  ),
  goal(
    'shared_order',
    'Общий порядок',
    'Показатель 147',
    'Дом',
    'shared',
    dailyBoolean(),
    provenance(6, 'Показатель 049', '/30', 'Показатель 023'),
  ),
  goal(
    'goal_01',
    'Показатель 054',
    'Показатель 161',
    'Питание',
    'memberA',
    dailyBoolean(),
    provenance(6, 'Показатель 051', '/30', 'Показатель 036'),
  ),
  goal(
    'goal_06',
    'Важная задача дня',
    'Показатель 160',
    'Фокус',
    'shared',
    {
      schemaVersion: 1,
      repetition: { kind: 'daily' },
      measurement: { kind: 'text' },
      checkpoints: NO_CHECKPOINTS,
    },
    provenance(6, 'Показатель 001', null, 'Показатель 022'),
  ),
  ...(
    [
      ['goal_24', '1', 'Показатель 158', 'Показатель 003'],
      ['goal_25', '2', 'Показатель 157', 'Показатель 006'],
      ['goal_26', '3', 'Показатель 184', 'Показатель 008'],
      ['goal_27', '4', 'глемпенги', 'Показатель 010'],
      ['goal_28', '5', 'Показатель 195', 'Показатель 011'],
    ] as const
  ).map(([seedGoalKey, weekOrdinal, taskText, rawValue]) =>
    goal(
      seedGoalKey,
      `Outreach: неделя ${weekOrdinal}`,
      taskText,
      'Работа',
      'memberB',
      {
        schemaVersion: 1,
        repetition: { kind: 'weekly_planned_task', weekOrdinal, taskText },
        measurement: { kind: 'boolean' },
        checkpoints: NO_CHECKPOINTS,
      },
      provenance(
        6,
        rawValue,
        null,
        `Владелец Участник Б; weekly_planned_task недели ${weekOrdinal} без фиксированного дня.`,
      ),
    ),
  ),
  goal(
    'goal_10',
    'Показатель 062',
    'Показатель 153',
    'Работа',
    'memberB',
    informationalQuantity('руб.', 'add'),
    provenance(7, 'Показатель 076', null, 'Показатель 061'),
  ),
  goal(
    'goal_37',
    'Показатель 088',
    'Показатель 178',
    'Контент',
    'memberB',
    targetedQuantity({ kind: 'monthly', n: '1' }, 'подписчики', 'latest', '50'),
    provenance(7, 'Показатель 090', '/50', 'Показатель 020'),
  ),
  goal(
    'memberB_max_followers',
    'Показатель 087',
    'рост аудитории MAX',
    'Контент',
    'memberB',
    informationalQuantity('подписчики', 'latest'),
    provenance(7, 'Показатель 089', null, 'Показатель 019'),
  ),
]

export const APRIL_PLAN_SEED = freezeData({
  schemaVersion: APRIL_PLAN_SEED_SCHEMA_VERSION,
  seedId: 'april-plan' as const,
  seedVersion: 1 as const,
  sourceDocument: SOURCE_DOCUMENT,
  renderedPageCount: 7 as const,
  focus: 'Показатель 108' as const,
  goals: GOALS,
})

const MEMBER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function resolveAprilPlanSeed(input: {
  readonly denisMemberId: string
  readonly tanyaMemberId: string
}): ResolvedAprilPlanSeedV1 {
  if (
    !MEMBER_ID.test(input.denisMemberId) ||
    !MEMBER_ID.test(input.tanyaMemberId) ||
    input.denisMemberId === input.tanyaMemberId
  ) {
    throw new TypeError('April seed requires two distinct canonical member IDs')
  }

  const goals = APRIL_PLAN_SEED.goals.map((item) => {
    const scope =
      item.owner === 'shared'
        ? ({ kind: 'shared' } as const)
        : ({
            kind: 'personal',
            ownerMemberId:
              item.owner === 'memberA'
                ? input.denisMemberId
                : input.tanyaMemberId,
          } as const)
    const draftConfig = snapshotStoredDraftGoalConfig({
      schemaVersion: item.config.schemaVersion,
      scope,
      repetition: item.config.repetition,
      measurement: item.config.measurement,
      checkpoints: item.config.checkpoints,
    })
    const validation = validateGoalConfig(item.seedGoalKey, draftConfig)
    if (!validation.publishable) {
      throw new TypeError(
        `April seed goal is not publishable: ${item.seedGoalKey}`,
      )
    }
    return {
      seedGoalKey: item.seedGoalKey,
      title: item.title,
      why: item.why,
      category: item.category,
      config: validation.config,
      sourceProvenance: item.sourceProvenance,
    }
  })

  return freezeData({
    schemaVersion: APRIL_PLAN_SEED.schemaVersion,
    seedId: APRIL_PLAN_SEED.seedId,
    seedVersion: APRIL_PLAN_SEED.seedVersion,
    sourceDocument: APRIL_PLAN_SEED.sourceDocument,
    renderedPageCount: APRIL_PLAN_SEED.renderedPageCount,
    focus: APRIL_PLAN_SEED.focus,
    goals,
  })
}
