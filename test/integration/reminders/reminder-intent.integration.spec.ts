import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  ReminderIntentClaimStaleError,
  PrismaNotificationIntentPersistence,
} from '@/modules/reminders'
import type {
  PersistReminderIntentInput,
  ReminderOccurrenceClaim,
  ReminderRenderedContentV1,
} from '@/modules/reminders'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const userId = '11111111-1111-4111-8111-111111111111'
const spaceId = '33333333-3333-4333-8333-333333333333'
const memberId = '44444444-4444-4444-8444-444444444444'
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
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(
      `INSERT INTO users (id) VALUES ('${userId}'::uuid);
       INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
       INSERT INTO memberships (id, space_id, user_id, slot)
       VALUES ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1);
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
    ).rejects.toThrow('Notification intents are immutable')
  })
})
