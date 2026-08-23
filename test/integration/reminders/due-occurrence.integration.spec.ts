import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createRemindersApplication,
  ReminderScheduleRevisionConflictError,
} from '@/modules/reminders'
import { CommandFingerprintConflictError } from '@/shared/application/application-command'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaReminderSchedulePersistence } from '@/modules/reminders/infrastructure/prisma-reminder-schedule.persistence'
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

const migrationsThroughN01 = [
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
] as const

const rawTailMigrationsAfterN01 = [
  '20260811220000_notification_intents',
  '20260811230000_notification_attempts',
  '20260811240000_reminder_worker_retry',
  '20260812000000_report_revisions',
  '20260812010000_reopen_month',
  '20260812020000_reclose_month',
] as const

describe('N01 reminder schedules and due occurrences on PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let clock: FakeProductClock
  let reminders: ReturnType<typeof createRemindersApplication>
  let persistence: PrismaReminderSchedulePersistence

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_n01_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    for (const migration of migrationsThroughN01) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    for (const migration of rawTailMigrationsAfterN01) {
      await pool.query(
        readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
      )
    }
    const runtimeConfig = {
      database: {
        url: postgres.getConnectionUri(),
        poolMax: 12,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 5_000,
        healthTimeoutMs: 500,
        transactionMaxWaitMs: 5_000,
        transactionTimeoutMs: 30_000,
      },
    }
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(runtimeConfig, context)
    await provider.connect(AbortSignal.timeout(3_000))
    transaction = new PrismaTransactionAdapter(provider, context, runtimeConfig)
    clock = new FakeProductClock(new Date('2026-03-30T01:00:00.000Z'))
    reminders = createRemindersApplication({
      database: provider,
      transaction,
      workspaceMembers: new PrismaWorkspaceMemberResolver(provider),
      clock,
    })
    persistence = new PrismaReminderSchedulePersistence(provider)
  }, 120_000)

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(3_000)).catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await postgres?.stop().catch(() => undefined)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${userId}'::uuid), ('${partnerUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${memberId}'::uuid, '${spaceId}'::uuid, '${userId}'::uuid, 1),
        ('${partnerMemberId}'::uuid, '${spaceId}'::uuid,
         '${partnerUserId}'::uuid, 2);
    `)
    clock.set(new Date('2026-03-30T01:00:00.000Z'))
  })

  function commandId(): string {
    return randomUUID()
  }

  function savePayload(
    overrides?: Partial<Record<'morning' | 'day' | 'evening', string | null>>,
  ): {
    readonly timeZone: 'Asia/Yekaterinburg'
    readonly morning: string | null
    readonly day: string | null
    readonly evening: string | null
  } {
    return {
      timeZone: 'Asia/Yekaterinburg' as const,
      morning: '08:00',
      day: '13:00',
      evening: '19:00',
      ...overrides,
    }
  }

  function actor(id = memberId): {
    readonly kind: 'member'
    readonly id: string
  } {
    return { kind: 'member', id }
  }

  it('persists a personal schedule, replays durably, and reconciles future occurrences', async () => {
    const firstCommand = commandId()
    const created = await reminders.saveReminderSchedule.execute({
      commandId: firstCommand,
      trustedActor: actor(),
      payload: savePayload(),
    })
    expect(created.aggregateRevision).toBe(1n)
    const revisionOneOccurrences = await pool.query<{
      readonly id: string
      readonly local_date: string
      readonly slot_kind: string
    }>(
      `SELECT id, local_date::text local_date, slot_kind
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
        ORDER BY local_date, slot_kind`,
    )

    const replay = await reminders.saveReminderSchedule.execute({
      commandId: firstCommand,
      trustedActor: actor(),
      payload: savePayload(),
    })
    expect(replay).toEqual(created)
    await expect(
      reminders.saveReminderSchedule.execute({
        commandId: firstCommand,
        trustedActor: actor(),
        payload: savePayload({ morning: '09:00' }),
      }),
    ).rejects.toBeInstanceOf(CommandFingerprintConflictError)

    clock.set(new Date('2026-03-30T02:00:00.000Z'))
    const updated = await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: savePayload({ morning: '09:00', day: '14:00', evening: null }),
    })
    expect(updated.aggregateRevision).toBe(2n)

    await expect(
      reminders.saveReminderSchedule.execute({
        commandId: commandId(),
        trustedActor: actor(),
        expectedRevision: 1n,
        payload: savePayload(),
      }),
    ).rejects.toBeInstanceOf(ReminderScheduleRevisionConflictError)

    const occurrences = await pool.query<{
      readonly id: string
      readonly local_date: string
      readonly slot_kind: string
      readonly state: string
      readonly due_at: Date
      readonly expires_at: Date
    }>(
      `SELECT id, local_date::text local_date, slot_kind, state, due_at, expires_at
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
        ORDER BY local_date, slot_kind`,
    )
    expect(occurrences.rows).toHaveLength(6)
    expect(
      occurrences.rows.map(({ id, local_date, slot_kind }) => ({
        id,
        local_date,
        slot_kind,
      })),
    ).toEqual(revisionOneOccurrences.rows)
    expect(
      occurrences.rows.filter((row) => row.local_date === '2026-03-30'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot_kind: 'morning', state: 'pending' }),
        expect.objectContaining({ slot_kind: 'day', state: 'pending' }),
        expect.objectContaining({ slot_kind: 'evening', state: 'cancelled' }),
      ]),
    )
    expect(
      occurrences.rows.filter((row) => row.slot_kind === 'morning'),
    ).toHaveLength(2)
    expect(
      occurrences.rows.find(
        (row) => row.local_date === '2026-03-30' && row.slot_kind === 'morning',
      ),
    ).toMatchObject({
      due_at: new Date('2026-03-30T04:00:00.000Z'),
      expires_at: new Date('2026-03-30T09:00:00.000Z'),
    })

    const history = await pool.query<{
      readonly actor_scope: string
      readonly command_type: string
      readonly command_id: string
      readonly before_revision: string | null
      readonly after_revision: string
    }>(
      `SELECT actor_scope, command_type, command_id,
              before_revision, after_revision
         FROM reminder_schedule_changes
        WHERE member_id = '${memberId}'::uuid
        ORDER BY after_revision`,
    )
    expect(history.rows).toHaveLength(2)
    expect(history.rows[0]).toMatchObject({
      actor_scope: `member:${memberId}`,
      command_type: 'reminders.save-schedule.v1',
      before_revision: null,
      after_revision: '1',
    })
    expect(history.rows[1]).toMatchObject({
      actor_scope: `member:${memberId}`,
      command_type: 'reminders.save-schedule.v1',
      before_revision: '1',
      after_revision: '2',
    })
    const receipts = await pool.query<{
      readonly actor_scope: string
      readonly command_type: string
      readonly command_id: string
      readonly result_kind: string
      readonly aggregate_revision: string
    }>(
      `SELECT actor_scope, command_type, command_id, result_kind,
              aggregate_revision
         FROM command_receipts
        WHERE actor_scope = 'member:${memberId}'
          AND command_type = 'reminders.save-schedule.v1'
        ORDER BY aggregate_revision`,
    )
    expect(receipts.rows).toHaveLength(2)
    expect(receipts.rows.map((row) => row.result_kind)).toEqual([
      'reminders.schedule.v1',
      'reminders.schedule.v1',
    ])
    expect(receipts.rows.map((row) => row.aggregate_revision)).toEqual([
      '1',
      '2',
    ])
    expect(history.rows.map((row) => row.command_id)).toEqual(
      expect.arrayContaining(receipts.rows.map((row) => row.command_id)),
    )
  })

  it('sets expiry at the next local slot and local midnight', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    const rows = await pool.query<{
      readonly slot_kind: string
      readonly due_at: Date
      readonly expires_at: Date
    }>(
      `SELECT slot_kind, due_at, expires_at
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
          AND local_date = '2026-03-30'
        ORDER BY due_at`,
    )
    expect(rows.rows).toEqual([
      {
        slot_kind: 'morning',
        due_at: new Date('2026-03-30T03:00:00.000Z'),
        expires_at: new Date('2026-03-30T08:00:00.000Z'),
      },
      {
        slot_kind: 'day',
        due_at: new Date('2026-03-30T08:00:00.000Z'),
        expires_at: new Date('2026-03-30T14:00:00.000Z'),
      },
      {
        slot_kind: 'evening',
        due_at: new Date('2026-03-30T14:00:00.000Z'),
        expires_at: new Date('2026-03-30T19:00:00.000Z'),
      },
    ])
  })

  it('defers a newly configured past time until the next local day', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    clock.set(new Date('2026-03-30T02:00:00.000Z'))
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: savePayload({ morning: '06:00', evening: null }),
    })

    const morning = await pool.query<{
      readonly due_at: Date
      readonly expires_at: Date
      readonly state: string
    }>(
      `SELECT due_at, expires_at, state
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
          AND local_date = '2026-03-30'
          AND slot_kind = 'morning'`,
    )
    expect(morning.rows[0]).toMatchObject({
      due_at: new Date('2026-03-30T03:00:00.000Z'),
      expires_at: new Date('2026-03-30T08:00:00.000Z'),
      state: 'pending',
    })
    const beforeDue = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-deferred',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(beforeDue).toHaveLength(0)

    clock.set(new Date('2026-03-30T03:00:00.000Z'))
    const atOldDue = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-deferred',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(atOldDue.map((claim) => claim.slotKind)).toEqual(['morning'])
  })

  it('does not create a past occurrence when first enabling a schedule late today', async () => {
    clock.set(new Date('2026-03-30T04:00:00.000Z'))
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload({ evening: null }),
    })
    const rows = await pool.query<{ readonly local_date: string }>(
      `SELECT local_date::text local_date
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
          AND slot_kind = 'morning'`,
    )
    expect(rows.rows).toEqual([{ local_date: '2026-03-31' }])
    await expect(
      reminders.claimDueOccurrences.execute({
        leaseOwner: 'worker-initial-past',
        limit: 10,
        leaseDurationMs: 1_000,
      }),
    ).resolves.toHaveLength(0)
  })

  it('reschedules the active past occurrence to the new expiry boundary', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    clock.set(new Date('2026-03-30T04:00:00.000Z'))
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: savePayload({ day: '10:00', evening: null }),
    })

    const morning = await pool.query<{
      readonly state: string
      readonly due_at: Date
      readonly expires_at: Date
    }>(
      `SELECT state, due_at, expires_at
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
          AND local_date = '2026-03-30'
          AND slot_kind = 'morning'`,
    )
    expect(morning.rows[0]).toMatchObject({
      state: 'pending',
      due_at: new Date('2026-03-30T03:00:00.000Z'),
      expires_at: new Date('2026-03-30T05:00:00.000Z'),
    })

    clock.set(new Date('2026-03-30T05:30:00.000Z'))
    const claimed = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-reschedule',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(claimed.map((claim) => claim.slotKind)).toEqual(['day'])
  })

  it('keeps earlier active windows when a later slot moved into the past', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    clock.set(new Date('2026-03-30T07:00:00.000Z'))
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: savePayload({ day: '10:00' }),
    })

    const morning = await pool.query<{
      readonly due_at: Date
      readonly expires_at: Date
      readonly state: string
    }>(
      `SELECT due_at, expires_at, state
         FROM reminder_occurrences
        WHERE recipient_member_id = '${memberId}'::uuid
          AND local_date = '2026-03-30'
          AND slot_kind = 'morning'`,
    )
    expect(morning.rows[0]).toMatchObject({
      due_at: new Date('2026-03-30T03:00:00.000Z'),
      expires_at: new Date('2026-03-30T08:00:00.000Z'),
      state: 'pending',
    })

    clock.set(new Date('2026-03-30T08:00:00.000Z'))
    const atOldBoundary = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-later-slot',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(atOldBoundary.map((claim) => claim.slotKind)).toEqual(['day'])
  })

  it('claims in order, reclaims expired leases with a new fence, and does not catch up expired windows', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    clock.set(new Date('2026-03-30T02:59:59.000Z'))
    const first = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-a',
      limit: 1,
      leaseDurationMs: 1_000,
    })
    expect(first).toHaveLength(0)

    clock.set(new Date('2026-03-30T03:00:01.000Z'))
    const claimed = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-a',
      limit: 1,
      leaseDurationMs: 1_000,
    })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ slotKind: 'morning', fencingToken: 1n })

    clock.set(new Date('2026-03-30T03:00:02.050Z'))
    await expect(
      persistence.transitionClaim({
        occurrenceId: claimed[0]!.occurrenceId,
        leaseOwner: 'worker-a',
        fencingToken: claimed[0]!.fencingToken,
        nextState: 'cancelled',
        now: clock.now(),
      }),
    ).resolves.toBe(false)

    clock.set(new Date('2026-03-30T03:00:02.100Z'))
    const reclaimed = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-b',
      limit: 1,
      leaseDurationMs: 1_000,
    })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]!.occurrenceId).toBe(claimed[0]!.occurrenceId)
    expect(reclaimed[0]!.fencingToken).toBe(3n)
    await expect(
      persistence.transitionClaim({
        occurrenceId: claimed[0]!.occurrenceId,
        leaseOwner: 'worker-a',
        fencingToken: claimed[0]!.fencingToken,
        nextState: 'cancelled',
        now: clock.now(),
      }),
    ).resolves.toBe(false)
    await expect(
      persistence.transitionClaim({
        occurrenceId: reclaimed[0]!.occurrenceId,
        leaseOwner: 'worker-b',
        fencingToken: reclaimed[0]!.fencingToken,
        nextState: 'cancelled',
        now: clock.now(),
      }),
    ).resolves.toBe(true)

    clock.set(new Date('2026-04-01T20:30:00.000Z'))
    const afterDowntime = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-c',
      limit: 100,
      leaseDurationMs: 1_000,
    })
    expect(afterDowntime).toHaveLength(0)
    const states = await pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text count
         FROM reminder_occurrences
        GROUP BY state
        ORDER BY state`,
    )
    expect(states.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'expired' })]),
    )
  })

  it('materializes later local days without generating downtime catch-up', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload({ day: null, evening: null }),
    })

    clock.set(new Date('2026-03-31T03:00:00.000Z'))
    const thirdDay = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-third-day',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(thirdDay).toHaveLength(1)
    expect(thirdDay[0]).toMatchObject({
      localDate: '2026-03-31',
      slotKind: 'morning',
    })

    clock.set(new Date('2026-04-01T03:00:00.000Z'))
    const fourthDay = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-fourth-day',
      limit: 10,
      leaseDurationMs: 1_000,
    })
    expect(fourthDay).toHaveLength(1)
    expect(fourthDay[0]).toMatchObject({
      localDate: '2026-04-01',
      slotKind: 'morning',
    })
  })

  it('disabling a slot terminalizes a claimed occurrence and invalidates its fence', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      payload: savePayload(),
    })
    clock.set(new Date('2026-03-30T03:00:01.000Z'))
    const claimed = await reminders.claimDueOccurrences.execute({
      leaseOwner: 'worker-disable',
      limit: 1,
      leaseDurationMs: 10_000,
    })
    expect(claimed).toHaveLength(1)

    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: savePayload({ morning: null }),
    })
    const row = await pool.query<{
      readonly state: string
      readonly fencing_token: string
    }>(
      `SELECT state, fencing_token
         FROM reminder_occurrences
        WHERE id = '${claimed[0]!.occurrenceId}'::uuid`,
    )
    expect(row.rows[0]).toEqual({ state: 'cancelled', fencing_token: '2' })
    await expect(
      persistence.transitionClaim({
        occurrenceId: claimed[0]!.occurrenceId,
        leaseOwner: 'worker-disable',
        fencingToken: claimed[0]!.fencingToken,
        nextState: 'cancelled',
        now: clock.now(),
      }),
    ).resolves.toBe(false)
  })

  it('keeps schedules isolated per member', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(memberId),
      payload: savePayload({ morning: '07:00' }),
    })
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(partnerMemberId),
      payload: savePayload({ morning: '09:00' }),
    })
    const rows = await pool.query<{ member_id: string; morning: string }>(
      `SELECT schedule.member_id, slot.local_time::text morning
         FROM reminder_schedules schedule
         JOIN reminder_schedule_slots slot ON slot.schedule_id = schedule.id
        WHERE slot.slot_kind = 'morning'
        ORDER BY schedule.member_id`,
    )
    expect(rows.rows).toEqual([
      { member_id: memberId, morning: '07:00:00' },
      { member_id: partnerMemberId, morning: '09:00:00' },
    ])
  })

  it('enforces recipient and schedule ownership with a composite foreign key', async () => {
    await reminders.saveReminderSchedule.execute({
      commandId: commandId(),
      trustedActor: actor(memberId),
      payload: savePayload(),
    })
    const schedule = await pool.query<{ readonly id: string }>(
      `SELECT id
         FROM reminder_schedules
        WHERE member_id = '${memberId}'::uuid`,
    )
    await expect(
      pool.query(
        `INSERT INTO reminder_occurrences
          (id, space_id, recipient_member_id, schedule_id, local_date,
           slot_kind, schedule_revision, due_at, expires_at, state,
           fencing_token, created_at, updated_at)
         VALUES ('${randomUUID()}'::uuid, '${spaceId}'::uuid,
                 '${partnerMemberId}'::uuid, '${schedule.rows[0]!.id}'::uuid,
                 '2026-03-30'::date, 'morning', 1,
                 '2026-03-30T03:00:00Z', '2026-03-30T08:00:00Z',
                 'pending', 0, now(), now())`,
      ),
    ).rejects.toThrow()
  })
})
