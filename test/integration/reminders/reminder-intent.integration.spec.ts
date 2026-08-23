import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createRemindersApplication,
  ReminderIntentClaimStaleError,
  PrismaNotificationIntentPersistence,
} from '@/modules/reminders'
import type {
  PersistReminderIntentInput,
  ReminderOccurrenceClaim,
  ReminderRenderedContentV1,
} from '@/modules/reminders'
import {
  createPlanningApplication,
  type PlanningApplication,
} from '@/modules/planning'
import {
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const partnerUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
const partnerMemberId = '55555555-5555-4555-8555-555555555555'
const monthId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const publicationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const scheduleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const occurrenceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const secondOccurrenceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const publishActionId = '12121212-1212-4121-8121-121212121212'
const publishCommandId = '13131313-1313-4131-8131-131313131313'

const migrations = [
  '20260811090000_planner_foundation',
  '20260811100000_local_user_session',
  '20260811110000_pair_workspace',
  '20260811120000_telegram_external_identity',
  '20260811130000_plan_draft_kernel',
  '20260811140000_goal_catalog',
  '20260811150000_typed_draft_goals',
  '20260811151000_plan_publication',
  '20260811152000_cancel_republish',
  '20260811153000_copy_month',
  '20260811155000_seed_consumption',
  '20260811160000_tracking_record_kernel',
  '20260811161000_time_rating_checkpoints',
  '20260811162000_text_checklist_facts',
  '20260811163000_or_composite_facts',
  '20260811164000_fact_corrections_tombstones',
  '20260811165000_fact_undo',
  '20260811166000_close_day',
  '20260811167000_weekly_task_result',
  '20260811168000_close_week',
  '20260811170000_telegram_ingress_state',
  '20260811200000_telegram_action_intents',
  '20260811201000_telegram_scalar_action_intents',
  '20260811202000_telegram_composite_action_intents',
  '20260811203000_telegram_tracking_action_intents',
  '20260811210000_reminder_schedule_occurrence',
  '20260811220000_notification_intents',
  '20260811230000_notification_attempts',
  '20260811240000_reminder_worker_retry',
  '20260812000000_report_revisions',
  '20260812010000_reopen_month',
  '20260812020000_reclose_month',
] as const

const now = new Date('2026-03-30T05:00:00.000Z')
const expiresAt = new Date('2026-03-30T09:00:00.000Z')

function source(factsRevision: bigint): never {
  return {
    state: 'published',
    publicationId,
    factsRevision,
  } as never
}

function content(title: string): ReminderRenderedContentV1 {
  return {
    schemaVersion: 'reminders.rendered-content.v1',
    localDate: '2026-03-30',
    slotKind: 'morning',
    focus: 'Фокус',
    items: [
      {
        kind: 'fixed',
        goalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        componentId: null,
        title,
        state: 'pending',
        remaining: null,
        expectedProgress: null,
        actualProgress: null,
      },
    ],
    actions: [],
  }
}

function claim(id: string): ReminderOccurrenceClaim {
  return {
    occurrenceId: id,
    recipientMemberId: memberId,
    localDate: '2026-03-30',
    slotKind: 'morning',
    dueAt: new Date('2026-03-30T04:00:00.000Z'),
    expiresAt,
    fencingToken: 3n,
  }
}

function persistInput(
  occurrence: ReminderOccurrenceClaim,
  contentValue: ReminderRenderedContentV1 | null,
  factsRevision = 1n,
): PersistReminderIntentInput {
  return {
    claim: occurrence,
    leaseOwner: 'worker-n02',
    now,
    source: contentValue === null ? null : source(factsRevision),
    content: contentValue,
    suppressionReason:
      contentValue === null ? 'nothing_relevant' : 'nothing_relevant',
  }
}

describe('N02 notification intents on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let persistence: PrismaNotificationIntentPersistence
  let clock: FakeProductClock
  let planning: PlanningApplication
  let tracking: TrackingApplication
  let reminders: ReturnType<typeof createRemindersApplication>

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_n02_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrations) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    const config = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 8,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 30_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(3_000))
    transaction = new PrismaTransactionAdapter(provider, context, config)
    persistence = new PrismaNotificationIntentPersistence(provider)
    const workspaceMembers = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(now)
    planning = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers,
      clock,
    })
    tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers,
      clock,
    })
    reminders = createRemindersApplication({
      database: provider,
      transaction,
      workspaceMembers,
      clock,
      today: {
        getToday: (recipientMemberId) =>
          tracking.getToday.execute({
            trustedActor: { kind: 'member', id: recipientMemberId },
          }),
      },
    })
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(
      `INSERT INTO users (id) VALUES
         ('${userId}'::uuid), ('${partnerUserId}'::uuid);
       INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
       INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES
         ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
         ('${partnerMemberId}'::uuid, '${spaceId}'::uuid,
          '${partnerUserId}'::uuid, 2);
       INSERT INTO plan_months
         (id, space_id, month_start, status, revision, created_at, updated_at)
       VALUES ('${monthId}'::uuid, '${spaceId}'::uuid, '2026-03-01', 'draft', 1, '${now.toISOString()}', '${now.toISOString()}');
       INSERT INTO plan_drafts (plan_month_id, focus, revision, created_at, updated_at)
       VALUES ('${monthId}'::uuid, 'Фокус', 1, '${now.toISOString()}', '${now.toISOString()}');
       INSERT INTO reminder_schedules
         (id, space_id, member_id, revision, time_zone, created_at, updated_at)
       VALUES ('${scheduleId}'::uuid, '${spaceId}'::uuid, '${memberId}'::uuid, 1, 'Asia/Yekaterinburg', '${now.toISOString()}', '${now.toISOString()}');
       INSERT INTO reminder_occurrences
         (id, space_id, recipient_member_id, schedule_id, local_date, slot_kind,
          schedule_revision, due_at, expires_at, state, lease_owner, lease_until,
          fencing_token, created_at, updated_at)
       VALUES
         ('${occurrenceId}'::uuid, '${spaceId}'::uuid, '${memberId}'::uuid, '${scheduleId}'::uuid,
          '2026-03-30', 'morning', 1, '2026-03-30T04:00:00Z', '2026-03-30T09:00:00Z',
          'claimed', 'worker-n02', '2026-03-30T08:00:00Z', 3, '${now.toISOString()}', '${now.toISOString()}'),
         ('${secondOccurrenceId}'::uuid, '${spaceId}'::uuid, '${memberId}'::uuid, '${scheduleId}'::uuid,
          '2026-03-30', 'day', 1, '2026-03-30T05:00:00Z', '2026-03-30T09:00:00Z',
          'claimed', 'worker-n02', '2026-03-30T08:00:00Z', 3, '${now.toISOString()}', '${now.toISOString()}');`,
    )
    await pool.query(
      `INSERT INTO command_receipts
        (actor_scope, command_type, command_id, fingerprint, result_kind,
         aggregate_id, aggregate_revision, completed_at)
       VALUES ('member:${memberId}', 'planning.publish-month.v1',
         '${publishCommandId}'::uuid, repeat('b', 64),
         'planning.plan-publication.v1', '${publicationId}'::uuid, 1,
         '${now.toISOString()}');
       INSERT INTO planning_action_groups
        (id, action_kind, actor_kind, actor_scope, member_id, system_actor_id,
         plan_month_id, command_type, command_id, before_revision,
         after_revision, occurred_at)
       VALUES ('${publishActionId}'::uuid, 'month_published', 'member',
         'member:${memberId}', '${memberId}'::uuid, NULL, '${monthId}'::uuid,
         'planning.publish-month.v1', '${publishCommandId}'::uuid, 1, 2,
         '${now.toISOString()}');
       INSERT INTO plan_publications
        (id, space_id, plan_month_id, publication_revision,
         source_draft_revision, source_plan_month_revision, focus,
         activation_mode, active_local_date, late_publication, time_zone,
         source_preview_schema_version, preview_hash_version, preview_hash,
         calendar_formula_version, evaluation_formula_version,
         score_formula_version, published_by_member_id, published_at)
       VALUES ('${publicationId}'::uuid, '${spaceId}'::uuid, '${monthId}'::uuid,
         1, 1, 1, 'Фокус', 'immediate', '2026-03-30', true,
         'Asia/Yekaterinburg', 'planner.publication-preview.v1',
         'planner.publication-preview-hash.v1', repeat('a', 64),
         'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
         'planner.score-coverage.v1', '${memberId}'::uuid, '${now.toISOString()}');
       INSERT INTO planning_publication_changes
         (action_id, publication_id, change_kind, confirmed_draft_revision,
          confirmed_preview_schema_version, confirmed_preview_hash_version,
          confirmed_preview_hash, before_active_publication_id,
          after_active_publication_id)
       VALUES ('${publishActionId}'::uuid, '${publicationId}'::uuid, 'published',
         1, 'planner.publication-preview.v1',
         'planner.publication-preview-hash.v1', repeat('a', 64), NULL,
         '${publicationId}'::uuid);
       UPDATE plan_months
          SET status = 'published', revision = 2, active_publication_id = '${publicationId}'::uuid
        WHERE id = '${monthId}'::uuid;`,
    )
    await pool.query('UPDATE reminder_occurrences SET updated_at = $1', [now])
    clock.set(now)
  })

  it('keeps one below-pace shared norm relevant for both viewers until the shared target suppresses both next-slot intents', async () => {
    const trustedActor = (
      id = memberId,
    ): { readonly kind: 'member'; readonly id: string } => ({
      kind: 'member' as const,
      id,
    })
    const draft = await planning.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(),
      payload: { targetMonth: '2026-04', focus: 'Общий темп' },
    })
    const definition = await planning.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(),
      payload: {
        title: 'Совместная норма',
        why: 'Проверка общего reminder progress',
        category: 'E01',
      },
    })
    await planning.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(),
      expectedRevision: draft.aggregateRevision,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'weekly', n: '2' },
          measurement: {
            kind: 'any_of',
            variants: [
              {
                variantId: null,
                label: 'Прогулка',
                unit: 'раз',
                precision: 0,
                target: '1',
              },
            ],
          },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await planning.buildPublicationPreview.execute({
      trustedUserId: userId,
      targetMonth: '2026-04',
    })
    if (preview === null) throw new Error('E01 shared preview missing')
    const publication = await planning.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshots = await pool.query<{
      readonly id: string
      readonly config: {
        readonly measurement: {
          readonly variants: readonly { readonly variantId: string }[]
        }
      }
    }>(
      `SELECT id::text, config
         FROM plan_goal_snapshots
        WHERE publication_id = $1::uuid`,
      [publication.aggregateId],
    )
    const snapshot = snapshots.rows[0]
    const variantId = snapshot?.config.measurement.variants[0]?.variantId
    if (snapshot === undefined || variantId === undefined) {
      throw new Error('E01 shared snapshot missing')
    }

    clock.set(new Date('2026-04-09T17:00:00.000Z'))
    await tracking.recordCompositeOccurrence.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(),
      payload: {
        publicationId: publication.aggregateId,
        planGoalSnapshotId: snapshot.id,
        localDate: '2026-04-09',
        component: { kind: 'or_variant', variantId, value: '1' },
      },
    })

    const partnerScheduleId = randomUUID()
    await pool.query(
      `INSERT INTO reminder_schedules
         (id, space_id, member_id, revision, time_zone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'Asia/Yekaterinburg',
               $4::timestamptz, $4::timestamptz)`,
      [partnerScheduleId, spaceId, partnerMemberId, '2026-04-12T02:59:00.000Z'],
    )
    await pool.query(
      `INSERT INTO reminder_occurrences
         (id, space_id, recipient_member_id, schedule_id, local_date, slot_kind,
          schedule_revision, due_at, expires_at, state, lease_owner,
          lease_until, fencing_token, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $2::uuid, $5::uuid, $6::uuid, '2026-04-12',
          'morning', 1, '2026-04-12T03:00:00Z', '2026-04-12T08:00:00Z',
          'pending', NULL, NULL, 0, $4::timestamptz, $4::timestamptz),
         (gen_random_uuid(), $2::uuid, $3::uuid, $1::uuid, '2026-04-12',
          'morning', 1, '2026-04-12T03:00:00Z', '2026-04-12T08:00:00Z',
          'pending', NULL, NULL, 0, $4::timestamptz, $4::timestamptz),
         (gen_random_uuid(), $2::uuid, $5::uuid, $6::uuid, '2026-04-12',
          'day', 1, '2026-04-12T08:00:00Z', '2026-04-12T19:00:00Z',
          'pending', NULL, NULL, 0, $4::timestamptz, $4::timestamptz),
         (gen_random_uuid(), $2::uuid, $3::uuid, $1::uuid, '2026-04-12',
          'day', 1, '2026-04-12T08:00:00Z', '2026-04-12T19:00:00Z',
          'pending', NULL, NULL, 0, $4::timestamptz, $4::timestamptz)`,
      [
        partnerScheduleId,
        spaceId,
        partnerMemberId,
        '2026-04-12T02:59:00.000Z',
        memberId,
        scheduleId,
      ],
    )

    const buildClaimed = async (
      instant: Date,
      leaseOwner: string,
    ): Promise<
      readonly Awaited<
        ReturnType<typeof reminders.buildReminderIntent.execute>
      >[]
    > => {
      clock.set(instant)
      const claims = await reminders.claimDueOccurrences.execute({
        leaseOwner,
        limit: 10,
        leaseDurationMs: 60_000,
      })
      const results = []
      for (const currentClaim of claims) {
        results.push(
          await reminders.buildReminderIntent.execute({
            claim: currentClaim,
            leaseOwner,
          }),
        )
      }
      return results
    }

    const partialResults = await buildClaimed(
      new Date('2026-04-12T03:00:00.000Z'),
      'worker-e01-shared-morning',
    )
    expect(partialResults).toHaveLength(2)
    expect(partialResults.map((result) => result.kind)).toEqual([
      'prepared',
      'prepared',
    ])
    const partialIntents = await pool.query<{
      readonly recipient_member_id: string
      readonly content: {
        readonly items: readonly {
          readonly kind: string
          readonly goalId: string
          readonly state: string
          readonly actualProgress: {
            readonly numerator: string
            readonly denominator: string
          } | null
        }[]
      }
    }>(
      `SELECT recipient_member_id::text, content
         FROM notification_intents
        WHERE local_date = '2026-04-12'
          AND slot_kind = 'morning'
        ORDER BY recipient_member_id`,
    )
    expect(partialIntents.rows.map((row) => row.recipient_member_id)).toEqual([
      memberId,
      partnerMemberId,
    ])
    for (const row of partialIntents.rows) {
      expect(row.content.items).toEqual([
        expect.objectContaining({
          kind: 'flexible',
          goalId: snapshot.id,
          state: 'pending',
          expectedProgress: 2,
          actualProgress: { numerator: '1', denominator: '1' },
        }),
      ])
    }

    clock.set(new Date('2026-04-12T03:01:00.000Z'))
    await tracking.recordCompositeOccurrence.execute({
      commandId: randomUUID(),
      trustedActor: trustedActor(partnerMemberId),
      payload: {
        publicationId: publication.aggregateId,
        planGoalSnapshotId: snapshot.id,
        localDate: '2026-04-12',
        component: { kind: 'or_variant', variantId, value: '1' },
      },
    })

    const completedResults = await buildClaimed(
      new Date('2026-04-12T08:00:00.000Z'),
      'worker-e01-shared-day',
    )
    expect(completedResults).toHaveLength(2)
    expect(completedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'suppressed' }),
        expect.objectContaining({ kind: 'suppressed' }),
      ]),
    )
    const completedOccurrences = await pool.query<{
      readonly recipient_member_id: string
      readonly state: string
    }>(
      `SELECT recipient_member_id::text, state
         FROM reminder_occurrences
        WHERE local_date = '2026-04-12'
          AND slot_kind = 'day'
        ORDER BY recipient_member_id`,
    )
    expect(completedOccurrences.rows).toEqual([
      { recipient_member_id: memberId, state: 'suppressed' },
      { recipient_member_id: partnerMemberId, state: 'suppressed' },
    ])
    const dayIntents = await pool.query<{ readonly count: number }>(
      `SELECT count(*)::int count
         FROM notification_intents
        WHERE local_date = '2026-04-12'
          AND slot_kind = 'day'`,
    )
    expect(dayIntents.rows[0]?.count).toBe(0)
  })

  it('creates one immutable intent, replays it, and appends a superseding revision', async () => {
    const first = await transaction.run(() =>
      persistence.persistIntent(
        persistInput(claim(occurrenceId), content('Вода')),
      ),
    )
    const replay = await transaction.run(() =>
      persistence.persistIntent(
        persistInput(claim(occurrenceId), content('Вода')),
      ),
    )
    const second = await transaction.run(() =>
      persistence.persistIntent(
        persistInput(claim(occurrenceId), content('Вода: обновлено'), 2n),
      ),
    )
    expect(first.kind).toBe('prepared')
    expect(replay).toEqual(first)
    expect(second).toMatchObject({ kind: 'prepared', intentRevision: 2n })
    const rows = await pool.query<{
      readonly id: string
      readonly intent_revision: string
      readonly supersedes_intent_id: string | null
      readonly content_hash: string
    }>(
      `SELECT id, intent_revision, supersedes_intent_id, content_hash
         FROM notification_intents
        WHERE occurrence_id = $1::uuid
        ORDER BY intent_revision`,
      [occurrenceId],
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]!.supersedes_intent_id).toBeNull()
    expect(rows.rows[1]!.supersedes_intent_id).toBe(rows.rows[0]!.id)
  })

  it('suppresses empty content atomically and rejects stale fencing without writes', async () => {
    const suppressed = await transaction.run(() =>
      persistence.persistIntent(persistInput(claim(secondOccurrenceId), null)),
    )
    expect(suppressed).toEqual({
      kind: 'suppressed',
      occurrenceId: secondOccurrenceId,
      reason: 'nothing_relevant',
    })
    const state = await pool.query(
      'SELECT state, lease_owner, lease_until FROM reminder_occurrences WHERE id = $1::uuid',
      [secondOccurrenceId],
    )
    expect(state.rows[0]).toMatchObject({
      state: 'suppressed',
      lease_owner: null,
      lease_until: null,
    })

    await expect(
      transaction.run(() =>
        persistence.persistIntent({
          ...persistInput(claim(occurrenceId), content('stale')),
          claim: { ...claim(occurrenceId), fencingToken: 99n },
        }),
      ),
    ).rejects.toBeInstanceOf(ReminderIntentClaimStaleError)
    const intents = await pool.query<{ readonly count: number }>(
      'SELECT count(*)::int AS count FROM notification_intents WHERE occurrence_id = $1::uuid',
      [occurrenceId],
    )
    expect(intents.rows[0]!.count).toBe(0)
  })

  it('rejects mutation of an immutable intent row', async () => {
    const prepared = await transaction.run(() =>
      persistence.persistIntent(
        persistInput(claim(occurrenceId), content('immutable')),
      ),
    )
    if (prepared.kind !== 'prepared')
      throw new Error('expected prepared intent')
    await expect(
      pool.query('DELETE FROM notification_intents WHERE id = $1::uuid', [
        prepared.intentId,
      ]),
    ).rejects.toThrow()
    const attempts = await pool.query<{ readonly count: number }>(
      'SELECT count(*)::int AS count FROM notification_attempts WHERE intent_id = $1::uuid',
      [prepared.intentId],
    )
    expect(attempts.rows[0]!.count).toBe(1)
  })
})
