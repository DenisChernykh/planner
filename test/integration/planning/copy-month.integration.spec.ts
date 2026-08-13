import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { Pool, type PoolClient } from 'pg'

import {
  createPlanningApplication,
  type PlanningApplication,
  type PublishedSnapshot,
} from '@/modules/planning'
import { CreateDraftFromPublicationCommand } from '@/modules/planning/application/create-draft-from-publication.command'
import type { CreateDraftFromPublicationApplicationCommand } from '@/modules/planning/application/planning.types'
import {
  type DraftCopyWritePhase,
  PrismaPlanDraftPersistence,
} from '@/modules/planning/infrastructure/prisma-plan-draft.persistence'
import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import type { CommandReceiptPort } from '@/shared/application/command-receipt.port'
import type { DurableCommandResultRef } from '@/shared/application/application-command'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { ProductClock } from '@/shared/application/product-clock'

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
      poolMax: 12,
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

type SourceFixture = {
  readonly planMonthId: string
  readonly publicationId: string
  readonly emptyPublicationId: string
  readonly snapshot: PublishedSnapshot
  readonly archivedDefinitionId: string
}

type CopyState = {
  readonly months: string
  readonly drafts: string
  readonly roots: string
  readonly revisions: string
  readonly publications: string
  readonly actions: string
  readonly details: string
  readonly receipts: string
}

