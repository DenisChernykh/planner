import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  type CancelPublicationApplicationCommand,
  createPlanningApplication,
  type PlanningApplication,
  type PublicationPreview,
  type PublishMonthApplicationCommand,
} from '@/modules/planning'
import { CancelPublicationCommand } from '@/modules/planning/application/cancel-publication.command'
import { RepublishMonthCommand } from '@/modules/planning/application/republish-month.command'
import {
  PrismaPublicationPersistence,
  type PublicationWritePhase,
} from '@/modules/planning/infrastructure/prisma-publication.persistence'
import {
  createTrackingApplication,
  type TrackingApplication,
} from '@/modules/tracking'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

function deployMigrations(databaseUrl: string): {
  readonly exitCode: number
  readonly output: string
} {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  }
}

function databaseConfig(url: string): {
  readonly database: {
    readonly url: string
    readonly poolMax: number
    readonly connectionTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly healthTimeoutMs: number
    readonly transactionMaxWaitMs: number
    readonly transactionTimeoutMs: number
  }
} {
  return {
    database: {
      url,
      poolMax: 8,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 15_000,
    },
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

type Fixture = {
  readonly planMonthId: string
  readonly targetMonth: string
  readonly preview: PublicationPreview
}

type PlanState = {
  readonly status: string
  readonly month_revision: string
  readonly facts_revision: string
  readonly active_publication_id: string | null
  readonly publications: string
  readonly publication_changes: string
  readonly lifecycle_actions: string
  readonly p08_receipts: string
}

type PublicationStorage = {
  readonly preview_hash: string
  readonly publication_xmin: string
  readonly snapshots: string
  readonly fixed_expectations: string
  readonly flexible_periods: string
  readonly snapshot_digest: string
  readonly fixed_digest: string
  readonly flexible_digest: string
}

describe('P08 cancel and republish in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let application: PlanningApplication
  let tracking: TrackingApplication
  let clock: FakeProductClock
  let transaction: PrismaTransactionAdapter
  let transactionContext: PrismaTransactionContext
  let members: PrismaWorkspaceMemberResolver

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p08_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const migration = deployMigrations(postgres.getConnectionUri())
    if (migration.exitCode !== 0) throw new Error(migration.output)
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
    const config = databaseConfig(postgres.getConnectionUri())
    transactionContext = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, transactionContext)
    await provider.connect(AbortSignal.timeout(2_000))
    clock = new FakeProductClock(new Date('2031-01-31T18:00:00.000Z'))
    transaction = new PrismaTransactionAdapter(
      provider,
      transactionContext,
      config,
    )
    members = new PrismaWorkspaceMemberResolver(provider)
    application = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    tracking = createTrackingApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function fixture(targetMonth: string): Promise<Fixture> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth, focus: `P08 ${targetMonth}` },
    })
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        title: `P08 daily ${targetMonth}`,
        why: 'Prove retained expectations',
        category: 'Integration',
      },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: draft.aggregateId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'personal', ownerMemberId: firstMemberId },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth,
    })
    if (preview === null) throw new Error('publication preview missing')
    return { planMonthId: draft.aggregateId, targetMonth, preview }
  }

  function publicationCommand(
    selected: Fixture,
    commandId = randomUUID(),
  ): PublishMonthApplicationCommand {
    return {
      commandId,
      trustedActor: actor(),
      expectedRevision: BigInt(selected.preview.draftRevision),
      payload: {
        planMonthId: selected.planMonthId,
        previewSchemaVersion: selected.preview.schemaVersion,
        previewHashVersion: selected.preview.previewHashVersion,
        previewHash: selected.preview.previewHash,
      },
    }
  }

  function cancellationCommand(
    selected: Fixture,
    publicationId: string,
    planMonthRevision: bigint,
    commandId = randomUUID(),
  ): CancelPublicationApplicationCommand {
    return {
      commandId,
      trustedActor: actor(),
      expectedRevision: planMonthRevision,
      payload: { planMonthId: selected.planMonthId, publicationId },
    }
  }

  async function state(planMonthId: string): Promise<PlanState> {
    const result = await pool.query<PlanState>(
      `SELECT month.status, month.revision::text month_revision,
              month.facts_revision::text facts_revision,
              month.active_publication_id::text,
              (SELECT count(*)::text FROM plan_publications publication
                WHERE publication.plan_month_id = month.id) publications,
              (SELECT count(*)::text
                 FROM planning_publication_changes change
                 JOIN plan_publications publication
                   ON publication.id = change.publication_id
                WHERE publication.plan_month_id = month.id) publication_changes,
              (SELECT count(*)::text FROM planning_action_groups action
                WHERE action.plan_month_id = month.id
                  AND action.action_kind IN (
                    'month_published', 'month_publication_cancelled'
                  )) lifecycle_actions,
              (SELECT count(*)::text FROM command_receipts receipt
                WHERE receipt.command_type IN (
                  'planning.cancel-publication.v1',
                  'planning.republish-month.v1'
                ) AND receipt.aggregate_id IN (month.id,
                  COALESCE(month.active_publication_id, month.id))) p08_receipts
         FROM plan_months month WHERE month.id = $1::uuid`,
      [planMonthId],
    )
    return result.rows[0]!
  }

  async function publicationStorage(
    publicationId: string,
  ): Promise<PublicationStorage> {
    const result = await pool.query<PublicationStorage>(
      `SELECT publication.preview_hash,
              publication.xmin::text publication_xmin,
              (SELECT count(*)::text FROM plan_goal_snapshots snapshot
                WHERE snapshot.publication_id = publication.id) snapshots,
              (SELECT count(*)::text FROM fixed_expectations expectation
                WHERE expectation.publication_id = publication.id)
                fixed_expectations,
              (SELECT count(*)::text FROM flexible_periods period
                WHERE period.publication_id = publication.id) flexible_periods,
              COALESCE((SELECT md5(string_agg(to_jsonb(snapshot)::text, '|'
                                             ORDER BY snapshot.id))
                FROM plan_goal_snapshots snapshot
               WHERE snapshot.publication_id = publication.id), md5(''))
                snapshot_digest,
              COALESCE((SELECT md5(string_agg(to_jsonb(expectation)::text, '|'
                                             ORDER BY expectation.id))
                FROM fixed_expectations expectation
               WHERE expectation.publication_id = publication.id), md5(''))
                fixed_digest,
              COALESCE((SELECT md5(string_agg(to_jsonb(period)::text, '|'
                                             ORDER BY period.id))
                FROM flexible_periods period
               WHERE period.publication_id = publication.id), md5(''))
                flexible_digest
         FROM plan_publications publication
        WHERE publication.id = $1::uuid`,
      [publicationId],
    )
    return result.rows[0]!
  }

  it('adds the dedicated migration contract', () => {
    const migration = readFileSync(
      'prisma/migrations/20260811152000_cancel_republish/migration.sql',
      'utf8',
    )
    expect(migration).toContain('facts_revision')
    expect(migration).toContain('planning.cancel-publication.v1')
    expect(migration).toContain('planning.republish-month.v1')
    expect(migration).not.toMatch(/UPDATE\s+plan_publications/iu)
  })

  it('cancels, replays, returns an editable draft and republishes an immutable revision 2', async () => {
    clock.set(new Date('2031-01-31T18:00:00.000Z'))
    const selected = await fixture('2031-02')
    const unpublishedState = await state(selected.planMonthId)
    await expect(
      application.republishMonth.execute(publicationCommand(selected)),
    ).rejects.toMatchObject({
      name: 'PlanPublicationModeConflictError',
      requiredMode: 'publish',
      latestPublicationRevision: null,
    })
    expect(await state(selected.planMonthId)).toEqual(unpublishedState)
    const first = await application.publishMonth.execute(
      publicationCommand(selected),
    )
    expect(first.aggregateRevision).toBe(1n)
    const originalStorage = await publicationStorage(first.aggregateId)
    expect(originalStorage).toMatchObject({
      snapshots: '1',
      fixed_expectations: '28',
      flexible_periods: '0',
    })

    const commandId = randomUUID()
    const cancel = cancellationCommand(
      selected,
      first.aggregateId,
      2n,
      commandId,
    )
    const cancelled = await application.cancelPublication.execute(cancel)
    expect(cancelled).toEqual({
      kind: 'planning.plan-month.v1',
      aggregateId: selected.planMonthId,
      aggregateRevision: 3n,
    })
    expect(await state(selected.planMonthId)).toMatchObject({
      status: 'draft',
      month_revision: '3',
      facts_revision: '0',
      active_publication_id: null,
      publications: '1',
      publication_changes: '2',
      lifecycle_actions: '2',
    })
    expect(await publicationStorage(first.aggregateId)).toEqual(originalStorage)
    await expect(
      application.getPublishedSnapshot.execute({
        trustedUserId: firstUserId,
        publicationId: first.aggregateId,
      }),
    ).resolves.toMatchObject({ publicationId: first.aggregateId })

    clock.set(new Date('2031-01-31T19:00:00.000Z'))
    await expect(
      application.cancelPublication.execute(cancel),
    ).resolves.toEqual(cancelled)
    await expect(
      application.cancelPublication.execute({
        ...cancel,
        payload: { ...cancel.payload, publicationId: randomUUID() },
      }),
    ).rejects.toMatchObject({ name: 'CommandFingerprintConflictError' })

    await application.updateMonthFocus.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(selected.preview.draftRevision),
      payload: {
        planMonthId: selected.planMonthId,
        focus: 'P08 republished focus',
      },
    })
    clock.set(new Date('2031-01-31T18:30:00.000Z'))
    const nextPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: selected.targetMonth,
    })
    if (nextPreview === null) throw new Error('republish preview missing')
    const republishFixture = { ...selected, preview: nextPreview }
    await expect(
      application.publishMonth.execute(publicationCommand(republishFixture)),
    ).rejects.toMatchObject({
      name: 'PlanPublicationModeConflictError',
      requiredMode: 'republish',
      latestPublicationRevision: 1n,
    })

    const second = await application.republishMonth.execute(
      publicationCommand(republishFixture),
    )
    expect(second).toMatchObject({
      kind: 'planning.plan-publication.v1',
      aggregateRevision: 2n,
    })
    expect(second.aggregateId).not.toBe(first.aggregateId)
    expect(await state(selected.planMonthId)).toMatchObject({
      status: 'published',
      month_revision: '4',
      facts_revision: '0',
      active_publication_id: second.aggregateId,
      publications: '2',
      publication_changes: '3',
      lifecycle_actions: '3',
    })
    expect(await publicationStorage(first.aggregateId)).toEqual(originalStorage)
    expect(await publicationStorage(second.aggregateId)).toMatchObject({
      snapshots: '1',
      fixed_expectations: '28',
      flexible_periods: '0',
    })
  })

  it('rejects started month, existing facts and stale lifecycle revision with zero writes', async () => {
    const cases = [
      {
        month: '2031-04',
        publishAt: '2031-03-31T18:00:00.000Z',
        cancelAt: '2031-03-31T19:00:00.000Z',
        reason: 'month_started',
        facts: false,
        expectedRevision: 2n,
        errorName: 'PlanPublicationCancellationConflictError',
      },
      {
        month: '2031-05',
        publishAt: '2031-04-30T18:00:00.000Z',
        cancelAt: '2031-04-30T18:30:00.000Z',
        reason: 'facts_exist',
        facts: true,
        expectedRevision: 2n,
        errorName: 'PlanPublicationCancellationConflictError',
      },
      {
        month: '2031-06',
        publishAt: '2031-05-31T18:00:00.000Z',
        cancelAt: '2031-05-31T18:30:00.000Z',
        reason: undefined,
        facts: false,
        expectedRevision: 1n,
        errorName: 'PlanMonthRevisionConflictError',
      },
    ] as const

    for (const item of cases) {
      clock.set(new Date(item.publishAt))
      const selected = await fixture(item.month)
      const published = await application.publishMonth.execute(
        publicationCommand(selected),
      )
      if (item.facts) {
        const snapshot = await pool.query<{ readonly id: string }>(
          `SELECT id::text
             FROM plan_goal_snapshots
            WHERE publication_id = $1::uuid`,
          [published.aggregateId],
        )
        clock.set(new Date('2031-04-30T19:00:00.000Z'))
        await tracking.recordFact.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: {
            publicationId: published.aggregateId,
            planGoalSnapshotId: snapshot.rows[0]!.id,
            localDate: '2031-05-01',
            value: { kind: 'boolean', result: 'done' },
          },
        })
      }
      clock.set(new Date(item.cancelAt))
      const before = await state(selected.planMonthId)
      const promise = application.cancelPublication.execute(
        cancellationCommand(
          selected,
          published.aggregateId,
          item.expectedRevision,
        ),
      )
      await expect(promise).rejects.toMatchObject({
        name: item.errorName,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      })
      expect(await state(selected.planMonthId)).toEqual(before)
    }
  })

  it('conceals missing and foreign publications and rejects a second cancellation as inactive', async () => {
    clock.set(new Date('2031-06-30T18:00:00.000Z'))
    const selected = await fixture('2031-07')
    const published = await application.publishMonth.execute(
      publicationCommand(selected),
    )
    const before = await state(selected.planMonthId)
    await expect(
      application.cancelPublication.execute(
        cancellationCommand(selected, randomUUID(), 2n),
      ),
    ).rejects.toMatchObject({ name: 'PlanPublicationNotFoundError' })

    const foreignMembers = {
      resolveUser: members.resolveUser.bind(members),
      resolveTelegramId: members.resolveTelegramId.bind(members),
      resolveMember: () =>
        Promise.resolve({
          spaceId: randomUUID(),
          memberId: secondMemberId,
          userId: secondUserId,
        }),
    }
    const foreignCommand = new CancelPublicationCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      foreignMembers,
      new PrismaPublicationPersistence(provider),
    )
    await expect(
      foreignCommand.execute(
        cancellationCommand(selected, published.aggregateId, 2n, randomUUID()),
      ),
    ).rejects.toMatchObject({ name: 'PlanPublicationNotFoundError' })
    expect(await state(selected.planMonthId)).toEqual(before)

    await application.cancelPublication.execute(
      cancellationCommand(selected, published.aggregateId, 2n),
    )
    const after = await state(selected.planMonthId)
    await expect(
      application.cancelPublication.execute(
        cancellationCommand(selected, published.aggregateId, 3n),
      ),
    ).rejects.toMatchObject({
      name: 'PlanPublicationCancellationConflictError',
      reason: 'not_active',
    })
    expect(await state(selected.planMonthId)).toEqual(after)
  })

  it('rolls back every republish write phase and then succeeds once', async () => {
    clock.set(new Date('2031-07-31T18:00:00.000Z'))
    const selected = await fixture('2031-08')
    const first = await application.publishMonth.execute(
      publicationCommand(selected),
    )
    await application.cancelPublication.execute(
      cancellationCommand(selected, first.aggregateId, 2n),
    )
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: selected.targetMonth,
    })
    if (preview === null) throw new Error('rollback preview missing')
    const republishFixture = { ...selected, preview }
    const phases: readonly PublicationWritePhase[] = [
      'publication',
      'goal_snapshots',
      'fixed_expectations',
      'flexible_periods',
      'month_pointer',
      'history',
    ]

    for (const selectedPhase of phases) {
      const before = await state(selected.planMonthId)
      const command = new RepublishMonthCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        new PrismaPublicationPersistence(provider, (phase) => {
          if (phase === selectedPhase) throw new Error(`fail ${phase}`)
        }),
      )
      await expect(
        command.execute(publicationCommand(republishFixture)),
      ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
      expect(await state(selected.planMonthId)).toEqual(before)
    }

    await expect(
      application.republishMonth.execute(publicationCommand(republishFixture)),
    ).resolves.toMatchObject({ aggregateRevision: 2n })
  })

  it('rejects direct cancellation without the exact immutable history and receipt', async () => {
    clock.set(new Date('2031-08-31T18:00:00.000Z'))
    const selected = await fixture('2031-09')
    await application.publishMonth.execute(publicationCommand(selected))
    const before = await state(selected.planMonthId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE plan_months
            SET status = 'draft', revision = revision + 1,
                active_publication_id = NULL,
                updated_at = TIMESTAMPTZ '2031-08-31 18:30:00+00'
          WHERE id = $1::uuid`,
        [selected.planMonthId],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    expect(await state(selected.planMonthId)).toEqual(before)
  })
})
