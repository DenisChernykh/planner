import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool } from 'pg'

import {
  createPlanningApplication,
  PlanMonthAlreadyExistsError,
  PlanSeedAlreadyConsumedError,
  type PlanningApplication,
  PlanningDependencyUnavailableError,
} from '@/modules/planning'
import { CreateDraftFromSeedCommand } from '@/modules/planning/application/create-draft-from-seed.command'
import type {
  CreateDraftFromSeedPersistenceInput,
  PlanDraftPersistencePort,
} from '@/modules/planning/application/plan-draft-persistence.port'
import type { CreateDraftFromSeedApplicationCommand } from '@/modules/planning/application/planning.types'
import {
  type SeedDraftWritePhase,
  PrismaPlanDraftPersistence,
} from '@/modules/planning/infrastructure/prisma-plan-draft.persistence'
import { PrismaSeedOwnerBinding } from '@/modules/planning/infrastructure/prisma-seed-owner-binding'
import { resolveAprilPlanSeed } from '@/modules/planning/seed/april-plan.seed'
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

function deployMigrations(databaseUrl: string): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  )
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`)
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
      poolMax: 12,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 500,
      transactionMaxWaitMs: 5_000,
      transactionTimeoutMs: 20_000,
    },
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

type SeedState = {
  readonly months: string
  readonly drafts: string
  readonly definitions: string
  readonly series: string
  readonly versions: string
  readonly roots: string
  readonly revisions: string
  readonly actions: string
  readonly consumptions: string
  readonly receipts: string
}

describe('P11 creates one complete draft from the immutable April seed', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let clock: FakeProductClock
  let application: PlanningApplication

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p11_integration')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    deployMigrations(postgres.getConnectionUri())
    pool = new Pool({ connectionString: postgres.getConnectionUri() })
    const config = databaseConfig(postgres.getConnectionUri())
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, config)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2035-03-30T18:00:00.123Z'))
    application = createPlanningApplication({
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

  async function resetPair(): Promise<void> {
    await pool.query('TRUNCATE spaces, users, command_receipts CASCADE')
    await pool.query(`
      INSERT INTO users (id) VALUES
        ('${firstUserId}'::uuid), ('${secondUserId}'::uuid);
      INSERT INTO spaces (id, singleton_key)
      VALUES ('${spaceId}'::uuid, 1);
      INSERT INTO memberships (id, space_id, user_id, slot) VALUES
        ('${firstMemberId}'::uuid, '${spaceId}'::uuid, '${firstUserId}'::uuid, 1),
        ('${secondMemberId}'::uuid, '${spaceId}'::uuid, '${secondUserId}'::uuid, 2);
    `)
  }

  async function state(): Promise<SeedState> {
    const result = await pool.query<SeedState>(`
      SELECT
        (SELECT count(*)::text FROM plan_months) months,
        (SELECT count(*)::text FROM plan_drafts) drafts,
        (SELECT count(*)::text FROM goal_definitions) definitions,
        (SELECT count(*)::text FROM goal_series) series,
        (SELECT count(*)::text FROM goal_definition_versions) versions,
        (SELECT count(*)::text FROM plan_draft_goals) roots,
        (SELECT count(*)::text FROM plan_draft_goal_revisions) revisions,
        (SELECT count(*)::text FROM planning_action_groups) actions,
        (SELECT count(*)::text FROM planning_seed_consumptions) consumptions,
        (SELECT count(*)::text FROM command_receipts) receipts
    `)
    return result.rows[0]!
  }

  function seedCommand(
    input: {
      readonly commandId?: string
      readonly memberId?: string
      readonly targetMonth?: string
      readonly actorPersona?: 'memberA' | 'memberB'
    } = {},
  ): CreateDraftFromSeedApplicationCommand {
    return {
      commandId: input.commandId ?? randomUUID(),
      trustedActor: actor(input.memberId),
      payload: {
        targetMonth: input.targetMonth ?? '2035-04',
        actorPersona: input.actorPersona ?? 'memberA',
      },
    }
  }

  it.each([
    {
      label: 'the actor as MemberA',
      actorPersona: 'memberA' as const,
      denisMemberId: firstMemberId,
      tanyaMemberId: secondMemberId,
    },
    {
      label: 'the actor as MemberB',
      actorPersona: 'memberB' as const,
      denisMemberId: secondMemberId,
      tanyaMemberId: firstMemberId,
    },
  ])('materializes exact seed data with $label', async (mapping) => {
    await resetPair()
    const command = seedCommand({ actorPersona: mapping.actorPersona })
    const result = await application.createDraftFromSeed.execute(command)
    expect(result).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: 1n,
    })

    const editor = await application.getDraftEditor.execute({
      trustedActor: actor(secondMemberId),
      targetMonth: '2035-04',
    })
    if (editor === null) throw new Error('seeded editor missing')
    const seed = resolveAprilPlanSeed({
      denisMemberId: mapping.denisMemberId,
      tanyaMemberId: mapping.tanyaMemberId,
    })
    expect(editor).toMatchObject({
      planMonthId: result.aggregateId,
      targetMonth: '2035-04',
      status: 'draft',
      focus: seed.focus,
      planMonthRevision: 1n,
      draftRevision: 1n,
      blockers: [],
    })
    expect(
      editor.goals.map((goal) => ({
        title: goal.title,
        why: goal.why,
        category: goal.category,
        displayOrder: goal.displayOrder,
        configRevision: goal.configRevision,
        config: goal.config,
        sourceProvenance: goal.sourceProvenance,
        blockers: goal.blockers,
      })),
    ).toEqual(
      seed.goals.map((goal, displayOrder) => ({
        title: goal.title,
        why: goal.why,
        category: goal.category,
        displayOrder,
        configRevision: 1n,
        config: goal.config,
        sourceProvenance: goal.sourceProvenance,
        blockers: [],
      })),
    )
    expect(new Set(editor.goals.map((goal) => goal.planGoalId))).toHaveProperty(
      'size',
      41,
    )
    expect(
      new Set(editor.goals.map((goal) => goal.goalDefinitionId)),
    ).toHaveProperty('size', 41)
    expect(
      new Set(editor.goals.map((goal) => goal.goalSeriesId)),
    ).toHaveProperty('size', 41)

    const audit = await pool.query<{
      readonly actor_persona: string
      readonly member_a_member_id: string
      readonly member_b_member_id: string
      readonly seeded_goal_count: number
      readonly exact_shape: boolean
      readonly catalog_changes: string
      readonly publications: string
      readonly snapshots: string
      readonly expectations: string
      readonly periods: string
    }>(
      `SELECT consumption.actor_persona,
              consumption.member_a_member_id::text,
              consumption.member_b_member_id::text,
              consumption.seeded_goal_count,
              p11_seed_consumption_has_exact_shape(consumption.action_id)
                exact_shape,
              (SELECT count(*)::text FROM planning_goal_catalog_changes
                WHERE goal_definition_id = ANY(consumption.goal_definition_ids))
                catalog_changes,
              (SELECT count(*)::text FROM plan_publications
                WHERE plan_month_id = consumption.plan_month_id) publications,
              (SELECT count(*)::text FROM plan_goal_snapshots
                WHERE plan_month_id = consumption.plan_month_id) snapshots,
              (SELECT count(*)::text FROM fixed_expectations expectation
                JOIN plan_goal_snapshots snapshot
                  ON snapshot.id = expectation.plan_goal_snapshot_id
               WHERE snapshot.plan_month_id = consumption.plan_month_id)
                expectations,
              (SELECT count(*)::text FROM flexible_periods period
                JOIN plan_goal_snapshots snapshot
                  ON snapshot.id = period.plan_goal_snapshot_id
               WHERE snapshot.plan_month_id = consumption.plan_month_id) periods
         FROM planning_seed_consumptions consumption`,
    )
    expect(audit.rows).toEqual([
      {
        actor_persona: mapping.actorPersona,
        member_a_member_id: mapping.denisMemberId,
        member_b_member_id: mapping.tanyaMemberId,
        seeded_goal_count: 41,
        exact_shape: true,
        catalog_changes: '0',
        publications: '0',
        snapshots: '0',
        expectations: '0',
        periods: '0',
      },
    ])
    expect(await state()).toEqual({
      months: '1',
      drafts: '1',
      definitions: '41',
      series: '41',
      versions: '41',
      roots: '41',
      revisions: '41',
      actions: '1',
      consumptions: '1',
      receipts: '1',
    })
  })

  it('replays revision one after edits and gives fingerprint/consumed conflicts precedence', async () => {
    await resetPair()
    const command = seedCommand({ commandId: randomUUID() })
    const created = await application.createDraftFromSeed.execute(command)
    await application.updateMonthFocus.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: created.aggregateId,
        focus: 'Changed after seed',
      },
    })

    await expect(
      application.createDraftFromSeed.execute(command),
    ).resolves.toEqual(created)
    await expect(
      application.createDraftFromSeed.execute({
        ...command,
        payload: { ...command.payload, targetMonth: '2035-05' },
      }),
    ).rejects.toMatchObject({ name: 'CommandFingerprintConflictError' })
    await expect(
      application.createDraftFromSeed.execute(
        seedCommand({ targetMonth: '2035-05', actorPersona: 'memberB' }),
      ),
    ).rejects.toEqual(
      new PlanSeedAlreadyConsumedError(created.aggregateId, 'april-plan', 1),
    )
    expect(await state()).toMatchObject({
      months: '1',
      consumptions: '1',
      receipts: '2',
    })
  })

  it.each(['draft', 'published'] as const)(
    'returns the existing %s destination without consuming the seed',
    async (status) => {
      await resetPair()
      const existing = await application.createEmptyDraft.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: { targetMonth: '2035-04', focus: 'Existing destination' },
      })
      if (status === 'published') {
        const preview = await application.buildPublicationPreview.execute({
          trustedUserId: firstUserId,
          targetMonth: '2035-04',
        })
        if (preview === null) throw new Error('preview missing')
        await application.publishMonth.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId: existing.aggregateId,
            previewSchemaVersion: preview.schemaVersion,
            previewHashVersion: preview.previewHashVersion,
            previewHash: preview.previewHash,
          },
        })
      }

      await expect(
        application.createDraftFromSeed.execute(seedCommand()),
      ).rejects.toEqual(
        new PlanMonthAlreadyExistsError({
          kind: 'planning.plan-draft.v1',
          aggregateId: existing.aggregateId,
          aggregateRevision: 1n,
        }),
      )
      const after = await state()
      expect(after).toMatchObject({
        months: '1',
        definitions: '0',
        consumptions: '0',
      })
    },
  )

  it('rejects foreign actors and broken member pairs without writes', async () => {
    await resetPair()
    await expect(
      application.createDraftFromSeed.execute(
        seedCommand({ memberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      ),
    ).rejects.toMatchObject({ name: 'PlanningAuthorizationDeniedError' })
    expect(await state()).toMatchObject({ months: '0', consumptions: '0' })

    await pool.query('DELETE FROM memberships WHERE id = $1::uuid', [
      secondMemberId,
    ])
    await expect(
      application.createDraftFromSeed.execute(seedCommand()),
    ).rejects.toBeInstanceOf(PlanningDependencyUnavailableError)
    expect(await state()).toMatchObject({ months: '0', consumptions: '0' })
  })

  it('serializes competing seed selections so only one target is created', async () => {
    await resetPair()
    const settled = await Promise.allSettled([
      application.createDraftFromSeed.execute(
        seedCommand({ targetMonth: '2035-04', actorPersona: 'memberA' }),
      ),
      application.createDraftFromSeed.execute(
        seedCommand({ targetMonth: '2035-05', actorPersona: 'memberB' }),
      ),
    ])
    const fulfilled = settled.filter((value) => value.status === 'fulfilled')
    const rejected = settled.filter((value) => value.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(PlanSeedAlreadyConsumedError)
    expect(await state()).toEqual({
      months: '1',
      drafts: '1',
      definitions: '41',
      series: '41',
      versions: '41',
      roots: '41',
      revisions: '41',
      actions: '1',
      consumptions: '1',
      receipts: '1',
    })
  })

  it('rolls back every seed write phase and the completed receipt', async () => {
    const phases: readonly SeedDraftWritePhase[] = [
      'month',
      'draft',
      'definitions',
      'series',
      'definition_versions',
      'goal_roots',
      'goal_revisions',
      'goal_pointers',
      'action',
      'consumption',
    ]
    for (const phase of phases) {
      await resetPair()
      const persistence = new PrismaPlanDraftPersistence(
        provider,
        undefined,
        (current) => {
          if (current === phase) throw new Error(`failpoint:${phase}`)
        },
      )
      const command = new CreateDraftFromSeedCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        new PrismaSeedOwnerBinding(provider),
        persistence,
      )
      await expect(command.execute(seedCommand())).rejects.toBeInstanceOf(
        PlanningDependencyUnavailableError,
      )
      expect(await state()).toEqual({
        months: '0',
        drafts: '0',
        definitions: '0',
        series: '0',
        versions: '0',
        roots: '0',
        revisions: '0',
        actions: '0',
        consumptions: '0',
        receipts: '0',
      })
    }
  })

  it('rechecks final draft state after consumption insertion at commit', async () => {
    await resetPair()
    const persistence = new PrismaPlanDraftPersistence(
      provider,
      undefined,
      async (phase) => {
        if (phase !== 'consumption') return
        await provider.withClient(async (client) => {
          await client.planDraft.updateMany({
            data: { focus: 'Mutated after consumption detail' },
          })
        })
      },
    )
    const command = new CreateDraftFromSeedCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      new PrismaSeedOwnerBinding(provider),
      persistence,
    )
    await expect(command.execute(seedCommand())).rejects.toBeInstanceOf(
      PlanningDependencyUnavailableError,
    )
    expect(await state()).toMatchObject({
      months: '0',
      actions: '0',
      consumptions: '0',
      receipts: '0',
    })
  })

  it('rejects a complete but semantically forged 41-goal seed effect', async () => {
    await resetPair()
    const persistence = new PrismaPlanDraftPersistence(provider)
    const forgedPersistence: PlanDraftPersistencePort = {
      createEmptyDraft: persistence.createEmptyDraft.bind(persistence),
      createFromPublication:
        persistence.createFromPublication.bind(persistence),
      createFromSeed: (input: CreateDraftFromSeedPersistenceInput) =>
        persistence.createFromSeed({
          ...input,
          seed: {
            ...input.seed,
            goals: input.seed.goals.map((goal, index) =>
              index === 0
                ? {
                    ...goal,
                    title: 'Forged but structurally valid seed title',
                    config: {
                      ...goal.config,
                      measurement: {
                        kind: 'actual_time' as const,
                        start: '08:01',
                        end: '09:30',
                      },
                    },
                    sourceProvenance: {
                      ...goal.sourceProvenance,
                      resolution: 'Forged provenance resolution.',
                    },
                  }
                : goal,
            ),
          },
        }),
      updateFocus: persistence.updateFocus.bind(persistence),
      findDraft: persistence.findDraft.bind(persistence),
    }
    const command = new CreateDraftFromSeedCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      new PrismaSeedOwnerBinding(provider),
      forgedPersistence,
    )

    await expect(command.execute(seedCommand())).rejects.toBeInstanceOf(
      PlanningDependencyUnavailableError,
    )
    expect(await state()).toEqual({
      months: '0',
      drafts: '0',
      definitions: '0',
      series: '0',
      versions: '0',
      roots: '0',
      revisions: '0',
      actions: '0',
      consumptions: '0',
      receipts: '0',
    })
  })

  it('rejects orphan and mutable direct-SQL seed history', async () => {
    await resetPair()
    const created = await application.createDraftFromSeed.execute(seedCommand())
    await expect(
      pool.query(
        `UPDATE planning_seed_consumptions SET seed_version = 1
          WHERE plan_month_id = $1::uuid`,
        [created.aggregateId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        'DELETE FROM planning_seed_consumptions WHERE plan_month_id = $1::uuid',
        [created.aggregateId],
      ),
    ).rejects.toMatchObject({ code: '55000' })

    await resetPair()
    const orphanMonthId = randomUUID()
    const orphanActionId = randomUUID()
    const orphanCommandId = randomUUID()
    await pool.query(
      `INSERT INTO plan_months
         (id, space_id, month_start, status, revision, facts_revision,
          active_publication_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '2035-04-01', 'draft', 1, 0, NULL,
               '2035-03-30T18:00:00.123Z', '2035-03-30T18:00:00.123Z')`,
      [orphanMonthId, spaceId],
    )
    await pool.query(
      `INSERT INTO plan_drafts
         (plan_month_id, focus, revision, created_at, updated_at)
       VALUES ($1::uuid, 'Показатель 108', 1,
               '2035-03-30T18:00:00.123Z', '2035-03-30T18:00:00.123Z')`,
      [orphanMonthId],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO command_receipts
           (actor_scope, command_type, command_id, fingerprint, result_kind,
            aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'planning.create-draft-from-seed.v1', $2::uuid,
                 repeat('a', 64), 'planning.plan-draft.v1', $3::uuid, 1,
                 '2035-03-30T18:00:00.123Z')`,
        [`member:${firstMemberId}`, orphanCommandId, orphanMonthId],
      )
      await client.query(
        `INSERT INTO planning_action_groups
           (id, action_kind, actor_kind, actor_scope, member_id,
            system_actor_id, plan_month_id, goal_definition_id, command_type,
            command_id, before_revision, after_revision, occurred_at)
         VALUES ($1::uuid, 'draft_created_from_seed', 'member', $2,
                 $3::uuid, NULL, $4::uuid, NULL,
                 'planning.create-draft-from-seed.v1', $5::uuid, NULL, 1,
                 '2035-03-30T18:00:00.123Z')`,
        [
          orphanActionId,
          `member:${firstMemberId}`,
          firstMemberId,
          orphanMonthId,
          orphanCommandId,
        ],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    expect(await state()).toMatchObject({ actions: '0', consumptions: '0' })
  })

  it('pins exact command, receipt and deferred shape in the migration', () => {
    const migration = readFileSync(
      'prisma/migrations/20260811155000_seed_consumption/migration.sql',
      'utf8',
    )
    expect(migration).toContain(
      "parent.command_type = 'planning.create-draft-from-seed.v1'",
    )
    expect(migration).toContain(
      "receipt.result_kind = 'planning.plan-draft.v1'",
    )
    expect(migration).toContain(
      'p11_seed_consumption_has_exact_shape(action.id)',
    )
    expect(migration).toContain('current_manifest <> expected_manifest')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain(
      'planning_seed_consumptions_reject_update_delete',
    )
  })
})