describe('P09 copy immutable publication into a clean draft', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let application: PlanningApplication
  let clock: FakeProductClock
  let transaction: PrismaTransactionAdapter
  let members: PrismaWorkspaceMemberResolver
  let source: SourceFixture

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p09_integration')
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
    const context = new PrismaTransactionContext()
    provider = new PrismaClientProvider(config, context)
    await provider.connect(AbortSignal.timeout(2_000))
    transaction = new PrismaTransactionAdapter(provider, context, config)
    members = new PrismaWorkspaceMemberResolver(provider)
    clock = new FakeProductClock(new Date('2035-03-30T18:00:00.000Z'))
    application = createPlanningApplication({
      database: provider,
      transaction,
      workspaceMembers: members,
      clock,
    })
    source = await createSource()
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function createSource(): Promise<SourceFixture> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2035-04', focus: 'April immutable focus' },
    })
    const definitions: DurableCommandResultRef<'planning.goal-definition.v1'>[] =
      []
    for (const [title, why] of [
      ['Daily checklist', 'Preserve stable component IDs'],
      ['Weekly outreach', 'Preserve task text and ordinal'],
      ['Monthly shared quota', 'Preserve analytical series'],
    ] as const) {
      definitions.push(
        await application.createGoalDefinition.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          payload: { title, why, category: 'P09 integration' },
        }),
      )
    }

    let revision = 1n
    revision = (
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: revision,
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definitions[0]!.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'personal', ownerMemberId: firstMemberId },
            repetition: { kind: 'daily' },
            measurement: {
              kind: 'checklist',
              items: [
                { itemId: null, label: 'First stable item' },
                { itemId: null, label: 'Second stable item' },
              ],
            },
            checkpoints: null,
          },
          sourceProvenance: {
            schemaVersion: 1,
            sourceDocument: 'April.docx',
            sourcePage: 4,
            rawValue: '2 items',
            rawDenominator: null,
            resolution: 'approved P09 fixture',
          },
        },
      })
    ).aggregateRevision
    revision = (
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: revision,
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definitions[1]!.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'personal', ownerMemberId: secondMemberId },
            repetition: {
              kind: 'weekly_planned_task',
              weekOrdinal: '2',
              taskText: 'Write to fitness and yoga studios',
            },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      })
    ).aggregateRevision
    revision = (
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: revision,
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definitions[2]!.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'shared' },
            repetition: { kind: 'monthly', n: '2' },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      })
    ).aggregateRevision

    let editor = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2035-04',
    })
    if (editor === null) throw new Error('source editor missing')
    revision = (
      await application.reorderDraftGoals.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: revision,
        payload: {
          planMonthId: draft.aggregateId,
          orderedPlanGoalIds: [...editor.goals]
            .reverse()
            .map((goal) => goal.planGoalId),
        },
      })
    ).aggregateRevision
    editor = await application.getDraftEditor.execute({
      trustedActor: actor(),
      targetMonth: '2035-04',
    })
    if (editor === null) throw new Error('reordered editor missing')
    const checklist = editor.goals.find(
      (goal) => goal.goalDefinitionId === definitions[0]!.aggregateId,
    )
    if (checklist === undefined) throw new Error('checklist missing')
    await application.updateDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: revision,
      payload: {
        planMonthId: draft.aggregateId,
        planGoalId: checklist.planGoalId,
        goalDefinitionVersionId: checklist.goalDefinitionVersionId,
        config: checklist.config,
        sourceProvenance: checklist.sourceProvenance,
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2035-04',
    })
    if (preview === null) throw new Error('source preview missing')
    const published = await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(preview.draftRevision),
      payload: {
        planMonthId: draft.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })
    const snapshot = await application.getPublishedSnapshot.execute({
      trustedUserId: firstUserId,
      publicationId: published.aggregateId,
    })
    if (snapshot === null) throw new Error('source snapshot missing')
    await application.archiveGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: { goalDefinitionId: definitions[0]!.aggregateId },
    })
    await application.cancelPublication.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 2n,
      payload: {
        planMonthId: draft.aggregateId,
        publicationId: published.aggregateId,
      },
    })
    const emptyDraft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2035-03', focus: 'Empty immutable source' },
    })
    const emptyPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2035-03',
    })
    if (emptyPreview === null) throw new Error('empty preview missing')
    const emptyPublication = await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(emptyPreview.draftRevision),
      payload: {
        planMonthId: emptyDraft.aggregateId,
        previewSchemaVersion: emptyPreview.schemaVersion,
        previewHashVersion: emptyPreview.previewHashVersion,
        previewHash: emptyPreview.previewHash,
      },
    })
    return {
      planMonthId: draft.aggregateId,
      publicationId: published.aggregateId,
      emptyPublicationId: emptyPublication.aggregateId,
      snapshot,
      archivedDefinitionId: definitions[0]!.aggregateId,
    }
  }

  function copyCommand(
    targetMonth: string,
    commandId = randomUUID(),
  ): CreateDraftFromPublicationApplicationCommand {
    return {
      commandId,
      trustedActor: actor(),
      payload: {
        sourcePublicationId: source.publicationId,
        targetMonth,
      },
    }
  }

  async function sourceDigest(): Promise<string> {
    const result = await pool.query<{ readonly digest: string }>(
      `SELECT md5(COALESCE(string_agg(value, '|' ORDER BY value), '')) digest
         FROM (
           SELECT 'publication:' || to_jsonb(publication)::text ||
                  ':xmin=' || publication.xmin::text value
             FROM plan_publications publication
            WHERE publication.id = $1::uuid
           UNION ALL
           SELECT 'snapshot:' || to_jsonb(snapshot)::text ||
                  ':xmin=' || snapshot.xmin::text
             FROM plan_goal_snapshots snapshot
            WHERE snapshot.publication_id = $1::uuid
           UNION ALL
           SELECT 'fixed:' || to_jsonb(expectation)::text ||
                  ':xmin=' || expectation.xmin::text
             FROM fixed_expectations expectation
            WHERE expectation.publication_id = $1::uuid
           UNION ALL
           SELECT 'period:' || to_jsonb(period)::text ||
                  ':xmin=' || period.xmin::text
             FROM flexible_periods period
            WHERE period.publication_id = $1::uuid
         ) source_rows`,
      [source.publicationId],
    )
    return result.rows[0]!.digest
  }

  async function copyState(targetMonth: string): Promise<CopyState> {
    const result = await pool.query<CopyState>(
      `SELECT
         (SELECT count(*)::text FROM plan_months month
           WHERE month.space_id = $1::uuid
             AND month.month_start = ($2 || '-01')::date) months,
         (SELECT count(*)::text FROM plan_drafts draft
           JOIN plan_months month ON month.id = draft.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) drafts,
         (SELECT count(*)::text FROM plan_draft_goals root
           JOIN plan_months month ON month.id = root.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) roots,
         (SELECT count(*)::text FROM plan_draft_goal_revisions revision
           JOIN plan_draft_goals root ON root.id = revision.plan_goal_id
           JOIN plan_months month ON month.id = root.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) revisions,
         (SELECT count(*)::text FROM plan_publications publication
           JOIN plan_months month ON month.id = publication.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) publications,
         (SELECT count(*)::text FROM planning_action_groups action
           JOIN plan_months month ON month.id = action.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) actions,
         (SELECT count(*)::text FROM planning_month_copy_changes change
           JOIN planning_action_groups action ON action.id = change.action_id
           JOIN plan_months month ON month.id = action.plan_month_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date) details,
         (SELECT count(*)::text FROM command_receipts receipt
           JOIN plan_months month ON month.id = receipt.aggregate_id
          WHERE month.space_id = $1::uuid
            AND month.month_start = ($2 || '-01')::date
            AND receipt.command_type =
                'planning.create-draft-from-publication.v1') receipts`,
      [spaceId, targetMonth],
    )
    return result.rows[0]!
  }

  async function stageEmptyCopy(
    client: PoolClient,
    input: {
      readonly planMonthId: string
      readonly monthStart: string
      readonly actionId: string
      readonly commandId: string
      readonly commandType: string
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO plan_months
         (id, space_id, month_start, status, revision, facts_revision,
          active_publication_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, 'draft', 1, 0, NULL,
               transaction_timestamp(), transaction_timestamp())`,
      [input.planMonthId, spaceId, input.monthStart],
    )
    await client.query(
      `INSERT INTO plan_drafts
         (plan_month_id, focus, revision, created_at, updated_at)
       SELECT $1::uuid, publication.focus, 1,
              transaction_timestamp(), transaction_timestamp()
         FROM plan_publications publication
        WHERE publication.id = $2::uuid`,
      [input.planMonthId, source.emptyPublicationId],
    )
    await client.query(
      `INSERT INTO planning_action_groups
         (id, action_kind, actor_kind, actor_scope, member_id,
          system_actor_id, plan_month_id, goal_definition_id,
          command_type, command_id, before_revision, after_revision,
          occurred_at)
       VALUES ($1::uuid, 'draft_copied', 'member', $2, $3::uuid, NULL,
               $4::uuid, NULL, $5, $6::uuid, NULL, 1,
               transaction_timestamp())`,
      [
        input.actionId,
        `member:${firstMemberId}`,
        firstMemberId,
        input.planMonthId,
        input.commandType,
        input.commandId,
      ],
    )
    await client.query(
      `INSERT INTO planning_month_copy_changes
         (action_id, source_publication_id, copied_goal_count, after_order)
       VALUES ($1::uuid, $2::uuid, 0, ARRAY[]::uuid[])`,
      [input.actionId, source.emptyPublicationId],
    )
    await client.query(
      `INSERT INTO command_receipts
         (actor_scope, command_type, command_id, fingerprint, result_kind,
          aggregate_id, aggregate_revision, completed_at)
       VALUES ($1, $2, $3::uuid, repeat('b', 64),
               'planning.plan-draft.v1', $4::uuid, 1,
               transaction_timestamp())`,
      [
        `member:${firstMemberId}`,
        input.commandType,
        input.commandId,
        input.planMonthId,
      ],
    )
  }

  it('deploys the typed immutable migration contract', async () => {
    const migration = readFileSync(
      'prisma/migrations/20260811153000_copy_month/migration.sql',
      'utf8',
    )
    expect(migration).toContain('planning_month_copy_changes')
    expect(migration).toContain('draft_copied')
    expect(migration).toContain('planning.create-draft-from-publication.v1')
    expect(migration).not.toMatch(/UPDATE\s+plan_publications/iu)
    await expect(
      pool.query<{ readonly table_name: string | null }>(
        `SELECT to_regclass('planning_month_copy_changes')::text table_name`,
      ),
    ).resolves.toMatchObject({
      rows: [{ table_name: 'planning_month_copy_changes' }],
    })
    await expect(
      pool.query<{ readonly missing: string | null }>(
        `SELECT to_regclass('facts')::text missing`,
      ),
    ).resolves.toMatchObject({ rows: [{ missing: null }] })
  })

  it('copies a cancelled historical snapshot exactly into fresh editable identities', async () => {
    const beforeDigest = await sourceDigest()
    const commandId = randomUUID()
    const command = copyCommand('2035-05', commandId)
    const copied = await application.createDraftFromPublication.execute(command)
    expect(copied).toMatchObject({
      kind: 'planning.plan-draft.v1',
      aggregateRevision: 1n,
    })
    expect(copied.aggregateId).not.toBe(source.planMonthId)
    expect(await sourceDigest()).toBe(beforeDigest)

    const editor = await application.getDraftEditor.execute({
      trustedActor: actor(secondMemberId),
      targetMonth: '2035-05',
    })
    if (editor === null) throw new Error('copied editor missing')
    expect(editor).toMatchObject({
      planMonthId: copied.aggregateId,
      targetMonth: '2035-05',
      status: 'draft',
      focus: source.snapshot.focus,
      planMonthRevision: 1n,
      draftRevision: 1n,
    })
    expect(
      editor.goals.map((goal) => ({
        goalDefinitionId: goal.goalDefinitionId,
        goalDefinitionVersionId: goal.goalDefinitionVersionId,
        goalSeriesId: goal.goalSeriesId,
        displayOrder: goal.displayOrder,
        configRevision: goal.configRevision,
        config: goal.config,
        sourceProvenance: goal.sourceProvenance,
      })),
    ).toEqual(
      source.snapshot.goalSnapshots.map((goal) => ({
        goalDefinitionId: goal.sourceGoalDefinitionId,
        goalDefinitionVersionId: goal.sourceGoalDefinitionVersionId,
        goalSeriesId: goal.sourceGoalSeriesId,
        displayOrder: goal.displayOrder,
        configRevision: 1n,
        config: goal.config,
        sourceProvenance: goal.sourceProvenance,
      })),
    )
    expect(editor.goals.map((goal) => goal.planGoalId)).not.toEqual(
      source.snapshot.goalSnapshots.map((goal) => goal.sourcePlanGoalId),
    )
    expect(
      editor.goals.some(
        (goal) =>
          goal.goalDefinitionId === source.archivedDefinitionId &&
          goal.config.measurement.kind === 'checklist',
      ),
    ).toBe(true)
    expect(
      editor.goals.some(
        (goal) =>
          goal.config.repetition.kind === 'weekly_planned_task' &&
          goal.config.repetition.weekOrdinal === '2' &&
          goal.config.repetition.taskText ===
            'Write to fitness and yoga studios',
      ),
    ).toBe(true)
    expect(await copyState('2035-05')).toEqual({
      months: '1',
      drafts: '1',
      roots: '3',
      revisions: '3',
      publications: '0',
      actions: '1',
      details: '1',
      receipts: '1',
    })

    const unexpectedReplayBoundary = (): never => {
      throw new Error('exact replay crossed its durable receipt boundary')
    }
    const replayMembers: WorkspaceMemberResolver = {
      resolveMember: unexpectedReplayBoundary,
      resolveUser: unexpectedReplayBoundary,
      resolveTelegramId: unexpectedReplayBoundary,
    }
    const replayClock: ProductClock = {
      now: unexpectedReplayBoundary,
      today: unexpectedReplayBoundary,
    }
    const replayCommand = new CreateDraftFromPublicationCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        replayClock,
      ),
      replayMembers,
      new PrismaPlanDraftPersistence(provider),
    )
    await expect(replayCommand.execute(command)).resolves.toEqual(copied)
    expect(await copyState('2035-05')).toEqual({
      months: '1',
      drafts: '1',
      roots: '3',
      revisions: '3',
      publications: '0',
      actions: '1',
      details: '1',
      receipts: '1',
    })
    await expect(
      replayCommand.execute({
        ...command,
        payload: { ...command.payload, targetMonth: '2035-06' },
      }),
    ).rejects.toMatchObject({ name: 'CommandFingerprintConflictError' })
  })

  it('conceals unavailable sources and returns safe destination conflicts with zero writes', async () => {
    const missingMonth = '2035-07'
    await expect(
      application.createDraftFromPublication.execute({
        ...copyCommand(missingMonth),
        payload: {
          sourcePublicationId: randomUUID(),
          targetMonth: missingMonth,
        },
      }),
    ).rejects.toMatchObject({ name: 'PlanPublicationNotFoundError' })
    expect(await copyState(missingMonth)).toEqual({
      months: '0',
      drafts: '0',
      roots: '0',
      revisions: '0',
      publications: '0',
      actions: '0',
      details: '0',
      receipts: '0',
    })

    const foreignCommand = new CreateDraftFromPublicationCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      {
        resolveUser: members.resolveUser.bind(members),
        resolveTelegramId: members.resolveTelegramId.bind(members),
        resolveMember: () =>
          Promise.resolve({
            spaceId: randomUUID(),
            memberId: secondMemberId,
            userId: secondUserId,
          }),
      },
      new PrismaPlanDraftPersistence(provider),
    )
    await expect(
      foreignCommand.execute(copyCommand('2035-08')),
    ).rejects.toMatchObject({ name: 'PlanPublicationNotFoundError' })
    expect(await copyState('2035-08')).toEqual({
      months: '0',
      drafts: '0',
      roots: '0',
      revisions: '0',
      publications: '0',
      actions: '0',
      details: '0',
      receipts: '0',
    })

    const occupied = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2035-09', focus: 'Existing destination' },
    })
    const beforeOccupied = await copyState('2035-09')
    await expect(
      application.createDraftFromPublication.execute(copyCommand('2035-09')),
    ).rejects.toMatchObject({
      name: 'PlanMonthAlreadyExistsError',
      existingRef: {
        kind: 'planning.plan-draft.v1',
        aggregateId: occupied.aggregateId,
        aggregateRevision: 1n,
      },
    })
    expect(await copyState('2035-09')).toEqual(beforeOccupied)

    clock.set(new Date('2035-10-30T18:00:00.000Z'))
    const publishedDestination = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        targetMonth: '2035-11',
        focus: 'Existing published destination',
      },
    })
    const publishedPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2035-11',
    })
    if (publishedPreview === null) {
      throw new Error('published destination preview missing')
    }
    await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(publishedPreview.draftRevision),
      payload: {
        planMonthId: publishedDestination.aggregateId,
        previewSchemaVersion: publishedPreview.schemaVersion,
        previewHashVersion: publishedPreview.previewHashVersion,
        previewHash: publishedPreview.previewHash,
      },
    })
    const beforePublished = await copyState('2035-11')
    await expect(
      application.createDraftFromPublication.execute(copyCommand('2035-11')),
    ).rejects.toMatchObject({
      name: 'PlanMonthAlreadyExistsError',
      existingRef: { aggregateId: publishedDestination.aggregateId },
    })
    expect(await copyState('2035-11')).toEqual(beforePublished)

    const sourceState = await copyState('2035-04')
    await expect(
      application.createDraftFromPublication.execute(copyCommand('2035-04')),
    ).rejects.toMatchObject({
      name: 'PlanMonthAlreadyExistsError',
      existingRef: { aggregateId: source.planMonthId },
    })
    expect(await copyState('2035-04')).toEqual(sourceState)
  })

  it('serializes competing commands so exactly one destination is created', async () => {
    const outcomes = await Promise.allSettled([
      application.createDraftFromPublication.execute(copyCommand('2035-10')),
      application.createDraftFromPublication.execute(copyCommand('2035-10')),
    ])
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = outcomes.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { name: 'PlanMonthAlreadyExistsError' },
    })
    expect(await copyState('2035-10')).toEqual({
      months: '1',
      drafts: '1',
      roots: '3',
      revisions: '3',
      publications: '0',
      actions: '1',
      details: '1',
      receipts: '1',
    })
  })

  it('rolls back every copy write phase including the completed receipt', async () => {
    const phases: readonly DraftCopyWritePhase[] = [
      'month',
      'draft',
      'goal_roots',
      'goal_revisions',
      'goal_pointers',
      'history',
    ]
    for (const [index, selectedPhase] of phases.entries()) {
      const targetMonth = `2036-${String(index + 1).padStart(2, '0')}`
      const command = new CreateDraftFromPublicationCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        new PrismaPlanDraftPersistence(provider, (phase) => {
          if (phase === selectedPhase) throw new Error(`fail ${phase}`)
        }),
      )
      await expect(
        command.execute(copyCommand(targetMonth)),
      ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
      expect(await copyState(targetMonth)).toEqual({
        months: '0',
        drafts: '0',
        roots: '0',
        revisions: '0',
        publications: '0',
        actions: '0',
        details: '0',
        receipts: '0',
      })
    }

    const receiptTarget = '2036-07'
    const receipts = new PrismaCommandReceiptAdapter(provider)
    const failingReceipts: CommandReceiptPort = {
      acquireLock: receipts.acquireLock.bind(receipts),
      findCompleted: receipts.findCompleted.bind(receipts),
      insertCompleted: () => Promise.reject(new Error('fail receipt')),
    }
    const command = new CreateDraftFromPublicationCommand(
      new DurableCommandExecutor(transaction, failingReceipts, clock),
      members,
      new PrismaPlanDraftPersistence(provider),
    )
    await expect(
      command.execute(copyCommand(receiptTarget)),
    ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
    expect(await copyState(receiptTarget)).toEqual({
      months: '0',
      drafts: '0',
      roots: '0',
      revisions: '0',
      publications: '0',
      actions: '0',
      details: '0',
      receipts: '0',
    })
  })

  it('rejects orphan, mismatched and mutable direct-SQL copy history', async () => {
    const copied = await application.createDraftFromPublication.execute(
      copyCommand('2036-08'),
    )
    const detail = await pool.query<{ readonly action_id: string }>(
      `SELECT change.action_id::text
         FROM planning_month_copy_changes change
         JOIN planning_action_groups action ON action.id = change.action_id
        WHERE action.plan_month_id = $1::uuid`,
      [copied.aggregateId],
    )
    await expect(
      pool.query(
        `UPDATE planning_month_copy_changes SET copied_goal_count = 0
          WHERE action_id = $1::uuid`,
        [detail.rows[0]!.action_id],
      ),
    ).rejects.toThrow('immutable')
    await expect(
      pool.query(
        `DELETE FROM planning_month_copy_changes WHERE action_id = $1::uuid`,
        [detail.rows[0]!.action_id],
      ),
    ).rejects.toThrow('immutable')
    await expect(
      pool.query(
        `UPDATE plan_goal_snapshots SET display_order = display_order + 1
          WHERE publication_id = $1::uuid`,
        [source.publicationId],
      ),
    ).rejects.toThrow('immutable')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const target = randomUUID()
      const orphanCommandId = randomUUID()
      const actionId = randomUUID()
      await client.query(
        `INSERT INTO plan_months
           (id, space_id, month_start, status, revision, facts_revision,
            active_publication_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, DATE '2036-09-01', 'draft', 1, 0,
                 NULL, now(), now())`,
        [target, spaceId],
      )
      await client.query(
        `INSERT INTO plan_drafts
           (plan_month_id, focus, revision, created_at, updated_at)
         SELECT $1::uuid, focus, 1, now(), now()
           FROM plan_publications WHERE id = $2::uuid`,
        [target, source.publicationId],
      )
      await client.query(
        `INSERT INTO planning_action_groups
           (id, action_kind, actor_kind, actor_scope, member_id,
            system_actor_id, plan_month_id, goal_definition_id,
            command_type, command_id, before_revision, after_revision,
            occurred_at)
         VALUES ($1::uuid, 'draft_copied', 'member', $2, $3::uuid, NULL,
                 $4::uuid, NULL,
                 'planning.create-draft-from-publication.v1', $5::uuid,
                 NULL, 1, now())`,
        [
          actionId,
          `member:${firstMemberId}`,
          firstMemberId,
          target,
          orphanCommandId,
        ],
      )
      await client.query(
        `INSERT INTO command_receipts
           (actor_scope, command_type, command_id, fingerprint, result_kind,
            aggregate_id, aggregate_revision, completed_at)
         VALUES ($1, 'planning.create-draft-from-publication.v1', $2::uuid,
                 repeat('a', 64), 'planning.plan-draft.v1', $3::uuid, 1,
                 now())`,
        [`member:${firstMemberId}`, orphanCommandId, target],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }

    const mismatch = await pool.connect()
    try {
      await mismatch.query('BEGIN')
      const target = randomUUID()
      const actionId = randomUUID()
      await mismatch.query(
        `INSERT INTO plan_months
           (id, space_id, month_start, status, revision, facts_revision,
            active_publication_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, DATE '2036-10-01', 'draft', 1, 0,
                 NULL, now(), now())`,
        [target, spaceId],
      )
      await mismatch.query(
        `INSERT INTO plan_drafts
           (plan_month_id, focus, revision, created_at, updated_at)
         VALUES ($1::uuid, 'wrong focus', 1, now(), now())`,
        [target],
      )
      await mismatch.query(
        `INSERT INTO planning_action_groups
           (id, action_kind, actor_kind, actor_scope, member_id,
            system_actor_id, plan_month_id, goal_definition_id,
            command_type, command_id, before_revision, after_revision,
            occurred_at)
         VALUES ($1::uuid, 'draft_copied', 'member', $2, $3::uuid, NULL,
                 $4::uuid, NULL,
                 'planning.create-draft-from-publication.v1', $5::uuid,
                 NULL, 1, now())`,
        [
          actionId,
          `member:${firstMemberId}`,
          firstMemberId,
          target,
          randomUUID(),
        ],
      )
      await expect(
        mismatch.query(
          `INSERT INTO planning_month_copy_changes
             (action_id, source_publication_id, copied_goal_count, after_order)
           VALUES ($1::uuid, $2::uuid, 0, ARRAY[]::uuid[])`,
          [actionId, source.publicationId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await mismatch.query('ROLLBACK').catch(() => undefined)
      mismatch.release()
    }
  })

  it('defers exact command and final destination header constraints to commit', async () => {
    const foreignTypeTarget = randomUUID()
    const foreignType = await pool.connect()
    try {
      await foreignType.query('BEGIN')
      await expect(
        stageEmptyCopy(foreignType, {
          planMonthId: foreignTypeTarget,
          monthStart: '2037-01-01',
          actionId: randomUUID(),
          commandId: randomUUID(),
          commandType: 'planning.unrelated-copy.v1',
        }),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await foreignType.query('ROLLBACK').catch(() => undefined)
      foreignType.release()
    }
    expect(await copyState('2037-01')).toEqual({
      months: '0',
      drafts: '0',
      roots: '0',
      revisions: '0',
      publications: '0',
      actions: '0',
      details: '0',
      receipts: '0',
    })

    const changedHeaderTarget = randomUUID()
    const changedHeader = await pool.connect()
    try {
      await changedHeader.query('BEGIN')
      await stageEmptyCopy(changedHeader, {
        planMonthId: changedHeaderTarget,
        monthStart: '2037-02-01',
        actionId: randomUUID(),
        commandId: randomUUID(),
        commandType: 'planning.create-draft-from-publication.v1',
      })
      await changedHeader.query(
        `UPDATE plan_drafts
            SET focus = 'post-detail mutation', revision = 2,
                updated_at = transaction_timestamp()
          WHERE plan_month_id = $1::uuid`,
        [changedHeaderTarget],
      )
      await expect(changedHeader.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
      })
    } finally {
      await changedHeader.query('ROLLBACK').catch(() => undefined)
      changedHeader.release()
    }
    expect(await copyState('2037-02')).toEqual({
      months: '0',
      drafts: '0',
      roots: '0',
      revisions: '0',
      publications: '0',
      actions: '0',
      details: '0',
      receipts: '0',
    })
  })
})
