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
  type PlanningApplication,
} from '@/modules/planning'
import { PrismaWorkspaceMemberResolver } from '@/modules/workspace/infrastructure/prisma-workspace-member.resolver'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { PrismaCommandReceiptAdapter } from '@/platform/database/prisma-command-receipt.adapter'
import { PrismaTransactionAdapter } from '@/platform/database/prisma-transaction.adapter'
import { PrismaTransactionContext } from '@/platform/database/prisma-transaction.context'
import { FakeProductClock } from '@/platform/time/fake-product-clock'
import { DurableCommandExecutor } from '@/shared/application/durable-command.executor'
import type { CommandReceiptPort } from '@/shared/application/command-receipt.port'
import { PublishMonthCommand } from '@/modules/planning/application/publish-month.command'
import {
  PrismaPublicationPersistence,
  type PublicationWritePhase,
} from '@/modules/planning/infrastructure/prisma-publication.persistence'

const POSTGRES_IMAGE =
  'postgres:18.4-trixie@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const firstMemberId = '44444444-4444-4444-8444-444444444444'
const secondMemberId = '55555555-5555-4555-8555-555555555555'

type PublicationApplication = PlanningApplication & {
  readonly publishMonth: {
    execute(command: Record<string, unknown>): Promise<{
      readonly kind: string
      readonly aggregateId: string
      readonly aggregateRevision: bigint
    }>
  }
  readonly getPublishedSnapshot: {
    execute(
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>
  }
  readonly getActiveMonth: {
    execute(
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>
  }
}

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

async function executeMigration(pool: Pool, sql: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(sql)
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function databaseConfig(
  url: string,
  transactionTimeoutMs = 15_000,
): {
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
      transactionTimeoutMs,
    },
  }
}

function actor(memberId = firstMemberId): {
  readonly kind: 'member'
  readonly id: string
} {
  return { kind: 'member', id: memberId }
}

const P03_PRESERVED_TABLES = [
  'plan_months',
  'plan_drafts',
  'goal_definitions',
  'goal_series',
  'goal_definition_versions',
  'plan_draft_goals',
  'plan_draft_goal_revisions',
  'planning_action_groups',
  'planning_month_focus_changes',
  'planning_goal_catalog_changes',
  'planning_draft_goal_changes',
  'command_receipts',
] as const

type PgConstraintInventory = {
  readonly table_name: string
  readonly name: string
  readonly type: 'check' | 'primary' | 'unique' | 'foreign'
  readonly definition: string
  readonly deferrable: boolean
  readonly deferred: boolean
}

function constraint(
  table_name: string,
  name: string,
  type: PgConstraintInventory['type'],
  definition: string,
  deferrable = false,
  deferred = false,
): PgConstraintInventory {
  return { table_name, name, type, definition, deferrable, deferred }
}

const EXPECTED_P07_CONSTRAINTS: readonly PgConstraintInventory[] = [
  constraint(
    'fixed_expectations',
    'fixed_expectations_component_check',
    'check',
    `CHECK (((((component_kind)::text = 'goal'::text) AND (component_id IS NULL)) OR (((component_kind)::text = ANY ((ARRAY['checkpoint'::character varying, 'checklist_item'::character varying])::text[])) AND (component_id IS NOT NULL))))`,
  ),
  constraint(
    'fixed_expectations',
    'fixed_expectations_pkey',
    'primary',
    'PRIMARY KEY (id)',
  ),
  constraint(
    'fixed_expectations',
    'fixed_expectations_publication_snapshot_fkey',
    'foreign',
    'FOREIGN KEY (publication_id, plan_goal_snapshot_id) REFERENCES plan_goal_snapshots(publication_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'fixed_expectations',
    'fixed_expectations_stable_key',
    'unique',
    'UNIQUE NULLS NOT DISTINCT (publication_id, plan_goal_snapshot_id, expectation_date, component_id)',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_bounds_check',
    'check',
    'CHECK ((((ordinal >= 1) AND (ordinal <= 6)) AND (period_start <= period_end) AND (period_target >= 0)))',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_dates_check',
    'check',
    'CHECK ((p07_date_array_is_sorted_unique(active_dates) AND p07_date_array_is_sorted_unique(eligible_dates) AND (active_dates = eligible_dates) AND p07_dates_inside(active_dates, period_start, period_end)))',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_kind_check',
    'check',
    `CHECK (((period_kind)::text = ANY ((ARRAY['weekly'::character varying, 'monthly'::character varying, 'weekly_planned_task'::character varying])::text[])))`,
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_ordinal_key',
    'unique',
    'UNIQUE (publication_id, plan_goal_snapshot_id, period_kind, ordinal)',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_pkey',
    'primary',
    'PRIMARY KEY (id)',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_publication_snapshot_fkey',
    'foreign',
    'FOREIGN KEY (publication_id, plan_goal_snapshot_id) REFERENCES plan_goal_snapshots(publication_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_shape_check',
    'check',
    `CHECK (((((period_kind)::text = 'weekly'::text) AND (period_days = 7) AND ((period_target = 0) = (cardinality(eligible_dates) = 0)) AND (period_target <= cardinality(eligible_dates))) OR (((period_kind)::text = 'monthly'::text) AND ((period_days >= 28) AND (period_days <= 31)) AND ((period_target = 0) = (cardinality(eligible_dates) = 0)) AND (period_target <= cardinality(eligible_dates))) OR (((period_kind)::text = 'weekly_planned_task'::text) AND (period_days IS NULL) AND (period_target = 1) AND (cardinality(active_dates) = 0) AND (cardinality(eligible_dates) = 0))))`,
  ),
  constraint(
    'flexible_periods',
    'flexible_periods_stable_key',
    'unique',
    'UNIQUE (publication_id, plan_goal_snapshot_id, period_kind, period_start, period_end)',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_calendar_check',
    'check',
    `CHECK ((((jsonb_typeof(calendar) = 'object'::text) AND ((calendar ->> 'kind'::text) = ANY (ARRAY['fixed'::text, 'quota'::text, 'weekly_planned_task'::text]))) IS TRUE))`,
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_config_check',
    'check',
    `CHECK ((jsonb_typeof(config) = 'object'::text))`,
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_definition_version_fkey',
    'foreign',
    'FOREIGN KEY (goal_definition_id, goal_definition_version_id) REFERENCES goal_definition_versions(goal_definition_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_metadata_check',
    'check',
    `CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200) AND (btrim(why) <> ''::text) AND (char_length(why) <= 2000) AND (btrim(category) <> ''::text) AND (char_length(category) <= 100)))`,
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_owner_fkey',
    'foreign',
    'FOREIGN KEY (space_id, owner_member_id) REFERENCES memberships(space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_pkey',
    'primary',
    'PRIMARY KEY (id)',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_provenance_check',
    'check',
    `CHECK (((source_provenance IS NULL) OR (jsonb_typeof(source_provenance) = 'object'::text)))`,
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_publication_fkey',
    'foreign',
    'FOREIGN KEY (plan_month_id, publication_id) REFERENCES plan_publications(plan_month_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_publication_id_key',
    'unique',
    'UNIQUE (publication_id, id)',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_publication_order_key',
    'unique',
    'UNIQUE (publication_id, display_order)',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_publication_source_key',
    'unique',
    'UNIQUE (publication_id, source_plan_goal_id)',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_revision_order_check',
    'check',
    'CHECK (((source_config_revision >= 1) AND ((display_order >= 0) AND (display_order <= 199))))',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_scope_check',
    'check',
    `CHECK (((((scope_kind)::text = 'personal'::text) AND (owner_member_id IS NOT NULL)) OR (((scope_kind)::text = 'shared'::text) AND (owner_member_id IS NULL))))`,
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_series_fkey',
    'foreign',
    'FOREIGN KEY (goal_definition_id, goal_series_id) REFERENCES goal_series(goal_definition_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_source_revision_fkey',
    'foreign',
    'FOREIGN KEY (source_plan_goal_id, source_draft_goal_revision_id) REFERENCES plan_draft_goal_revisions(plan_goal_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_goal_snapshots',
    'plan_goal_snapshots_source_root_fkey',
    'foreign',
    'FOREIGN KEY (source_plan_goal_id, space_id, goal_definition_id) REFERENCES plan_draft_goals(id, space_id, goal_definition_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_months',
    'plan_months_active_publication_fkey',
    'foreign',
    'FOREIGN KEY (id, active_publication_id) REFERENCES plan_publications(plan_month_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED',
    true,
    true,
  ),
  constraint(
    'plan_publications',
    'plan_publications_activation_check',
    'check',
    `CHECK ((((activation_mode)::text = ANY ((ARRAY['immediate'::character varying, 'scheduled'::character varying])::text[])) AND ((active_local_date >= '0001-01-01'::date) AND (active_local_date <= '9999-12-31'::date)) AND ((time_zone)::text = 'Asia/Yekaterinburg'::text) AND ((((activation_mode)::text = 'scheduled'::text) AND (late_publication = false)) OR ((activation_mode)::text = 'immediate'::text))))`,
  ),
  constraint(
    'plan_publications',
    'plan_publications_draft_fkey',
    'foreign',
    'FOREIGN KEY (plan_month_id) REFERENCES plan_drafts(plan_month_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_publications',
    'plan_publications_focus_check',
    'check',
    `CHECK (((btrim(focus) <> ''::text) AND (char_length(focus) <= 500)))`,
  ),
  constraint(
    'plan_publications',
    'plan_publications_hash_check',
    'check',
    `CHECK ((preview_hash ~ '^[0-9a-f]{64}$'::text))`,
  ),
  constraint(
    'plan_publications',
    'plan_publications_month_fkey',
    'foreign',
    'FOREIGN KEY (space_id, plan_month_id) REFERENCES plan_months(space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_publications',
    'plan_publications_month_id_key',
    'unique',
    'UNIQUE (plan_month_id, id)',
  ),
  constraint(
    'plan_publications',
    'plan_publications_month_revision_key',
    'unique',
    'UNIQUE (plan_month_id, publication_revision)',
  ),
  constraint(
    'plan_publications',
    'plan_publications_pkey',
    'primary',
    'PRIMARY KEY (id)',
  ),
  constraint(
    'plan_publications',
    'plan_publications_publisher_fkey',
    'foreign',
    'FOREIGN KEY (space_id, published_by_member_id) REFERENCES memberships(space_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'plan_publications',
    'plan_publications_revision_check',
    'check',
    'CHECK (((publication_revision >= 1) AND (source_draft_revision >= 1) AND (source_plan_month_revision >= 1)))',
  ),
  constraint(
    'plan_publications',
    'plan_publications_space_id_key',
    'unique',
    'UNIQUE (space_id, id)',
  ),
  constraint(
    'plan_publications',
    'plan_publications_version_check',
    'check',
    `CHECK ((((source_preview_schema_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text) AND ((preview_hash_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text) AND ((calendar_formula_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text) AND ((evaluation_formula_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text) AND ((score_formula_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text)))`,
  ),
  constraint(
    'planning_action_groups',
    'planning_action_groups_action_kind_check',
    'check',
    `CHECK (((action_kind)::text = ANY ((ARRAY['draft_created'::character varying, 'month_focus_updated'::character varying, 'goal_definition_created'::character varying, 'goal_definition_versioned'::character varying, 'goal_definition_archived'::character varying, 'goal_definition_restored'::character varying, 'goal_definition_copied'::character varying, 'draft_goal_added'::character varying, 'draft_goal_updated'::character varying, 'draft_goal_removed'::character varying, 'draft_goals_reordered'::character varying, 'month_published'::character varying])::text[])))`,
  ),
  constraint(
    'planning_action_groups',
    'planning_action_groups_target_check',
    'check',
    `CHECK (((((action_kind)::text = ANY ((ARRAY['draft_created'::character varying, 'month_focus_updated'::character varying, 'draft_goal_added'::character varying, 'draft_goal_updated'::character varying, 'draft_goal_removed'::character varying, 'draft_goals_reordered'::character varying, 'month_published'::character varying])::text[])) AND (plan_month_id IS NOT NULL) AND (goal_definition_id IS NULL)) OR (((action_kind)::text = ANY ((ARRAY['goal_definition_created'::character varying, 'goal_definition_versioned'::character varying, 'goal_definition_archived'::character varying, 'goal_definition_restored'::character varying, 'goal_definition_copied'::character varying])::text[])) AND (plan_month_id IS NULL) AND (goal_definition_id IS NOT NULL))))`,
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_action_fkey',
    'foreign',
    'FOREIGN KEY (action_id) REFERENCES planning_action_groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_hash_check',
    'check',
    `CHECK ((confirmed_preview_hash ~ '^[0-9a-f]{64}$'::text))`,
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_pkey',
    'primary',
    'PRIMARY KEY (action_id)',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_pointer_check',
    'check',
    'CHECK (((before_active_publication_id IS NULL) AND (after_active_publication_id = publication_id)))',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_publication_fkey',
    'foreign',
    'FOREIGN KEY (publication_id) REFERENCES plan_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_publication_key',
    'unique',
    'UNIQUE (publication_id)',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_revision_check',
    'check',
    'CHECK ((confirmed_draft_revision >= 1))',
  ),
  constraint(
    'planning_publication_changes',
    'planning_publication_changes_version_check',
    'check',
    `CHECK ((((confirmed_preview_schema_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text) AND ((confirmed_preview_hash_version)::text ~ '^[a-z0-9][a-z0-9.-]{0,99}$'::text)))`,
  ),
]

type PgIndexInventory = {
  readonly table_name: string
  readonly name: string
  readonly unique_index: boolean
  readonly key_columns: readonly string[]
  readonly predicate: string
}

function index(
  table_name: string,
  name: string,
  key_columns: readonly string[],
  predicate = '',
): PgIndexInventory {
  return { table_name, name, unique_index: true, key_columns, predicate }
}

const EXPECTED_P07_INDEXES: readonly PgIndexInventory[] = [
  index('fixed_expectations', 'fixed_expectations_pkey', ['id']),
  index('fixed_expectations', 'fixed_expectations_stable_key', [
    'publication_id',
    'plan_goal_snapshot_id',
    'expectation_date',
    'component_id',
  ]),
  index('flexible_periods', 'flexible_periods_ordinal_key', [
    'publication_id',
    'plan_goal_snapshot_id',
    'period_kind',
    'ordinal',
  ]),
  index('flexible_periods', 'flexible_periods_pkey', ['id']),
  index('flexible_periods', 'flexible_periods_stable_key', [
    'publication_id',
    'plan_goal_snapshot_id',
    'period_kind',
    'period_start',
    'period_end',
  ]),
  index('plan_goal_snapshots', 'plan_goal_snapshots_pkey', ['id']),
  index('plan_goal_snapshots', 'plan_goal_snapshots_publication_id_key', [
    'publication_id',
    'id',
  ]),
  index('plan_goal_snapshots', 'plan_goal_snapshots_publication_order_key', [
    'publication_id',
    'display_order',
  ]),
  index('plan_goal_snapshots', 'plan_goal_snapshots_publication_source_key', [
    'publication_id',
    'source_plan_goal_id',
  ]),
  index('plan_publications', 'plan_publications_month_id_key', [
    'plan_month_id',
    'id',
  ]),
  index('plan_publications', 'plan_publications_month_revision_key', [
    'plan_month_id',
    'publication_revision',
  ]),
  index('plan_publications', 'plan_publications_pkey', ['id']),
  index('plan_publications', 'plan_publications_space_id_key', [
    'space_id',
    'id',
  ]),
  index(
    'planning_action_groups',
    'planning_action_groups_draft_after_revision_key',
    ['plan_month_id', 'after_revision'],
    `((action_kind)::text = ANY ((ARRAY['draft_created'::character varying, 'month_focus_updated'::character varying, 'draft_goal_added'::character varying, 'draft_goal_updated'::character varying, 'draft_goal_removed'::character varying, 'draft_goals_reordered'::character varying])::text[]))`,
  ),
  index(
    'planning_action_groups',
    'planning_action_groups_lifecycle_after_revision_key',
    ['plan_month_id', 'after_revision'],
    `((action_kind)::text = 'month_published'::text)`,
  ),
  index('planning_publication_changes', 'planning_publication_changes_pkey', [
    'action_id',
  ]),
  index(
    'planning_publication_changes',
    'planning_publication_changes_publication_key',
    ['publication_id'],
  ),
]

type PgTriggerInventory = {
  readonly table_name: string
  readonly name: string
  readonly definition: string
  readonly deferrable: boolean
  readonly deferred: boolean
  readonly enabled: 'O'
}

function trigger(
  table_name: string,
  name: string,
  definition: string,
  deferrable = false,
  deferred = false,
): PgTriggerInventory {
  return {
    table_name,
    name,
    definition,
    deferrable,
    deferred,
    enabled: 'O',
  }
}

const EXPECTED_P07_TRIGGERS: readonly PgTriggerInventory[] = [
  trigger(
    'command_receipts',
    'command_receipts_publication_effect_consistent',
    'CREATE CONSTRAINT TRIGGER command_receipts_publication_effect_consistent AFTER INSERT ON public.command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_publication_receipt_effect()',
    true,
    true,
  ),
  trigger(
    'fixed_expectations',
    'fixed_expectations_reject_update_delete',
    'CREATE TRIGGER fixed_expectations_reject_update_delete BEFORE DELETE OR UPDATE ON public.fixed_expectations FOR EACH ROW EXECUTE FUNCTION reject_p01_immutable_row_change()',
  ),
  trigger(
    'fixed_expectations',
    'fixed_expectations_validate',
    'CREATE TRIGGER fixed_expectations_validate BEFORE INSERT ON public.fixed_expectations FOR EACH ROW EXECUTE FUNCTION validate_p07_fixed_expectation()',
  ),
  trigger(
    'flexible_periods',
    'flexible_periods_reject_update_delete',
    'CREATE TRIGGER flexible_periods_reject_update_delete BEFORE DELETE OR UPDATE ON public.flexible_periods FOR EACH ROW EXECUTE FUNCTION reject_p01_immutable_row_change()',
  ),
  trigger(
    'flexible_periods',
    'flexible_periods_validate',
    'CREATE TRIGGER flexible_periods_validate BEFORE INSERT ON public.flexible_periods FOR EACH ROW EXECUTE FUNCTION validate_p07_flexible_period()',
  ),
  trigger(
    'plan_goal_snapshots',
    'plan_goal_snapshots_reject_update_delete',
    'CREATE TRIGGER plan_goal_snapshots_reject_update_delete BEFORE DELETE OR UPDATE ON public.plan_goal_snapshots FOR EACH ROW EXECUTE FUNCTION reject_p01_immutable_row_change()',
  ),
  trigger(
    'plan_goal_snapshots',
    'plan_goal_snapshots_validate',
    'CREATE TRIGGER plan_goal_snapshots_validate BEFORE INSERT ON public.plan_goal_snapshots FOR EACH ROW EXECUTE FUNCTION validate_p07_snapshot()',
  ),
  trigger(
    'plan_months',
    'plan_months_guard_p07_lifecycle_update',
    'CREATE TRIGGER plan_months_guard_p07_lifecycle_update BEFORE UPDATE ON public.plan_months FOR EACH ROW EXECUTE FUNCTION guard_p07_month_lifecycle_update()',
  ),
  trigger(
    'plan_months',
    'plan_months_require_publication_pointer',
    'CREATE CONSTRAINT TRIGGER plan_months_require_publication_pointer AFTER INSERT OR UPDATE OF status, active_publication_id ON public.plan_months DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_month_pointer()',
    true,
    true,
  ),
  trigger(
    'plan_publications',
    'plan_publications_guard_revision',
    'CREATE TRIGGER plan_publications_guard_revision BEFORE INSERT ON public.plan_publications FOR EACH ROW EXECUTE FUNCTION guard_p07_publication_revision()',
  ),
  trigger(
    'plan_publications',
    'plan_publications_reject_update_delete',
    'CREATE TRIGGER plan_publications_reject_update_delete BEFORE DELETE OR UPDATE ON public.plan_publications FOR EACH ROW EXECUTE FUNCTION reject_p01_immutable_row_change()',
  ),
  trigger(
    'plan_publications',
    'plan_publications_require_complete_children',
    'CREATE CONSTRAINT TRIGGER plan_publications_require_complete_children AFTER INSERT ON public.plan_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_publication_complete()',
    true,
    true,
  ),
  trigger(
    'plan_publications',
    'plan_publications_require_month_pointer',
    'CREATE CONSTRAINT TRIGGER plan_publications_require_month_pointer AFTER INSERT ON public.plan_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_month_pointer()',
    true,
    true,
  ),
  trigger(
    'planning_action_groups',
    'planning_publication_action_requires_detail',
    'CREATE CONSTRAINT TRIGGER planning_publication_action_requires_detail AFTER INSERT ON public.planning_action_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_publication_detail()',
    true,
    true,
  ),
  trigger(
    'planning_publication_changes',
    'planning_publication_changes_effect_consistent',
    'CREATE CONSTRAINT TRIGGER planning_publication_changes_effect_consistent AFTER INSERT ON public.planning_publication_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_p07_publication_effect()',
    true,
    true,
  ),
  trigger(
    'planning_publication_changes',
    'planning_publication_changes_reject_update_delete',
    'CREATE TRIGGER planning_publication_changes_reject_update_delete BEFORE DELETE OR UPDATE ON public.planning_publication_changes FOR EACH ROW EXECUTE FUNCTION reject_p01_immutable_row_change()',
  ),
  trigger(
    'planning_publication_changes',
    'planning_publication_changes_validate',
    'CREATE TRIGGER planning_publication_changes_validate BEFORE INSERT ON public.planning_publication_changes FOR EACH ROW EXECUTE FUNCTION validate_p07_publication_change()',
  ),
]

type WeeklyQuotaPeriodFixture = {
  cadence: 'weekly'
  ordinal: number
  periodStart: string
  periodEnd: string
  periodDays: number
  activeDates: string[]
  eligibleDates: string[]
  periodTarget: number
}

type WeeklyQuotaCalendarFixture = {
  targetMonth: string
  activeLocalDate: string
  timeZone: 'Asia/Yekaterinburg'
  kind: 'quota'
  cadence: 'weekly'
  periods: WeeklyQuotaPeriodFixture[]
}

function weeklyQuotaCalendar(
  targetMonth = '2026-08',
): WeeklyQuotaCalendarFixture {
  if (targetMonth === '2027-02') {
    return {
      targetMonth,
      activeLocalDate: '2027-02-28',
      timeZone: 'Asia/Yekaterinburg',
      kind: 'quota',
      cadence: 'weekly',
      periods: [
        ['2027-02-01', '2027-02-07'],
        ['2027-02-08', '2027-02-14'],
        ['2027-02-15', '2027-02-21'],
        ['2027-02-22', '2027-02-28'],
      ].map(([periodStart, periodEnd], index) => ({
        cadence: 'weekly' as const,
        ordinal: index + 1,
        periodStart: periodStart!,
        periodEnd: periodEnd!,
        periodDays: 7,
        activeDates: index === 3 ? ['2027-02-28'] : [],
        eligibleDates: index === 3 ? ['2027-02-28'] : [],
        periodTarget: index === 3 ? 1 : 0,
      })),
    }
  }
  return {
    targetMonth,
    activeLocalDate: '2026-08-31',
    timeZone: 'Asia/Yekaterinburg',
    kind: 'quota',
    cadence: 'weekly',
    periods: [
      ['2026-08-01', '2026-08-02'],
      ['2026-08-03', '2026-08-09'],
      ['2026-08-10', '2026-08-16'],
      ['2026-08-17', '2026-08-23'],
      ['2026-08-24', '2026-08-30'],
      ['2026-08-31', '2026-08-31'],
    ].map(([periodStart, periodEnd], index) => ({
      cadence: 'weekly' as const,
      ordinal: index + 1,
      periodStart: periodStart!,
      periodEnd: periodEnd!,
      periodDays: 7,
      activeDates: index === 5 ? ['2026-08-31'] : [],
      eligibleDates: index === 5 ? ['2026-08-31'] : [],
      periodTarget: index === 5 ? 1 : 0,
    })),
  }
}

const ISOLATED_WEEKLY_CALENDAR_MUTANTS: readonly {
  readonly name: string
  readonly calendar: () => WeeklyQuotaCalendarFixture
}[] = [
  {
    name: 'fractional ordinal only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[0]!.ordinal = 1.5
      return value
    },
  },
  {
    name: 'fractional periodDays only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[0]!.periodDays = 7.5
      return value
    },
  },
  {
    name: 'fractional periodTarget only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[5]!.periodTarget = 0.5
      return value
    },
  },
  {
    name: 'missing first segment only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods = value.periods.slice(1)
      return value
    },
  },
  {
    name: 'missing middle segment only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods = value.periods.filter(({ ordinal }) => ordinal !== 3)
      return value
    },
  },
  {
    name: 'missing last segment below minimum only',
    calendar: () => {
      const value = weeklyQuotaCalendar('2027-02')
      value.periods = value.periods.slice(0, -1)
      return value
    },
  },
  {
    name: 'reordered adjacent segments only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      ;[value.periods[1], value.periods[2]] = [
        value.periods[2]!,
        value.periods[1]!,
      ]
      return value
    },
  },
  {
    name: 'overlapping shifted first segment bound only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[0]!.periodEnd = '2026-08-03'
      return value
    },
  },
  {
    name: 'gap after shifted first segment bound only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[0]!.periodEnd = '2026-08-01'
      return value
    },
  },
  {
    name: 'out-of-month first segment bound only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods[0]!.periodStart = '2026-07-31'
      return value
    },
  },
  {
    name: 'canonical five-segment prefix missing month end only',
    calendar: () => {
      const value = weeklyQuotaCalendar()
      value.periods = value.periods.slice(0, -1)
      return value
    },
  },
]

async function captureP03Rows(
  target: Pool,
  afterP07: boolean,
): Promise<Record<string, readonly Record<string, unknown>[]>> {
  const captured: Record<string, readonly Record<string, unknown>[]> = {}
  for (const table of P03_PRESERVED_TABLES) {
    const rows = await target.query<{
      value: Record<string, unknown>
      xmin: string
    }>(
      `SELECT to_jsonb(row_value) value, xmin::text xmin
         FROM ${table} row_value
        ORDER BY to_jsonb(row_value)::text`,
    )
    captured[table] = rows.rows.map(({ value, xmin }) => {
      const row = { ...value }
      if (afterP07 && table === 'plan_months') {
        expect(row['active_publication_id']).toBeNull()
        delete row['active_publication_id']
      }
      return { value: row, xmin }
    })
  }
  return captured
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child)
}

describe('P07 migration calendar trust boundary', () => {
  it('does not reimplement the P04 ISO-week calculator in the snapshot shape validator', () => {
    const migration = readFileSync(
      'prisma/migrations/20260811151000_plan_publication/migration.sql',
      'utf8',
    )
    const calendarGuards = migration.match(
      /CREATE FUNCTION "p07_calendar_has_exact_shape"[\s\S]*?(?=CREATE TRIGGER "plan_goal_snapshots_validate")/u,
    )?.[0]
    expect(calendarGuards).toBeDefined()
    expect(calendarGuards).not.toMatch(
      /\bisodow\b|date_trunc\('week'|generate_series\s*\(/u,
    )
  })
})

describe('P07 atomic publication in real PostgreSQL', () => {
  let postgres: StartedPostgreSqlContainer
  let pool: Pool
  let provider: PrismaClientProvider
  let application: PublicationApplication
  let clock: FakeProductClock
  let transaction: PrismaTransactionAdapter
  let transactionContext: PrismaTransactionContext
  let members: PrismaWorkspaceMemberResolver

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p07_integration')
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
    clock = new FakeProductClock(new Date('2026-08-14T19:00:00.000Z'))
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
  })

  afterAll(async () => {
    await provider?.close(AbortSignal.timeout(2_000)).catch(() => undefined)
    await pool?.end()
    await postgres?.stop()
  })

  async function draftWithChecklist(targetMonth = '2026-08'): Promise<{
    readonly planMonthId: string
    readonly goalDefinitionId: string
    readonly preview: Record<string, unknown>
  }> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth, focus: 'Atomic P07 integration' },
    })
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Daily checklist', why: 'Coverage', category: 'Test' },
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
          measurement: {
            kind: 'checklist',
            items: [
              { itemId: null, label: 'One' },
              { itemId: null, label: 'Two' },
            ],
          },
          checkpoints: null,
        },
        sourceProvenance: {
          schemaVersion: 1,
          sourceDocument: 'monthly-plan-template',
          sourcePage: 3,
          rawValue: '2',
          rawDenominator: '31',
          resolution: 'P07 integration',
        },
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth,
    })
    if (preview === null) throw new Error('preview missing')
    return {
      planMonthId: draft.aggregateId,
      goalDefinitionId: definition.aggregateId,
      preview,
    }
  }

  async function draftAtMaterializationBoundary(
    targetMonth: string,
    oneOffComponents: 4 | 5,
  ): Promise<Awaited<ReturnType<typeof draftWithChecklist>>> {
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        targetMonth,
        focus: `Mixed materialization ${oneOffComponents}`,
      },
    })
    const dailyComponents = [100, 100, 100, 22] as const
    const configs = [
      ...dailyComponents.map((componentCount, goalIndex) => ({
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'checklist' as const,
          items: Array.from({ length: componentCount }, (_, itemIndex) => ({
            itemId: null,
            label: `Daily ${goalIndex}-${itemIndex}`,
          })),
        },
      })),
      {
        repetition: {
          kind: 'one_off' as const,
          dueDate: `${targetMonth}-31`,
        },
        measurement: {
          kind: 'checklist' as const,
          items: Array.from({ length: oneOffComponents }, (_, itemIndex) => ({
            itemId: null,
            label: `One-off ${itemIndex}`,
          })),
        },
      },
      {
        repetition: { kind: 'weekly' as const, n: '1' },
        measurement: { kind: 'boolean' as const },
      },
      {
        repetition: { kind: 'monthly' as const, n: '1' },
        measurement: { kind: 'boolean' as const },
      },
    ]
    let firstDefinitionId: string | null = null
    for (const [goalIndex, config] of configs.entries()) {
      const definition = await application.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          title: `Boundary goal ${goalIndex}`,
          why: 'Bounded publication',
          category: 'Test',
        },
      })
      firstDefinitionId ??= definition.aggregateId
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(goalIndex + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'shared' },
            repetition: config.repetition,
            measurement: config.measurement,
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      })
    }
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth,
    })
    if (preview === null) throw new Error('preview missing')
    return {
      planMonthId: draft.aggregateId,
      goalDefinitionId: firstDefinitionId!,
      preview,
    }
  }

  function publishCommand(
    fixture: Awaited<ReturnType<typeof draftWithChecklist>>,
    commandId = randomUUID(),
  ): Record<string, unknown> {
    return {
      commandId,
      trustedActor: actor(),
      expectedRevision: BigInt(String(fixture.preview['draftRevision'])),
      payload: {
        planMonthId: fixture.planMonthId,
        previewSchemaVersion: fixture.preview['schemaVersion'],
        previewHashVersion: fixture.preview['previewHashVersion'],
        previewHash: fixture.preview['previewHash'],
      },
    }
  }

  let weeklyTaskFixturePromise:
    | Promise<{
        readonly planMonthId: string
        readonly definitionId: string
        readonly preview: Record<string, unknown>
        readonly source: Record<string, unknown>
      }>
    | undefined

  function weeklyTaskFixture(): NonNullable<typeof weeklyTaskFixturePromise> {
    weeklyTaskFixturePromise ??= (async () => {
      clock.set(new Date('2028-01-31T19:00:00.000Z'))
      const draft = await application.createEmptyDraft.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          targetMonth: '2028-02',
          focus: 'Isolated weekly-task calendar guards',
        },
      })
      const definition = await application.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          title: 'Second week task fixture',
          why: 'Each calendar mutation stays isolated',
          category: 'Test',
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
            scope: { kind: 'shared' },
            repetition: {
              kind: 'weekly_planned_task',
              weekOrdinal: '2',
              taskText: 'Do the second week task',
            },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      })
      const preview = await application.buildPublicationPreview.execute({
        trustedUserId: firstUserId,
        targetMonth: '2028-02',
      })
      if (preview === null) throw new Error('weekly-task fixture missing')
      const source = await pool.query<Record<string, unknown>>(
        `SELECT root.id::text plan_goal_id,
                root.current_revision_id::text revision_id,
                root.display_order,
                revision.revision_number::text config_revision,
                revision.goal_definition_version_id::text version_id,
                revision.goal_series_id::text series_id, revision.config,
                version.title, version.why, version.category
           FROM plan_draft_goals root
           JOIN plan_draft_goal_revisions revision
             ON revision.id = root.current_revision_id
           JOIN goal_definition_versions version
             ON version.id = revision.goal_definition_version_id
          WHERE root.plan_month_id = $1::uuid`,
        [draft.aggregateId],
      )
      return {
        planMonthId: draft.aggregateId,
        definitionId: definition.aggregateId,
        preview,
        source: source.rows[0]!,
      }
    })()
    return weeklyTaskFixturePromise
  }

  async function expectWeeklyTaskCalendarRejected(
    activeLocalDate: string,
    calendar: Record<string, unknown>,
  ): Promise<void> {
    const fixture = await weeklyTaskFixture()
    const row = fixture.source
    const publicationId = randomUUID()
    await pool.query('BEGIN')
    try {
      await pool.query(
        `INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::bigint, $5::bigint,
           $6, 'immediate', $7::date, $8::boolean,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('8', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', $9::uuid,
           $7::date::timestamp AT TIME ZONE 'Asia/Yekaterinburg')`,
        [
          publicationId,
          spaceId,
          fixture.planMonthId,
          fixture.preview['draftRevision'],
          fixture.preview['planMonthRevision'],
          fixture.preview['focus'],
          activeLocalDate,
          activeLocalDate !== '2028-02-01',
          firstMemberId,
        ],
      )
      await expect(
        pool.query(
          `INSERT INTO plan_goal_snapshots
            (id, publication_id, space_id, plan_month_id,
             source_plan_goal_id, source_draft_goal_revision_id,
             source_config_revision, goal_definition_id,
             goal_definition_version_id, goal_series_id, display_order,
             title, why, category, scope_kind, owner_member_id,
             config, source_provenance, calendar)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
             $4::uuid, $5::uuid, $6::bigint, $7::uuid, $8::uuid, $9::uuid,
             $10::integer, $11, $12, $13, 'shared', NULL,
             $14::jsonb, NULL, $15::jsonb)`,
          [
            publicationId,
            spaceId,
            fixture.planMonthId,
            row['plan_goal_id'],
            row['revision_id'],
            row['config_revision'],
            fixture.definitionId,
            row['version_id'],
            row['series_id'],
            row['display_order'],
            row['title'],
            row['why'],
            row['category'],
            JSON.stringify(row['config']),
            JSON.stringify(calendar),
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.query('ROLLBACK').catch(() => undefined)
    }
    await expectUnpublished(fixture.planMonthId)
  }

  it('deploys the exact P07 migration and five-table inventory after P03', async () => {
    const migrations = await pool.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`,
    )
    expect(migrations.rows.at(-1)).toEqual({
      migration_name: '20260811151000_plan_publication',
    })
    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'plan_publications', 'plan_goal_snapshots', 'fixed_expectations',
           'flexible_periods', 'planning_publication_changes'
         )
       ORDER BY table_name
    `)
    expect(tables.rows).toEqual([
      { table_name: 'fixed_expectations' },
      { table_name: 'flexible_periods' },
      { table_name: 'plan_goal_snapshots' },
      { table_name: 'plan_publications' },
      { table_name: 'planning_publication_changes' },
    ])
    const columns = await pool.query<{
      table_name: string
      signature: string
    }>(`
      SELECT class.relname table_name,
             string_agg(
               attribute.attname || ':' ||
               format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
               attribute.attnotnull::text || ':' ||
               coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '∅'),
               ',' ORDER BY attribute.attnum
             ) signature
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        JOIN pg_attribute attribute ON attribute.attrelid = class.oid
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef default_value
          ON default_value.adrelid = class.oid
         AND default_value.adnum = attribute.attnum
       WHERE namespace.nspname = 'public'
         AND (
           class.relname IN (
             'plan_publications', 'plan_goal_snapshots',
             'fixed_expectations', 'flexible_periods',
             'planning_publication_changes'
           )
           OR (class.relname = 'plan_months'
               AND attribute.attname = 'active_publication_id')
         )
       GROUP BY class.relname
       ORDER BY class.relname
    `)
    expect(columns.rows).toEqual([
      {
        table_name: 'fixed_expectations',
        signature:
          'id:uuid:true:∅,publication_id:uuid:true:∅,plan_goal_snapshot_id:uuid:true:∅,expectation_date:date:true:∅,component_kind:character varying(24):true:∅,component_id:uuid:false:∅',
      },
      {
        table_name: 'flexible_periods',
        signature:
          'id:uuid:true:∅,publication_id:uuid:true:∅,plan_goal_snapshot_id:uuid:true:∅,period_kind:character varying(24):true:∅,ordinal:integer:true:∅,period_start:date:true:∅,period_end:date:true:∅,period_days:integer:false:∅,active_dates:date[]:true:ARRAY[]::date[],eligible_dates:date[]:true:ARRAY[]::date[],period_target:integer:true:∅',
      },
      {
        table_name: 'plan_goal_snapshots',
        signature:
          'id:uuid:true:∅,publication_id:uuid:true:∅,space_id:uuid:true:∅,plan_month_id:uuid:true:∅,source_plan_goal_id:uuid:true:∅,source_draft_goal_revision_id:uuid:true:∅,source_config_revision:bigint:true:∅,goal_definition_id:uuid:true:∅,goal_definition_version_id:uuid:true:∅,goal_series_id:uuid:true:∅,display_order:integer:true:∅,title:text:true:∅,why:text:true:∅,category:text:true:∅,scope_kind:character varying(16):true:∅,owner_member_id:uuid:false:∅,config:jsonb:true:∅,source_provenance:jsonb:false:∅,calendar:jsonb:true:∅',
      },
      {
        table_name: 'plan_months',
        signature: 'active_publication_id:uuid:false:∅',
      },
      {
        table_name: 'plan_publications',
        signature:
          'id:uuid:true:∅,space_id:uuid:true:∅,plan_month_id:uuid:true:∅,publication_revision:bigint:true:∅,source_draft_revision:bigint:true:∅,source_plan_month_revision:bigint:true:∅,focus:text:true:∅,activation_mode:character varying(16):true:∅,active_local_date:date:true:∅,late_publication:boolean:true:∅,time_zone:character varying(64):true:∅,source_preview_schema_version:character varying(100):true:∅,preview_hash_version:character varying(100):true:∅,preview_hash:character(64):true:∅,calendar_formula_version:character varying(100):true:∅,evaluation_formula_version:character varying(100):true:∅,score_formula_version:character varying(100):true:∅,published_by_member_id:uuid:true:∅,published_at:timestamp(3) with time zone:true:∅',
      },
      {
        table_name: 'planning_publication_changes',
        signature:
          'action_id:uuid:true:∅,publication_id:uuid:true:∅,confirmed_draft_revision:bigint:true:∅,confirmed_preview_schema_version:character varying(100):true:∅,confirmed_preview_hash_version:character varying(100):true:∅,confirmed_preview_hash:character(64):true:∅,before_active_publication_id:uuid:false:∅,after_active_publication_id:uuid:true:∅',
      },
    ])
    const physical = await pool.query<{
      name: string
      definition: string
    }>(`
      SELECT constraint_name name, pg_get_constraintdef(pg_constraint_row.oid) definition
        FROM information_schema.table_constraints inventory
        JOIN pg_constraint pg_constraint_row
          ON pg_constraint_row.conname = inventory.constraint_name
       WHERE inventory.table_schema = 'public'
         AND inventory.constraint_name IN (
           'plan_months_active_publication_fkey',
           'fixed_expectations_stable_key'
         )
       ORDER BY constraint_name
    `)
    expect(physical.rows.map(({ name }) => name)).toEqual([
      'fixed_expectations_stable_key',
      'plan_months_active_publication_fkey',
    ])
    expect(physical.rows[0]?.definition).toContain('UNIQUE NULLS NOT DISTINCT')
    expect(physical.rows[1]?.definition).toMatch(
      /FOREIGN KEY \(id, active_publication_id\).*DEFERRABLE INITIALLY DEFERRED/u,
    )
    const publicationDraftFk = await pool.query<{
      name: string
      definition: string
    }>(`
      SELECT conname name, pg_get_constraintdef(oid) definition
        FROM pg_constraint
       WHERE conrelid = 'plan_publications'::regclass
         AND conname = 'plan_publications_draft_fkey'
    `)
    expect(publicationDraftFk.rows).toEqual([
      {
        name: 'plan_publications_draft_fkey',
        definition:
          'FOREIGN KEY (plan_month_id) REFERENCES plan_drafts(plan_month_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
      },
    ])
    const foreignKeys = await pool.query<{
      name: string
      definition: string
      deferrable: boolean
      deferred: boolean
    }>(`
      SELECT conname name, pg_get_constraintdef(oid) definition,
             condeferrable deferrable, condeferred deferred
        FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN (
           'plan_months'::regclass, 'plan_publications'::regclass,
           'plan_goal_snapshots'::regclass, 'fixed_expectations'::regclass,
           'flexible_periods'::regclass,
           'planning_publication_changes'::regclass
         )
         AND (
           conname LIKE 'plan_publications_%'
           OR conname LIKE 'plan_goal_snapshots_%'
           OR conname LIKE 'fixed_expectations_%'
           OR conname LIKE 'flexible_periods_%'
           OR conname LIKE 'planning_publication_changes_%'
           OR conname = 'plan_months_active_publication_fkey'
         )
       ORDER BY conname
    `)
    expect(foreignKeys.rows.map(({ name }) => name)).toEqual([
      'fixed_expectations_publication_snapshot_fkey',
      'flexible_periods_publication_snapshot_fkey',
      'plan_goal_snapshots_definition_version_fkey',
      'plan_goal_snapshots_owner_fkey',
      'plan_goal_snapshots_publication_fkey',
      'plan_goal_snapshots_series_fkey',
      'plan_goal_snapshots_source_revision_fkey',
      'plan_goal_snapshots_source_root_fkey',
      'plan_months_active_publication_fkey',
      'plan_publications_draft_fkey',
      'plan_publications_month_fkey',
      'plan_publications_publisher_fkey',
      'planning_publication_changes_action_fkey',
      'planning_publication_changes_publication_fkey',
    ])
    expect(
      foreignKeys.rows.filter(
        ({ deferrable, deferred }) => deferrable || deferred,
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'plan_months_active_publication_fkey',
        deferrable: true,
        deferred: true,
      }),
    ])
    const historyIndexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'planning_action_groups_draft_after_revision_key',
           'planning_action_groups_lifecycle_after_revision_key',
           'planning_action_groups_month_after_revision_key'
         )
       ORDER BY indexname
    `)
    expect(historyIndexes.rows).toEqual([
      { indexname: 'planning_action_groups_draft_after_revision_key' },
      { indexname: 'planning_action_groups_lifecycle_after_revision_key' },
    ])
    const p07Indexes = await pool.query<{ name: string; definition: string }>(`
      SELECT indexname name, indexdef definition FROM pg_indexes
       WHERE schemaname = 'public'
         AND (
           tablename IN (
             'plan_publications', 'plan_goal_snapshots',
             'fixed_expectations', 'flexible_periods',
             'planning_publication_changes'
           )
           OR indexname IN (
             'planning_action_groups_draft_after_revision_key',
             'planning_action_groups_lifecycle_after_revision_key'
           )
         )
       ORDER BY indexname
    `)
    expect(p07Indexes.rows.map(({ name }) => name)).toEqual([
      'fixed_expectations_pkey',
      'fixed_expectations_stable_key',
      'flexible_periods_ordinal_key',
      'flexible_periods_pkey',
      'flexible_periods_stable_key',
      'plan_goal_snapshots_pkey',
      'plan_goal_snapshots_publication_id_key',
      'plan_goal_snapshots_publication_order_key',
      'plan_goal_snapshots_publication_source_key',
      'plan_publications_month_id_key',
      'plan_publications_month_revision_key',
      'plan_publications_pkey',
      'plan_publications_space_id_key',
      'planning_action_groups_draft_after_revision_key',
      'planning_action_groups_lifecycle_after_revision_key',
      'planning_publication_changes_pkey',
      'planning_publication_changes_publication_key',
    ])
    expect(
      p07Indexes.rows.find(
        ({ name }) =>
          name === 'planning_action_groups_draft_after_revision_key',
      )?.definition,
    ).toMatch(
      /WHERE .*action_kind.*ANY.*draft_created.*month_focus_updated.*draft_goal_added.*draft_goal_updated.*draft_goal_removed.*draft_goals_reordered/u,
    )
    expect(
      p07Indexes.rows.find(
        ({ name }) =>
          name === 'planning_action_groups_lifecycle_after_revision_key',
      )?.definition,
    ).toMatch(/WHERE .*action_kind.*month_published/u)
    const partialPredicates = await pool.query<{
      name: string
      columns: string[]
      values: string[]
    }>(`
      SELECT index_class.relname name,
             ARRAY(
               SELECT pg_get_indexdef(index_row.indexrelid, ordinal, true)
                 FROM generate_series(1, index_row.indnkeyatts) ordinal
             ) columns,
             ARRAY(
               SELECT match[1]
                 FROM regexp_matches(
                   pg_get_expr(index_row.indpred, index_row.indrelid),
                   '''([^'']+)''', 'g'
                 ) match
             ) values
        FROM pg_index index_row
        JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
       WHERE index_class.relname IN (
         'planning_action_groups_draft_after_revision_key',
         'planning_action_groups_lifecycle_after_revision_key'
       )
       ORDER BY index_class.relname
    `)
    expect(partialPredicates.rows).toEqual([
      {
        name: 'planning_action_groups_draft_after_revision_key',
        columns: ['plan_month_id', 'after_revision'],
        values: [
          'draft_created',
          'month_focus_updated',
          'draft_goal_added',
          'draft_goal_updated',
          'draft_goal_removed',
          'draft_goals_reordered',
        ],
      },
      {
        name: 'planning_action_groups_lifecycle_after_revision_key',
        columns: ['plan_month_id', 'after_revision'],
        values: ['month_published'],
      },
    ])
    const checks = await pool.query<{ name: string; definition: string }>(`
      SELECT conname name,
             regexp_replace(pg_get_constraintdef(oid), '\\s+', ' ', 'g') definition
        FROM pg_constraint
       WHERE contype = 'c'
         AND conrelid IN (
           'plan_publications'::regclass, 'plan_goal_snapshots'::regclass,
           'fixed_expectations'::regclass, 'flexible_periods'::regclass,
           'planning_publication_changes'::regclass,
           'planning_action_groups'::regclass
         )
         AND (
           conname LIKE 'plan_publications_%_check'
           OR conname LIKE 'plan_goal_snapshots_%_check'
           OR conname = 'fixed_expectations_component_check'
           OR conname LIKE 'flexible_periods_%_check'
           OR conname LIKE 'planning_publication_changes_%_check'
           OR conname IN (
             'planning_action_groups_action_kind_check',
             'planning_action_groups_target_check'
           )
         )
       ORDER BY conname
    `)
    expect(checks.rows.map(({ name }) => name)).toEqual([
      'fixed_expectations_component_check',
      'flexible_periods_bounds_check',
      'flexible_periods_dates_check',
      'flexible_periods_kind_check',
      'flexible_periods_shape_check',
      'plan_goal_snapshots_calendar_check',
      'plan_goal_snapshots_config_check',
      'plan_goal_snapshots_metadata_check',
      'plan_goal_snapshots_provenance_check',
      'plan_goal_snapshots_revision_order_check',
      'plan_goal_snapshots_scope_check',
      'plan_publications_activation_check',
      'plan_publications_focus_check',
      'plan_publications_hash_check',
      'plan_publications_revision_check',
      'plan_publications_version_check',
      'planning_action_groups_action_kind_check',
      'planning_action_groups_target_check',
      'planning_publication_changes_hash_check',
      'planning_publication_changes_pointer_check',
      'planning_publication_changes_revision_check',
      'planning_publication_changes_version_check',
    ])
    const checkDefinitions = Object.fromEntries(
      checks.rows.map(({ name, definition }) => [name, definition]),
    )
    const expectedCheckPatterns: Record<string, RegExp> = {
      plan_publications_revision_check:
        /publication_revision.*>= 1.*source_draft_revision.*>= 1.*source_plan_month_revision.*>= 1/u,
      plan_publications_activation_check:
        /activation_mode.*immediate.*scheduled.*active_local_date.*0001-01-01.*9999-12-31.*Asia\/Yekaterinburg.*late_publication/u,
      plan_goal_snapshots_scope_check:
        /scope_kind.*personal.*owner_member_id IS NOT NULL.*shared.*owner_member_id IS NULL/u,
      fixed_expectations_component_check:
        /component_kind.*goal.*component_id IS NULL.*checkpoint.*checklist_item.*component_id IS NOT NULL/u,
      flexible_periods_bounds_check:
        /ordinal.*>= 1.*ordinal.*<= 6.*period_start.*period_end.*period_target.*>= 0/u,
      flexible_periods_shape_check:
        /weekly.*period_days.*7.*monthly.*28.*31.*weekly_planned_task.*period_days IS NULL.*period_target.*1/u,
      flexible_periods_dates_check:
        /p07_date_array_is_sorted_unique.*active_dates.*eligible_dates.*p07_dates_inside/u,
      planning_publication_changes_pointer_check:
        /before_active_publication_id IS NULL.*after_active_publication_id.*publication_id/u,
      planning_action_groups_action_kind_check:
        /draft_created.*goal_definition_created.*draft_goal_added.*month_published/u,
      planning_action_groups_target_check:
        /month_published.*plan_month_id IS NOT NULL.*goal_definition_id IS NULL.*goal_definition_copied/u,
    }
    for (const [name, pattern] of Object.entries(expectedCheckPatterns)) {
      expect(checkDefinitions[name]).toMatch(pattern)
    }
    const p07Triggers = await pool.query<{ name: string }>(`
      SELECT DISTINCT trigger_name name
        FROM information_schema.triggers
       WHERE trigger_schema = 'public'
         AND (
           event_object_table IN (
             'plan_publications', 'plan_goal_snapshots',
             'fixed_expectations', 'flexible_periods',
             'planning_publication_changes'
           )
           OR trigger_name LIKE '%p07%'
           OR trigger_name LIKE '%publication%'
         )
       ORDER BY trigger_name
    `)
    expect(p07Triggers.rows.map(({ name }) => name)).toEqual([
      'command_receipts_publication_effect_consistent',
      'fixed_expectations_reject_update_delete',
      'fixed_expectations_validate',
      'flexible_periods_reject_update_delete',
      'flexible_periods_validate',
      'plan_goal_snapshots_reject_update_delete',
      'plan_goal_snapshots_validate',
      'plan_months_guard_p07_lifecycle_update',
      'plan_months_require_publication_pointer',
      'plan_publications_guard_revision',
      'plan_publications_reject_update_delete',
      'plan_publications_require_complete_children',
      'plan_publications_require_month_pointer',
      'planning_publication_action_requires_detail',
      'planning_publication_changes_effect_consistent',
      'planning_publication_changes_reject_update_delete',
      'planning_publication_changes_validate',
    ])
    const deferredTriggers = await pool.query<{
      name: string
      deferrable: boolean
      deferred: boolean
    }>(`
      SELECT trigger_row.tgname name, trigger_row.tgdeferrable deferrable,
             trigger_row.tginitdeferred deferred
        FROM pg_trigger trigger_row
       WHERE NOT trigger_row.tgisinternal
         AND trigger_row.tgname = ANY(ARRAY[
           'command_receipts_publication_effect_consistent',
           'plan_months_require_publication_pointer',
           'plan_publications_require_complete_children',
           'plan_publications_require_month_pointer',
           'planning_publication_action_requires_detail',
           'planning_publication_changes_effect_consistent'
         ])
       ORDER BY trigger_row.tgname
    `)
    expect(
      deferredTriggers.rows.every(
        ({ deferrable, deferred }) => deferrable && deferred,
      ),
    ).toBe(true)
    expect(deferredTriggers.rows).toHaveLength(6)
    const exactConstraints = await pool.query<PgConstraintInventory>(`
      SELECT class.relname table_name, constraint_row.conname name,
             CASE constraint_row.contype
               WHEN 'p' THEN 'primary'
               WHEN 'u' THEN 'unique'
               WHEN 'f' THEN 'foreign'
               WHEN 'c' THEN 'check'
             END type,
             regexp_replace(
               pg_get_constraintdef(constraint_row.oid), '\\s+', ' ', 'g'
             ) definition,
             constraint_row.condeferrable deferrable,
             constraint_row.condeferred deferred
        FROM pg_constraint constraint_row
        JOIN pg_class class ON class.oid = constraint_row.conrelid
       WHERE constraint_row.contype = ANY (ARRAY['p', 'u', 'f', 'c']::char[])
         AND (
           class.relname IN (
             'plan_publications', 'plan_goal_snapshots',
             'fixed_expectations', 'flexible_periods',
             'planning_publication_changes'
           )
           OR constraint_row.conname = 'plan_months_active_publication_fkey'
           OR constraint_row.conname IN (
             'planning_action_groups_action_kind_check',
             'planning_action_groups_target_check'
           )
         )
       ORDER BY class.relname, constraint_row.conname
    `)
    expect(exactConstraints.rows).toEqual(EXPECTED_P07_CONSTRAINTS)

    const exactIndexes = await pool.query<PgIndexInventory>(`
      SELECT table_class.relname table_name, index_class.relname name,
             index_row.indisunique unique_index,
             ARRAY(
               SELECT pg_get_indexdef(index_row.indexrelid, ordinal, true)
                 FROM generate_series(1, index_row.indnkeyatts) ordinal
             ) key_columns,
             coalesce(
               regexp_replace(
                 pg_get_expr(index_row.indpred, index_row.indrelid),
                 '\\s+', ' ', 'g'
               ),
               ''
             ) predicate
        FROM pg_index index_row
        JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
        JOIN pg_class table_class ON table_class.oid = index_row.indrelid
       WHERE table_class.relname IN (
               'plan_publications', 'plan_goal_snapshots',
               'fixed_expectations', 'flexible_periods',
               'planning_publication_changes'
             )
          OR index_class.relname IN (
               'planning_action_groups_draft_after_revision_key',
               'planning_action_groups_lifecycle_after_revision_key'
             )
       ORDER BY table_class.relname, index_class.relname
    `)
    expect(exactIndexes.rows).toEqual(EXPECTED_P07_INDEXES)

    const exactTriggers = await pool.query<PgTriggerInventory>(
      `SELECT class.relname table_name, trigger_row.tgname name,
              regexp_replace(
                pg_get_triggerdef(trigger_row.oid), '\\s+', ' ', 'g'
              ) definition,
              trigger_row.tgdeferrable deferrable,
              trigger_row.tginitdeferred deferred,
              trigger_row.tgenabled enabled
         FROM pg_trigger trigger_row
         JOIN pg_class class ON class.oid = trigger_row.tgrelid
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgname = ANY($1::text[])
        ORDER BY class.relname, trigger_row.tgname`,
      [EXPECTED_P07_TRIGGERS.map(({ name }) => name)],
    )
    expect(exactTriggers.rows).toEqual(EXPECTED_P07_TRIGGERS)

    const preservedP03Triggers = await pool.query<{ name: string }>(`
      SELECT tgname name FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = ANY(ARRAY[
         'plan_draft_goals_guard_update_delete',
         'plan_draft_goals_dense_active_order',
         'plan_draft_goal_revisions_reject_update_delete',
         'planning_draft_goal_changes_validate',
         'planning_draft_goal_change_effect_consistent',
         'plan_draft_goals_require_current_revision',
         'plan_draft_goal_revision_requires_current_pointer',
         'planning_draft_goal_action_requires_detail'
       ])
       ORDER BY tgname
    `)
    expect(preservedP03Triggers.rows).toHaveLength(8)
    const calendarMutants = await pool.query<{ valid: boolean }>(`
      SELECT p07_calendar_has_exact_shape(value) valid
        FROM (VALUES
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-01","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":null,"periods":[]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-01","timeZone":"Asia/Yekaterinburg","kind":"fixed","expectationDates":[],"extra":true}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-01","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":"weekly","periods":[{"cadence":null,"ordinal":1,"periodStart":"2026-08-01","periodEnd":"2026-08-02","periodDays":7,"activeDates":[],"eligibleDates":[],"periodTarget":0}]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-01","timeZone":"Asia/Yekaterinburg","kind":"weekly_planned_task","periods":[{"cadence":null,"ordinal":1,"periodStart":"2026-08-01","periodEnd":"2026-08-02","periodTarget":1}]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-01","timeZone":"Asia/Yekaterinburg","kind":"weekly_planned_task","periods":[{"cadence":"weekly","ordinal":6,"periodStart":"2026-08-31","periodEnd":"2026-08-31","periodTarget":1}]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-31","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":"monthly","periods":[]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-31","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":"monthly","periods":[{"cadence":"monthly","ordinal":1,"periodStart":"2026-08-02","periodEnd":"2026-08-31","periodDays":30,"activeDates":["2026-08-31"],"eligibleDates":["2026-08-31"],"periodTarget":1}]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-31","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":"monthly","periods":[{"cadence":"monthly","ordinal":1.5,"periodStart":"2026-08-01","periodEnd":"2026-08-31","periodDays":31.0,"activeDates":["2026-08-31"],"eligibleDates":["2026-08-31"],"periodTarget":1.0}]}'::jsonb),
          ('{"targetMonth":"2026-08","activeLocalDate":"2026-08-31","timeZone":"Asia/Yekaterinburg","kind":"quota","cadence":"weekly","periods":[{"cadence":"weekly","ordinal":3,"periodStart":"2026-08-10","periodEnd":"2026-08-16","periodDays":7,"activeDates":[],"eligibleDates":[],"periodTarget":0}]}'::jsonb)
        ) mutant(value)
    `)
    expect(calendarMutants.rows).toEqual([
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
      { valid: false },
    ])
  })

  it.each(ISOLATED_WEEKLY_CALENDAR_MUTANTS)(
    'rejects isolated weekly calendar mutant: $name',
    async ({ calendar }) => {
      const result = await pool.query<{ valid: boolean }>(
        'SELECT p07_calendar_has_exact_shape($1::jsonb) valid',
        [JSON.stringify(calendar())],
      )
      expect(result.rows).toEqual([{ valid: false }])
    },
  )

  it('upgrades a real P03 schema without data loss and fails closed for unbackfillable legacy lifecycle state', async () => {
    const upgrade = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('planner_p07_upgrade')
      .withUsername('planner')
      .withPassword('planner-test-only')
      .start()
    const upgradePool = new Pool({
      connectionString: upgrade.getConnectionUri(),
    })
    try {
      const migrationPaths = [
        '20260811090000_planner_foundation',
        '20260811100000_local_user_session',
        '20260811110000_pair_workspace',
        '20260811120000_telegram_external_identity',
        '20260811130000_plan_draft_kernel',
        '20260811140000_goal_catalog',
        '20260811150000_typed_draft_goals',
      ]
      for (const name of migrationPaths) {
        await upgradePool.query(
          readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
        )
      }
      await upgradePool.query(`
        INSERT INTO users (id) VALUES ('${firstUserId}'::uuid);
        INSERT INTO spaces (id, singleton_key) VALUES ('${spaceId}'::uuid, 1);
        INSERT INTO memberships (id, space_id, user_id, slot)
        VALUES ('${firstMemberId}'::uuid, '${spaceId}'::uuid,
                '${firstUserId}'::uuid, 1);
      `)
      const p07 = readFileSync(
        'prisma/migrations/20260811151000_plan_publication/migration.sql',
        'utf8',
      )
      const poison = await upgradePool.connect()
      try {
        await poison.query('BEGIN')
        await poison.query(`
          INSERT INTO command_receipts
            (actor_scope, command_type, command_id, fingerprint, result_kind,
             aggregate_id, aggregate_revision, completed_at)
          VALUES
            ('member:${firstMemberId}', 'planning.publish-month.v1',
             gen_random_uuid(), repeat('a', 64), 'planning.plan-draft.v1',
             gen_random_uuid(), 1, now())
        `)
        const racedMigration = executeMigration(upgradePool, p07)
        await new Promise((resolve) => setTimeout(resolve, 200))
        await poison.query('COMMIT')
        await expect(racedMigration).rejects.toMatchObject({ code: '23514' })
      } finally {
        await poison.query('ROLLBACK').catch(() => undefined)
        poison.release()
      }
      await upgradePool.query(`
        TRUNCATE TABLE command_receipts, planning_action_groups CASCADE;
        INSERT INTO plan_months
          (id, space_id, month_start, status, revision, created_at, updated_at)
        VALUES ('66666666-6666-4666-8666-666666666666'::uuid,
                '${spaceId}'::uuid, '2026-08-01'::date, 'published', 2,
                now(), now());
      `)
      await expect(executeMigration(upgradePool, p07)).rejects.toMatchObject({
        code: '23514',
      })
      const failedColumns = await upgradePool.query<{ count: string }>(`
        SELECT count(*)::text count FROM information_schema.columns
         WHERE table_name = 'plan_months'
           AND column_name = 'active_publication_id'
      `)
      expect(failedColumns.rows).toEqual([{ count: '0' }])

      await upgradePool.query(`
        UPDATE plan_months SET status = 'draft', revision = 1;
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('member:${firstMemberId}', 'planning.publish-month.v1',
           gen_random_uuid(), repeat('f', 64), 'planning.plan-draft.v1',
           gen_random_uuid(), 1, now());
      `)
      await expect(executeMigration(upgradePool, p07)).rejects.toMatchObject({
        code: '23514',
      })
      await upgradePool.query(`
        TRUNCATE TABLE command_receipts, planning_action_groups CASCADE;
        INSERT INTO plan_drafts
          (plan_month_id, focus, revision, created_at, updated_at)
        VALUES ('66666666-6666-4666-8666-666666666666'::uuid,
                'Preserved P03 draft', 1, now(), now());
      `)
      const upgradeContext = new PrismaTransactionContext()
      const upgradeConfig = databaseConfig(upgrade.getConnectionUri())
      const upgradeProvider = new PrismaClientProvider(
        upgradeConfig,
        upgradeContext,
      )
      await upgradeProvider.connect(AbortSignal.timeout(2_000))
      try {
        const upgradeApplication = createPlanningApplication({
          database: upgradeProvider,
          transaction: new PrismaTransactionAdapter(
            upgradeProvider,
            upgradeContext,
            upgradeConfig,
          ),
          workspaceMembers: new PrismaWorkspaceMemberResolver(upgradeProvider),
          clock: new FakeProductClock(new Date('2026-08-14T19:00:00.000Z')),
        })
        const preservedDraft =
          await upgradeApplication.createEmptyDraft.execute({
            commandId: randomUUID(),
            trustedActor: actor(),
            payload: {
              targetMonth: '2026-09',
              focus: 'Real P03 upgrade fixture',
            },
          })
        const preservedDefinition =
          await upgradeApplication.createGoalDefinition.execute({
            commandId: randomUUID(),
            trustedActor: actor(),
            payload: {
              title: 'Preserved goal',
              why: 'Prove row and xmin stability',
              category: 'Upgrade',
            },
          })
        await upgradeApplication.addDraftGoal.execute({
          commandId: randomUUID(),
          trustedActor: actor(),
          expectedRevision: 1n,
          payload: {
            planMonthId: preservedDraft.aggregateId,
            goalDefinitionId: preservedDefinition.aggregateId,
            config: {
              schemaVersion: 1,
              scope: { kind: 'shared' },
              repetition: { kind: 'daily' },
              measurement: { kind: 'boolean' },
              checkpoints: null,
            },
            sourceProvenance: null,
          },
        })
      } finally {
        await upgradeProvider.close(AbortSignal.timeout(2_000))
      }
      const beforeRows = await captureP03Rows(upgradePool, false)
      for (const table of P03_PRESERVED_TABLES) {
        expect(beforeRows[table]?.length).toBeGreaterThan(0)
      }
      await executeMigration(upgradePool, p07)
      expect(await captureP03Rows(upgradePool, true)).toEqual(beforeRows)
      const preserved = await upgradePool.query<Record<string, string | null>>(`
        SELECT month.status, month.revision::text revision,
               month.active_publication_id::text active_publication_id,
               draft.focus,
               (SELECT count(*)::text FROM memberships) memberships
          FROM plan_months month
          JOIN plan_drafts draft ON draft.plan_month_id = month.id
      `)
      expect(preserved.rows).toEqual([
        {
          status: 'draft',
          revision: '1',
          active_publication_id: null,
          focus: 'Preserved P03 draft',
          memberships: '1',
        },
        {
          status: 'draft',
          revision: '1',
          active_publication_id: null,
          focus: 'Real P03 upgrade fixture',
          memberships: '1',
        },
      ])
    } finally {
      await upgradePool.end()
      await upgrade.stop()
    }
  })

  it('publishes focus/config/provenance/calendar/hash atomically and returns byte-stable detached queries', async () => {
    const fixture = await draftWithChecklist()
    const command = publishCommand(fixture)
    const result = await application.publishMonth.execute(command)

    expect(result).toMatchObject({
      kind: 'planning.plan-publication.v1',
      aggregateRevision: 1n,
    })
    const rows = await pool.query<Record<string, string>>(
      `
      SELECT month.status, month.revision::text month_revision,
             month.active_publication_id::text publication_id,
             publication.preview_hash, publication.source_draft_revision::text draft_revision,
             (SELECT count(*)::text FROM plan_goal_snapshots snapshot
               WHERE snapshot.publication_id = publication.id) goal_snapshots,
             (SELECT count(*)::text FROM fixed_expectations expectation
               WHERE expectation.publication_id = publication.id) fixed_expectations,
             (SELECT count(*)::text FROM flexible_periods period
               WHERE period.publication_id = publication.id) flexible_periods,
             (SELECT count(*)::text FROM planning_publication_changes change
               WHERE change.publication_id = publication.id) publication_changes,
             (SELECT count(*)::text FROM command_receipts receipt
               WHERE receipt.aggregate_id = publication.id) receipts
        FROM plan_months month
        JOIN plan_publications publication
          ON publication.id = month.active_publication_id
       WHERE month.id = $1::uuid
    `,
      [fixture.planMonthId],
    )
    expect(rows.rows).toEqual([
      expect.objectContaining({
        status: 'published',
        month_revision: '2',
        publication_id: result.aggregateId,
        preview_hash: fixture.preview['previewHash'],
        draft_revision: fixture.preview['draftRevision'],
        goal_snapshots: '1',
        fixed_expectations: '34',
        flexible_periods: '0',
        publication_changes: '1',
        receipts: '1',
      }),
    ])
    const published = await application.getPublishedSnapshot.execute({
      trustedUserId: firstUserId,
      publicationId: result.aggregateId,
    })
    const secondRead = await application.getPublishedSnapshot.execute({
      trustedUserId: secondUserId,
      publicationId: result.aggregateId,
    })
    expect(secondRead).toEqual(published)
    expect(published).toMatchObject({
      schemaVersion: 'planner.published-snapshot.v1',
      publicationSnapshotHash: fixture.preview['previewHash'],
      focus: fixture.preview['focus'],
      goalSnapshots: [
        expect.objectContaining({
          config: (
            fixture.preview['goals'] as readonly Record<string, unknown>[]
          )[0]?.['config'],
          sourceProvenance: (
            fixture.preview['goals'] as readonly Record<string, unknown>[]
          )[0]?.['sourceProvenance'],
        }),
      ],
      calculatedTargets: (
        fixture.preview['calculatedTargets'] as readonly Record<
          string,
          unknown
        >[]
      ).map(({ planGoalId, ...target }) => ({
        ...target,
        sourcePlanGoalId: planGoalId,
      })),
    })
    expect(Object.isFrozen(published)).toBe(true)
    expectDeepFrozen(published)
    expect(() => {
      const goalSnapshot = (
        published as unknown as {
          goalSnapshots: { config: { schemaVersion: number } }[]
        }
      ).goalSnapshots[0]!
      goalSnapshot.config.schemaVersion = 99
    }).toThrow(TypeError)
    const readState = await publicationState(
      fixture.planMonthId,
      String(command['commandId']),
    )
    expect(
      await application.getPublishedSnapshot.execute({
        trustedUserId: firstUserId,
        publicationId: result.aggregateId,
      }),
    ).toEqual(published)
    expect(
      await application.getActiveMonth.execute({ trustedUserId: firstUserId }),
    ).toEqual(published)
    expect(
      await publicationState(fixture.planMonthId, String(command['commandId'])),
    ).toEqual(readState)
    await application.createGoalDefinitionVersion.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        goalDefinitionId: fixture.goalDefinitionId,
        title: 'Changed later',
        why: 'The published source remains frozen',
        category: 'Test',
        seriesDecision: 'continue',
      },
    })
    expect(
      await application.getPublishedSnapshot.execute({
        trustedUserId: firstUserId,
        publicationId: result.aggregateId,
      }),
    ).toEqual(published)
    expect(
      await application.getActiveMonth.execute({ trustedUserId: firstUserId }),
    ).toEqual(published)
  })

  it('stores the exact scalar, any-of parent, checklist and checkpoint component matrix without a fake preactivation weekly-task period', async () => {
    clock.set(new Date('2028-03-14T19:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2028-03', focus: 'Physical component matrix' },
    })
    const configs = [
      {
        title: 'Scalar component',
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'boolean' as const },
        checkpoints: null,
      },
      {
        title: 'Any-of parent component',
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'any_of' as const,
          variants: [
            {
              variantId: null,
              label: 'Variant',
              unit: 'times',
              precision: 0 as const,
              target: '1',
            },
          ],
        },
        checkpoints: null,
      },
      {
        title: 'Checklist components',
        repetition: { kind: 'daily' as const },
        measurement: {
          kind: 'checklist' as const,
          items: [
            { itemId: null, label: 'First' },
            { itemId: null, label: 'Second' },
          ],
        },
        checkpoints: null,
      },
      {
        title: 'Checkpoint components',
        repetition: { kind: 'daily' as const },
        measurement: { kind: 'boolean' as const },
        checkpoints: {
          aggregation: 'all' as const,
          items: [
            {
              checkpointId: null,
              name: 'First boolean checkpoint',
              deadline: '12:00',
              satisfaction: { kind: 'boolean' as const },
            },
            {
              checkpointId: null,
              name: 'Second boolean checkpoint',
              deadline: '22:00',
              satisfaction: { kind: 'boolean' as const },
            },
          ],
        },
      },
      {
        title: 'Future weekly task',
        repetition: {
          kind: 'weekly_planned_task' as const,
          weekOrdinal: '1' as const,
          taskText: 'Do not invent a physical period',
        },
        measurement: { kind: 'boolean' as const },
        checkpoints: null,
      },
    ]
    for (const [index, config] of configs.entries()) {
      const definition = await application.createGoalDefinition.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        payload: {
          title: config.title,
          why: 'Component matrix proof',
          category: 'Test',
        },
      })
      await application.addDraftGoal.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(index + 1),
        payload: {
          planMonthId: draft.aggregateId,
          goalDefinitionId: definition.aggregateId,
          config: {
            schemaVersion: 1,
            scope: { kind: 'shared' },
            repetition: config.repetition,
            measurement: config.measurement,
            checkpoints: config.checkpoints,
          },
          sourceProvenance: null,
        },
      })
    }
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2028-03',
    })
    if (preview === null) throw new Error('component preview missing')
    expect(preview.blockers).toEqual([])
    const result = await application.publishMonth.execute({
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
    const components = await pool.query<{
      title: string
      kind: string
      rows: string
      ids: string
    }>(
      `SELECT snapshot.title, expectation.component_kind kind,
              count(*)::text rows,
              count(DISTINCT expectation.component_id)::text ids
         FROM plan_goal_snapshots snapshot
         JOIN fixed_expectations expectation
           ON expectation.plan_goal_snapshot_id = snapshot.id
        WHERE snapshot.publication_id = $1::uuid
        GROUP BY snapshot.title, expectation.component_kind
        ORDER BY snapshot.title`,
      [result.aggregateId],
    )
    expect(components.rows).toEqual([
      {
        title: 'Any-of parent component',
        kind: 'goal',
        rows: '17',
        ids: '0',
      },
      {
        title: 'Checklist components',
        kind: 'checklist_item',
        rows: '34',
        ids: '2',
      },
      {
        title: 'Checkpoint components',
        kind: 'checkpoint',
        rows: '34',
        ids: '2',
      },
      {
        title: 'Scalar component',
        kind: 'goal',
        rows: '17',
        ids: '0',
      },
    ])
    const weeklyRows = await pool.query<{ periods: string }>(
      `SELECT count(period.id)::text periods
         FROM plan_goal_snapshots snapshot
         LEFT JOIN flexible_periods period
           ON period.plan_goal_snapshot_id = snapshot.id
        WHERE snapshot.publication_id = $1::uuid
          AND snapshot.title = 'Future weekly task'`,
      [result.aggregateId],
    )
    expect(weeklyRows.rows).toEqual([{ periods: '0' }])
  })

  it('materializes exactly 10000 rows set-based inside the 5s runtime transaction', async () => {
    clock.set(new Date('2029-11-30T19:00:00.000Z'))
    const fixture = await draftAtMaterializationBoundary('2029-12', 4)
    let writeStatements = 0
    let receiptStatements = 0
    const writeTemplates: string[] = []
    const countingDatabase = {
      withClient: <T>(
        operation: Parameters<PrismaClientProvider['withClient']>[0],
      ): Promise<T> =>
        provider.withClient((client) =>
          operation(
            new Proxy(client, {
              get(target, property, receiver) {
                if (property !== '$executeRaw') {
                  return Reflect.get(target, property, receiver) as unknown
                }
                const execute = Reflect.get(target, property, receiver) as (
                  ...args: unknown[]
                ) => unknown
                return (...args: unknown[]) => {
                  writeStatements += 1
                  const strings = args[0]
                  writeTemplates.push(
                    Array.isArray(strings)
                      ? strings.map(String).join('?')
                      : String(strings),
                  )
                  return Reflect.apply(execute, target, args)
                }
              },
            }),
          ),
        ) as Promise<T>,
    }
    const runtimeConfig = databaseConfig(postgres.getConnectionUri(), 5_000)
    const runtimeTransaction = new PrismaTransactionAdapter(
      provider,
      transactionContext,
      runtimeConfig,
    )
    const realReceipts = new PrismaCommandReceiptAdapter(provider)
    const countingReceipts: CommandReceiptPort = {
      acquireLock: (key) => realReceipts.acquireLock(key),
      findCompleted: (key) => realReceipts.findCompleted(key),
      insertCompleted: async (receipt) => {
        receiptStatements += 1
        await realReceipts.insertCompleted(receipt)
      },
    }
    const command = new PublishMonthCommand(
      new DurableCommandExecutor(runtimeTransaction, countingReceipts, clock),
      members,
      new PrismaPublicationPersistence(
        countingDatabase as unknown as PrismaClientProvider,
      ),
    )
    const startedAt = performance.now()
    await expect(
      command.execute(publishCommand(fixture) as never),
    ).resolves.toMatchObject({ kind: 'planning.plan-publication.v1' })
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    expect(writeStatements).toBe(7)
    expect(receiptStatements).toBe(1)
    for (const table of [
      'plan_goal_snapshots',
      'fixed_expectations',
      'flexible_periods',
    ]) {
      expect(
        writeTemplates.filter((sql) => sql.includes(`INSERT INTO ${table}`)),
      ).toHaveLength(1)
    }
    const count = await pool.query<{
      snapshots: string
      fixed: string
      flexible: string
      total: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM plan_goal_snapshots
           WHERE plan_month_id = $1::uuid) snapshots,
         (SELECT count(*)::text FROM fixed_expectations expectation
            JOIN plan_goal_snapshots snapshot
              ON snapshot.id = expectation.plan_goal_snapshot_id
           WHERE snapshot.plan_month_id = $1::uuid) fixed,
         (SELECT count(*)::text FROM flexible_periods period
            JOIN plan_goal_snapshots snapshot
              ON snapshot.id = period.plan_goal_snapshot_id
           WHERE snapshot.plan_month_id = $1::uuid) flexible,
         ((SELECT count(*) FROM plan_goal_snapshots
             WHERE plan_month_id = $1::uuid)
          + (SELECT count(*) FROM fixed_expectations expectation
               JOIN plan_goal_snapshots snapshot
                 ON snapshot.id = expectation.plan_goal_snapshot_id
              WHERE snapshot.plan_month_id = $1::uuid)
          + (SELECT count(*) FROM flexible_periods period
               JOIN plan_goal_snapshots snapshot
                 ON snapshot.id = period.plan_goal_snapshot_id
              WHERE snapshot.plan_month_id = $1::uuid))::text total`,
      [fixture.planMonthId],
    )
    expect(count.rows).toEqual([
      { snapshots: '7', fixed: '9986', flexible: '7', total: '10000' },
    ])
  })

  it('rejects 10001 materialized rows from the exact preview with zero writes', async () => {
    clock.set(new Date('2030-11-30T19:00:00.000Z'))
    const fixture = await draftAtMaterializationBoundary('2030-12', 5)
    expect(fixture.preview['blockers']).toEqual([
      {
        planGoalId: null,
        pointer: '/goals',
        code: 'incompatible',
        detail: 'Publication materialization exceeds 10000 rows.',
      },
    ])
    const commandId = randomUUID()
    const before = await publicationState(fixture.planMonthId, commandId)
    await expect(
      application.publishMonth.execute(publishCommand(fixture, commandId)),
    ).rejects.toMatchObject({ name: 'PlanPublicationBlockedError' })
    expect(await publicationState(fixture.planMonthId, commandId)).toEqual(
      before,
    )
  })

  it('replays exactly, rejects a changed fingerprint, and creates no second publication', async () => {
    clock.set(new Date('2026-08-31T18:00:00.000Z'))
    const fixture = await draftWithChecklist('2026-09')
    const commandId = randomUUID()
    const command = publishCommand(fixture, commandId)
    const first = await application.publishMonth.execute(command)
    await expect(application.publishMonth.execute(command)).resolves.toEqual(
      first,
    )

    const changed = {
      ...command,
      payload: {
        ...(command['payload'] as Record<string, unknown>),
        previewHash: 'ef'.repeat(32),
      },
    }
    await expect(
      application.publishMonth.execute(changed),
    ).rejects.toMatchObject({
      name: 'CommandFingerprintConflictError',
    })
    const counts = await pool.query<{ publications: string; actions: string }>(
      `
      SELECT count(*)::text publications,
             (SELECT count(*)::text FROM planning_action_groups
               WHERE plan_month_id = $1::uuid AND action_kind = 'month_published') actions
        FROM plan_publications WHERE plan_month_id = $1::uuid
    `,
      [fixture.planMonthId],
    )
    expect(counts.rows).toEqual([{ publications: '1', actions: '1' }])
  })

  it('rejects stale hash before writes and serializes two fresh command IDs to one active publication', async () => {
    const month = '2026-10'
    clock.set(new Date('2026-09-30T19:00:00.000Z'))
    const fixture = await draftWithChecklist(month)
    const before = await pool.query<Record<string, string>>(
      `
      SELECT month.revision::text month_revision, month.xmin::text month_xmin,
             draft.revision::text draft_revision, draft.xmin::text draft_xmin,
             (SELECT count(*)::text FROM plan_publications) publications,
             (SELECT count(*)::text FROM command_receipts) receipts,
             (SELECT count(*)::text FROM planning_action_groups) actions
        FROM plan_months month JOIN plan_drafts draft ON draft.plan_month_id = month.id
       WHERE month.id = $1::uuid
    `,
      [fixture.planMonthId],
    )
    const stale = publishCommand(fixture)
    ;(stale['payload'] as Record<string, unknown>)['previewHash'] = '12'.repeat(
      32,
    )
    await expect(application.publishMonth.execute(stale)).rejects.toMatchObject(
      {
        name: 'PublicationPreviewConflictError',
      },
    )
    const after = await pool.query<Record<string, string>>(
      `
      SELECT month.revision::text month_revision, month.xmin::text month_xmin,
             draft.revision::text draft_revision, draft.xmin::text draft_xmin,
             (SELECT count(*)::text FROM plan_publications) publications,
             (SELECT count(*)::text FROM command_receipts) receipts,
             (SELECT count(*)::text FROM planning_action_groups) actions
        FROM plan_months month JOIN plan_drafts draft ON draft.plan_month_id = month.id
       WHERE month.id = $1::uuid
    `,
      [fixture.planMonthId],
    )
    expect(after.rows).toEqual(before.rows)

    const attempts = await Promise.allSettled([
      application.publishMonth.execute(publishCommand(fixture)),
      application.publishMonth.execute(publishCommand(fixture)),
    ])
    expect(
      attempts.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      attempts.filter((value) => value.status === 'rejected'),
    ).toHaveLength(1)
    expect(attempts.find((value) => value.status === 'rejected')).toMatchObject(
      { reason: { name: 'PlanMonthAlreadyPublishedError' } },
    )
  })

  it('enforces immutable rows, null-safe fixed uniqueness and same-month active pointer in SQL', async () => {
    clock.set(new Date('2026-12-31T19:00:00.000Z'))
    const scalarDraft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2027-01', focus: 'Null component uniqueness' },
    })
    const scalarDefinition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Scalar', why: 'Null key', category: 'Test' },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: scalarDraft.aggregateId,
        goalDefinitionId: scalarDefinition.aggregateId,
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
    const scalarPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2027-01',
    })
    if (scalarPreview === null) throw new Error('scalar preview missing')
    const scalarPublication = await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(scalarPreview.draftRevision),
      payload: {
        planMonthId: scalarDraft.aggregateId,
        previewSchemaVersion: scalarPreview.schemaVersion,
        previewHashVersion: scalarPreview.previewHashVersion,
        previewHash: scalarPreview.previewHash,
      },
    })
    const publication = await pool.query<{
      publication_id: string
      snapshot_id: string
      expectation_date: string
    }>(
      `
      SELECT publication.id::text publication_id,
             snapshot.id::text snapshot_id,
             expectation.expectation_date::text expectation_date
        FROM plan_publications publication
        JOIN plan_goal_snapshots snapshot ON snapshot.publication_id = publication.id
        JOIN fixed_expectations expectation
          ON expectation.plan_goal_snapshot_id = snapshot.id
       WHERE publication.id = $1::uuid
         AND expectation.component_id IS NULL
       ORDER BY expectation.expectation_date
       LIMIT 1
    `,
      [scalarPublication.aggregateId],
    )
    const row = publication.rows[0]!
    await expect(
      pool.query(
        `UPDATE plan_goal_snapshots SET title = 'forbidden' WHERE id = $1::uuid`,
        [row.snapshot_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(`DELETE FROM plan_publications WHERE id = $1::uuid`, [
        row.publication_id,
      ]),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `
        UPDATE plan_months SET status = 'draft', active_publication_id = NULL
         WHERE active_publication_id = $1::uuid
      `,
        [row.publication_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `
        INSERT INTO fixed_expectations
          (id, publication_id, plan_goal_snapshot_id, expectation_date,
           component_kind, component_id)
        SELECT gen_random_uuid(), publication_id, plan_goal_snapshot_id,
               expectation_date, component_kind, component_id
          FROM fixed_expectations
         WHERE publication_id = $1::uuid AND component_id IS NULL
         LIMIT 1
      `,
        [scalarPublication.aggregateId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('freezes plan-month identity and every lifecycle field after the exact P07 transition', async () => {
    clock.set(new Date('2027-09-30T19:00:00.000Z'))
    const fixture = await draftWithChecklist('2027-10')
    await pool.query('BEGIN')
    try {
      await expect(
        pool.query(
          `UPDATE plan_months SET month_start = DATE '2027-11-01'
            WHERE id = $1::uuid`,
          [fixture.planMonthId],
        ),
      ).rejects.toMatchObject({ code: '55000' })
    } finally {
      await pool.query('ROLLBACK')
    }
    await application.publishMonth.execute(publishCommand(fixture))

    for (const mutation of [
      `month_start = DATE '2027-11-01'`,
      `created_at = created_at + INTERVAL '1 second'`,
      `revision = revision + 7, updated_at = updated_at + INTERVAL '1 second'`,
    ]) {
      await pool.query('BEGIN')
      try {
        await expect(
          pool.query(`UPDATE plan_months SET ${mutation} WHERE id = $1::uuid`, [
            fixture.planMonthId,
          ]),
        ).rejects.toMatchObject({ code: '55000' })
      } finally {
        await pool.query('ROLLBACK')
      }
    }
  })

  it('requires a retained source draft before commit and after publication', async () => {
    clock.set(new Date('2029-10-31T19:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2029-11', focus: 'Draft FK' },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2029-11',
    })
    if (preview === null) throw new Error('preview missing')
    const command = new PublishMonthCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      new PrismaPublicationPersistence(provider, async (phase) => {
        if (phase !== 'publication') return
        await provider.withClient(async (client) => {
          await client.$executeRaw`
            DELETE FROM plan_drafts WHERE plan_month_id = ${draft.aggregateId}::uuid
          `
        })
      }),
    )
    await expect(
      command.execute(
        publishCommand({
          planMonthId: draft.aggregateId,
          goalDefinitionId: randomUUID(),
          preview,
        }) as never,
      ),
    ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
    await expectUnpublished(draft.aggregateId)

    await application.publishMonth.execute(
      publishCommand({
        planMonthId: draft.aggregateId,
        goalDefinitionId: randomUUID(),
        preview,
      }),
    )

    await expect(
      pool.query('DELETE FROM plan_drafts WHERE plan_month_id = $1::uuid', [
        draft.aggregateId,
      ]),
    ).rejects.toMatchObject({ code: '23001' })
  })

  it('rejects impossible fixed dates and sparse quota suffixes before component rows exist', async () => {
    const invalidCalendars = [
      {
        targetMonth: '2026-02',
        activeLocalDate: '2026-02-01',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'fixed',
        expectationDates: ['2026-02-31'],
      },
      {
        targetMonth: '2026-08',
        activeLocalDate: '2026-08-01',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'fixed',
        expectationDates: ['2026-09-01'],
      },
      {
        targetMonth: '2026-08',
        activeLocalDate: '2026-08-15',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'fixed',
        expectationDates: ['2026-08-14'],
      },
      {
        targetMonth: '2026-08',
        activeLocalDate: '2026-08-01',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'quota',
        cadence: 'monthly',
        periods: [
          {
            cadence: 'monthly',
            ordinal: 1,
            periodStart: '2026-08-01',
            periodEnd: '2026-08-03',
            periodDays: 3,
            activeDates: ['2026-08-01', '2026-08-03'],
            eligibleDates: ['2026-08-01', '2026-08-03'],
            periodTarget: 1,
          },
        ],
      },
    ]
    const validity = await Promise.all(
      invalidCalendars.map((calendar) =>
        pool
          .query<{ valid: boolean }>(
            'SELECT p07_calendar_has_exact_shape($1::jsonb) valid',
            [JSON.stringify(calendar)],
          )
          .then(({ rows }) => rows[0]?.valid),
      ),
    )
    expect(validity).toEqual([false, false, false, false])
  })

  it('rejects a preactivation fixed date even when blocked checklist expansion has zero rows', async () => {
    clock.set(new Date('2031-04-15T00:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2031-04', focus: 'Empty component mutant' },
    })
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Blocked checklist', why: 'Guard', category: 'Test' },
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
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'checklist', items: [] },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const source = await pool.query<Record<string, string | null>>(
      `SELECT root.id::text root_id,
              root.current_revision_id::text revision_id,
              root.display_order::text display_order,
              revision.revision_number::text revision_number,
              revision.goal_definition_version_id::text version_id,
              revision.goal_series_id::text series_id,
              revision.scope_kind, revision.owner_member_id::text owner_id,
              revision.config::text config,
              revision.source_provenance::text provenance,
              version.title, version.why, version.category
         FROM plan_draft_goals root
         JOIN plan_draft_goal_revisions revision
           ON revision.id = root.current_revision_id
         JOIN goal_definition_versions version
           ON version.id = revision.goal_definition_version_id
        WHERE root.plan_month_id = $1::uuid`,
      [draft.aggregateId],
    )
    const row = source.rows[0]!
    const publicationId = randomUUID()
    await pool.query('BEGIN')
    try {
      await pool.query(
        `INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 2, 1,
           'Empty component mutant', 'immediate', '2031-04-15'::date, true,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('9', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', $4::uuid,
           '2031-04-15T00:00:00+05:00'::timestamptz)`,
        [publicationId, spaceId, draft.aggregateId, firstMemberId],
      )
      await expect(
        pool.query(
          `INSERT INTO plan_goal_snapshots
            (id, publication_id, space_id, plan_month_id,
             source_plan_goal_id, source_draft_goal_revision_id,
             source_config_revision, goal_definition_id,
             goal_definition_version_id, goal_series_id, display_order,
             title, why, category, scope_kind, owner_member_id,
             config, source_provenance, calendar)
           VALUES
            (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
             $4::uuid, $5::uuid, $6::bigint, $7::uuid, $8::uuid, $9::uuid,
             $10::integer, $11, $12, $13, $14, $15::uuid, $16::jsonb,
             $17::jsonb,
             '{"targetMonth":"2031-04","activeLocalDate":"2031-04-15","timeZone":"Asia/Yekaterinburg","kind":"fixed","expectationDates":["2031-04-14"]}'::jsonb)`,
          [
            publicationId,
            spaceId,
            draft.aggregateId,
            row['root_id'],
            row['revision_id'],
            row['revision_number'],
            definition.aggregateId,
            row['version_id'],
            row['series_id'],
            row['display_order'],
            row['title'],
            row['why'],
            row['category'],
            row['scope_kind'],
            row['owner_id'],
            row['config'],
            row['provenance'],
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.query('ROLLBACK')
    }
  })

  it('rejects an orphan second publication without its exact pointer, action, detail and receipt', async () => {
    clock.set(new Date('2026-11-01T00:00:00.000Z'))
    const empty = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2026-11', focus: 'Empty direct SQL guard' },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2026-11',
    })
    if (preview === null) throw new Error('preview missing')
    await application.publishMonth.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: 1n,
      payload: {
        planMonthId: empty.aggregateId,
        previewSchemaVersion: preview.schemaVersion,
        previewHashVersion: preview.previewHashVersion,
        previewHash: preview.previewHash,
      },
    })

    await expect(
      pool.query(`
        INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
        VALUES
          (gen_random_uuid(), '${spaceId}'::uuid, '${empty.aggregateId}'::uuid,
           2, 1, 2, 'orphan', 'immediate', '2026-11-01'::date, false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('a', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${firstMemberId}'::uuid,
           '2026-11-01T00:00:00+05:00'::timestamptz)
      `),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects a coherent direct publication package when its durable receipt is omitted', async () => {
    clock.set(new Date('2027-05-31T18:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2027-06', focus: 'Receipt required' },
    })
    const publicationId = randomUUID()
    const actionId = randomUUID()
    const commandId = randomUUID()
    await pool.query('BEGIN')
    await pool.query(`
      INSERT INTO plan_publications
        (id, space_id, plan_month_id, publication_revision,
         source_draft_revision, source_plan_month_revision, focus,
         activation_mode, active_local_date, late_publication, time_zone,
         source_preview_schema_version, preview_hash_version, preview_hash,
         calendar_formula_version, evaluation_formula_version,
         score_formula_version, published_by_member_id, published_at)
      VALUES
        ('${publicationId}'::uuid, '${spaceId}'::uuid, '${draft.aggregateId}'::uuid,
         1, 1, 1, 'Receipt required', 'scheduled', '2027-06-01'::date, false,
         'Asia/Yekaterinburg', 'planner.publication-preview.v1',
         'planner.publication-preview-hash.v1', repeat('e', 64),
         'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
         'planner.score-coverage.v1', '${firstMemberId}'::uuid,
         '2027-05-31T23:00:00+05:00'::timestamptz);
      UPDATE plan_months SET status = 'published', revision = 2,
             active_publication_id = '${publicationId}'::uuid,
             updated_at = '2027-05-31T23:00:00+05:00'::timestamptz
       WHERE id = '${draft.aggregateId}'::uuid;
      INSERT INTO planning_action_groups
        (id, action_kind, actor_kind, actor_scope, member_id, system_actor_id,
         plan_month_id, goal_definition_id, command_type, command_id,
         before_revision, after_revision, occurred_at)
      VALUES
        ('${actionId}'::uuid, 'month_published', 'member',
         'member:${firstMemberId}', '${firstMemberId}'::uuid, NULL,
         '${draft.aggregateId}'::uuid, NULL, 'planning.publish-month.v1',
         '${commandId}'::uuid, 1, 2,
         '2027-05-31T23:00:00+05:00'::timestamptz);
      INSERT INTO planning_publication_changes
        (action_id, publication_id, confirmed_draft_revision,
         confirmed_preview_schema_version, confirmed_preview_hash_version,
         confirmed_preview_hash, before_active_publication_id,
         after_active_publication_id)
      VALUES
        ('${actionId}'::uuid, '${publicationId}'::uuid, 1,
         'planner.publication-preview.v1',
         'planner.publication-preview-hash.v1', repeat('e', 64), NULL,
         '${publicationId}'::uuid)
    `)
    await expect(pool.query('COMMIT')).rejects.toMatchObject({ code: '23503' })
    await pool.query('ROLLBACK').catch(() => undefined)
    await expectUnpublished(draft.aggregateId)
  })

  it('rejects a snapshot that does not exactly copy the locked source, calendar family or target month', async () => {
    clock.set(new Date('2026-12-01T00:00:00.000Z'))
    const fixture = await draftWithChecklist('2026-12')
    const source = await pool.query<Record<string, string>>(
      `
      SELECT root.id::text plan_goal_id,
             root.current_revision_id::text source_revision_id,
             root.goal_definition_id::text definition_id,
             revision.goal_definition_version_id::text version_id,
             revision.goal_series_id::text series_id,
             revision.revision_number::text config_revision,
             revision.config::text config,
             coalesce(revision.source_provenance::text, 'null') provenance
        FROM plan_draft_goals root
        JOIN plan_draft_goal_revisions revision
          ON revision.id = root.current_revision_id
       WHERE root.plan_month_id = $1::uuid
    `,
      [fixture.planMonthId],
    )
    const row = source.rows[0]!
    const draftRevision = String(fixture.preview['draftRevision'])
    const monthRevision = String(fixture.preview['planMonthRevision'])
    const publicationId = randomUUID()
    await pool.query('BEGIN')
    await pool.query(`
        INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
        VALUES
          ('${publicationId}'::uuid, '${spaceId}'::uuid,
           '${fixture.planMonthId}'::uuid, 1,
           ${draftRevision}, ${monthRevision},
           'Atomic P07 integration', 'immediate', '2026-12-01'::date, false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('b', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${firstMemberId}'::uuid,
           '2026-12-01T00:00:00+05:00'::timestamptz)
    `)
    await expect(
      pool.query(`
        INSERT INTO plan_goal_snapshots
          (id, publication_id, space_id, plan_month_id,
           source_plan_goal_id, source_draft_goal_revision_id,
           source_config_revision, goal_definition_id,
           goal_definition_version_id, goal_series_id, display_order,
           title, why, category, scope_kind, owner_member_id,
           config, source_provenance, calendar)
        VALUES
          (gen_random_uuid(), '${publicationId}'::uuid, '${spaceId}'::uuid,
           '${fixture.planMonthId}'::uuid, '${row['plan_goal_id']}'::uuid,
           '${row['source_revision_id']}'::uuid, ${row['config_revision']},
           '${row['definition_id']}'::uuid, '${row['version_id']}'::uuid,
           '${row['series_id']}'::uuid, 0,
           'WRONG SOURCE TITLE', 'Coverage', 'Test', 'personal',
           '${firstMemberId}'::uuid, '${row['config']}'::jsonb,
           '${row['provenance']}'::jsonb,
           '{"targetMonth":"2026-12","activeLocalDate":"2026-12-01","timeZone":"Asia/Yekaterinburg","kind":"fixed","expectationDates":[]}'::jsonb)
      `),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query('ROLLBACK').catch(() => undefined)

    for (const calendar of [
      {
        targetMonth: '2026-12',
        activeLocalDate: '2026-12-01',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'quota',
        cadence: 'weekly',
        periods: [],
      },
      {
        targetMonth: '2026-11',
        activeLocalDate: '2026-12-01',
        timeZone: 'Asia/Yekaterinburg',
        kind: 'fixed',
        expectationDates: [],
      },
    ]) {
      const mutatedPublicationId = randomUUID()
      await pool.query('BEGIN')
      await pool.query(
        `
        INSERT INTO plan_publications
          (id, space_id, plan_month_id, publication_revision,
           source_draft_revision, source_plan_month_revision, focus,
           activation_mode, active_local_date, late_publication, time_zone,
           source_preview_schema_version, preview_hash_version, preview_hash,
           calendar_formula_version, evaluation_formula_version,
           score_formula_version, published_by_member_id, published_at)
        VALUES
          ($1::uuid, '${spaceId}'::uuid, '${fixture.planMonthId}'::uuid, 1,
           ${draftRevision}, ${monthRevision},
           'Atomic P07 integration', 'immediate', '2026-12-01'::date, false,
           'Asia/Yekaterinburg', 'planner.publication-preview.v1',
           'planner.publication-preview-hash.v1', repeat('b', 64),
           'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
           'planner.score-coverage.v1', '${firstMemberId}'::uuid,
           '2026-12-01T00:00:00+05:00'::timestamptz)
      `,
        [mutatedPublicationId],
      )
      await expect(
        pool.query(
          `
          INSERT INTO plan_goal_snapshots
            (id, publication_id, space_id, plan_month_id,
             source_plan_goal_id, source_draft_goal_revision_id,
             source_config_revision, goal_definition_id,
             goal_definition_version_id, goal_series_id, display_order,
             title, why, category, scope_kind, owner_member_id,
             config, source_provenance, calendar)
          VALUES
            (gen_random_uuid(), $1::uuid, '${spaceId}'::uuid,
             '${fixture.planMonthId}'::uuid, '${row['plan_goal_id']}'::uuid,
             '${row['source_revision_id']}'::uuid, ${row['config_revision']},
             '${row['definition_id']}'::uuid, '${row['version_id']}'::uuid,
             '${row['series_id']}'::uuid, 0, 'Daily checklist', 'Coverage',
             'Test', 'personal', '${firstMemberId}'::uuid,
             '${row['config']}'::jsonb, '${row['provenance']}'::jsonb,
             $2::jsonb)
        `,
          [mutatedPublicationId, JSON.stringify(calendar)],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await pool.query('ROLLBACK').catch(() => undefined)
    }
  })

  it('rejects a weekly planned-task calendar whose ordinal differs from the locked source config', async () => {
    clock.set(new Date('2027-12-31T19:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2028-01', focus: 'Weekly ordinal source lock' },
    })
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: {
        title: 'Second week task',
        why: 'The selected week is source data',
        category: 'Test',
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
          scope: { kind: 'shared' },
          repetition: {
            kind: 'weekly_planned_task',
            weekOrdinal: '2',
            taskText: 'Do the second week task',
          },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2028-01',
    })
    if (preview === null) throw new Error('weekly task preview missing')
    const source = await pool.query<Record<string, unknown>>(
      `SELECT root.id::text plan_goal_id, root.current_revision_id::text revision_id,
              root.display_order, revision.revision_number::text config_revision,
              revision.goal_definition_version_id::text version_id,
              revision.goal_series_id::text series_id, revision.config,
              version.title, version.why, version.category
         FROM plan_draft_goals root
         JOIN plan_draft_goal_revisions revision
           ON revision.id = root.current_revision_id
         JOIN goal_definition_versions version
           ON version.id = revision.goal_definition_version_id
        WHERE root.plan_month_id = $1::uuid`,
      [draft.aggregateId],
    )
    const row = source.rows[0]!
    const publicationId = randomUUID()
    await pool.query('BEGIN')
    await pool.query(
      `INSERT INTO plan_publications
        (id, space_id, plan_month_id, publication_revision,
         source_draft_revision, source_plan_month_revision, focus,
         activation_mode, active_local_date, late_publication, time_zone,
         source_preview_schema_version, preview_hash_version, preview_hash,
         calendar_formula_version, evaluation_formula_version,
         score_formula_version, published_by_member_id, published_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::bigint, $5::bigint,
         $6, 'immediate', '2028-01-01'::date, false,
         'Asia/Yekaterinburg', 'planner.publication-preview.v1',
         'planner.publication-preview-hash.v1', repeat('9', 64),
         'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
         'planner.score-coverage.v1', $7::uuid,
         '2028-01-01T00:00:00+05:00'::timestamptz)`,
      [
        publicationId,
        spaceId,
        draft.aggregateId,
        preview.draftRevision,
        preview.planMonthRevision,
        preview.focus,
        firstMemberId,
      ],
    )
    const wrongCalendar = {
      targetMonth: '2028-01',
      activeLocalDate: '2028-01-01',
      timeZone: 'Asia/Yekaterinburg',
      kind: 'weekly_planned_task',
      periods: [
        {
          cadence: 'weekly',
          ordinal: 1,
          periodStart: '2028-01-01',
          periodEnd: '2028-01-02',
          periodTarget: 1,
        },
      ],
    }
    await expect(
      pool.query(
        `INSERT INTO plan_goal_snapshots
          (id, publication_id, space_id, plan_month_id,
           source_plan_goal_id, source_draft_goal_revision_id,
           source_config_revision, goal_definition_id,
           goal_definition_version_id, goal_series_id, display_order,
           title, why, category, scope_kind, owner_member_id,
           config, source_provenance, calendar)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
           $4::uuid, $5::uuid, $6::bigint, $7::uuid, $8::uuid, $9::uuid,
           $10::integer, $11, $12, $13, 'shared', NULL,
           $14::jsonb, NULL, $15::jsonb)`,
        [
          publicationId,
          spaceId,
          draft.aggregateId,
          row['plan_goal_id'],
          row['revision_id'],
          row['config_revision'],
          definition.aggregateId,
          row['version_id'],
          row['series_id'],
          row['display_order'],
          row['title'],
          row['why'],
          row['category'],
          JSON.stringify(row['config']),
          JSON.stringify(wrongCalendar),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query('ROLLBACK').catch(() => undefined)
    await expectUnpublished(draft.aggregateId)
  })

  it.each([
    {
      name: 'segment longer than seven days only',
      activeLocalDate: '2028-02-01',
      periods: [
        {
          cadence: 'weekly',
          ordinal: 2,
          periodStart: '2028-02-06',
          periodEnd: '2028-02-13',
          periodTarget: 1,
        },
      ],
    },
    {
      name: 'wrong nonempty calendar after the selected period expired',
      activeLocalDate: '2028-02-14',
      periods: [
        {
          cadence: 'weekly',
          ordinal: 2,
          periodStart: '2028-02-07',
          periodEnd: '2028-02-13',
          periodTarget: 1,
        },
      ],
    },
  ])(
    'rejects isolated weekly-task calendar mutant: $name',
    async ({ activeLocalDate, periods }) => {
      await expectWeeklyTaskCalendarRejected(activeLocalDate, {
        targetMonth: '2028-02',
        activeLocalDate,
        timeZone: 'Asia/Yekaterinburg',
        kind: 'weekly_planned_task',
        periods,
      })
    },
  )

  it('keeps active selected-week emptiness in the P04/application hash boundary, not the SQL shape calculator', async () => {
    const fixture = await weeklyTaskFixture()
    clock.set(new Date('2028-02-06T19:00:00.000Z'))
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2028-02',
    })
    expect(preview).not.toBeNull()
    expect(
      (preview?.calculatedTargets as readonly Record<string, unknown>[])[0]?.[
        'calendar'
      ],
    ).toEqual({
      targetMonth: '2028-02',
      activeLocalDate: '2028-02-07',
      timeZone: 'Asia/Yekaterinburg',
      kind: 'weekly_planned_task',
      periods: [
        {
          cadence: 'weekly',
          ordinal: 2,
          periodStart: '2028-02-07',
          periodEnd: '2028-02-13',
          periodTarget: 1,
        },
      ],
    })
    const shape = await pool.query<{ valid: boolean }>(
      `SELECT p07_calendar_has_exact_shape($1::jsonb) valid`,
      [
        JSON.stringify({
          targetMonth: '2028-02',
          activeLocalDate: '2028-02-07',
          timeZone: 'Asia/Yekaterinburg',
          kind: 'weekly_planned_task',
          periods: [],
        }),
      ],
    )
    expect(shape.rows).toEqual([{ valid: true }])
    expect(fixture.planMonthId).toBe(preview?.planMonthId)
  })

  it('rolls back every materialization phase and the pre-receipt boundary, then safely retries', async () => {
    clock.set(new Date('2027-01-31T19:00:00.000Z'))
    const fixture = await draftWithChecklist('2027-02')
    const phases: readonly PublicationWritePhase[] = [
      'publication',
      'goal_snapshots',
      'fixed_expectations',
      'flexible_periods',
      'month_pointer',
      'history',
    ]
    for (const failedPhase of phases) {
      const command = new PublishMonthCommand(
        new DurableCommandExecutor(
          transaction,
          new PrismaCommandReceiptAdapter(provider),
          clock,
        ),
        members,
        new PrismaPublicationPersistence(provider, (phase) => {
          if (phase === failedPhase) throw new Error(`fail:${phase}`)
        }),
      )
      await expect(
        command.execute(publishCommand(fixture) as never),
      ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
      await expectUnpublished(fixture.planMonthId)
    }

    const realReceipts = new PrismaCommandReceiptAdapter(provider)
    const failingReceipts: CommandReceiptPort = {
      acquireLock: (key) => realReceipts.acquireLock(key),
      findCompleted: (key) => realReceipts.findCompleted(key),
      insertCompleted: () => Promise.reject(new Error('fail:before_receipt')),
    }
    const preReceipt = new PublishMonthCommand(
      new DurableCommandExecutor(transaction, failingReceipts, clock),
      members,
      new PrismaPublicationPersistence(provider),
    )
    await expect(
      preReceipt.execute(publishCommand(fixture) as never),
    ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
    await expectUnpublished(fixture.planMonthId)
    await expect(
      application.publishMonth.execute(publishCommand(fixture)),
    ).resolves.toMatchObject({ kind: 'planning.plan-publication.v1' })
  })

  it('rolls back when locked source order changes after snapshot materialization', async () => {
    clock.set(new Date('2027-08-31T19:00:00.000Z'))
    const first = await draftWithChecklist('2027-09')
    const definition = await application.createGoalDefinition.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { title: 'Second goal', why: 'Order guard', category: 'Test' },
    })
    await application.addDraftGoal.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      expectedRevision: BigInt(String(first.preview['draftRevision'])),
      payload: {
        planMonthId: first.planMonthId,
        goalDefinitionId: definition.aggregateId,
        config: {
          schemaVersion: 1,
          scope: { kind: 'shared' },
          repetition: { kind: 'daily' },
          measurement: { kind: 'boolean' },
          checkpoints: null,
        },
        sourceProvenance: null,
      },
    })
    const preview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2027-09',
    })
    if (preview === null) throw new Error('preview missing')
    const fixture = { ...first, preview }
    const roots = await pool.query<{ id: string; display_order: number }>(
      `SELECT id::text, display_order
         FROM plan_draft_goals
        WHERE plan_month_id = $1::uuid AND detached_at IS NULL
        ORDER BY display_order`,
      [fixture.planMonthId],
    )
    expect(roots.rows.map(({ display_order }) => display_order)).toEqual([0, 1])

    const command = new PublishMonthCommand(
      new DurableCommandExecutor(
        transaction,
        new PrismaCommandReceiptAdapter(provider),
        clock,
      ),
      members,
      new PrismaPublicationPersistence(provider, async (phase) => {
        if (phase !== 'goal_snapshots') return
        await provider.withClient(async (client) => {
          await client.$executeRaw`
            UPDATE plan_draft_goals SET display_order = 399
             WHERE id = ${roots.rows[0]!.id}::uuid
          `
          await client.$executeRaw`
            UPDATE plan_draft_goals SET display_order = 0
             WHERE id = ${roots.rows[1]!.id}::uuid
          `
          await client.$executeRaw`
            UPDATE plan_draft_goals SET display_order = 1
             WHERE id = ${roots.rows[0]!.id}::uuid
          `
        })
      }),
    )

    await expect(
      command.execute(publishCommand(fixture) as never),
    ).rejects.toMatchObject({ name: 'PlanningDependencyUnavailableError' })
    await expectUnpublished(fixture.planMonthId)
    const after = await pool.query<{ id: string; display_order: number }>(
      `SELECT id::text, display_order
         FROM plan_draft_goals
        WHERE plan_month_id = $1::uuid AND detached_at IS NULL
        ORDER BY display_order`,
      [fixture.planMonthId],
    )
    expect(after.rows).toEqual(roots.rows)
  })

  it('rejects SQL activation mutants and non-finite publication time before materialization', async () => {
    clock.set(new Date('2027-02-28T19:00:00.000Z'))
    const draft = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2027-03', focus: 'Activation guards' },
    })
    const values: readonly {
      mode: 'immediate' | 'scheduled'
      activeDate: string
      publishedAt: string
    }[] = [
      {
        mode: 'immediate',
        activeDate: '2027-03-02',
        publishedAt: '2027-03-01T00:00:00+05:00',
      },
      {
        mode: 'scheduled',
        activeDate: '2027-03-01',
        publishedAt: '2027-03-01T00:00:00+05:00',
      },
      { mode: 'immediate', activeDate: '2027-03-01', publishedAt: 'infinity' },
    ]
    for (const value of values) {
      await expect(
        pool.query(
          `
          INSERT INTO plan_publications
            (id, space_id, plan_month_id, publication_revision,
             source_draft_revision, source_plan_month_revision, focus,
             activation_mode, active_local_date, late_publication, time_zone,
             source_preview_schema_version, preview_hash_version, preview_hash,
             calendar_formula_version, evaluation_formula_version,
             score_formula_version, published_by_member_id, published_at)
          VALUES
            (gen_random_uuid(), $1::uuid, $2::uuid, 1, 1, 1,
             'Activation guards', $3, $4::date, $4::date > '2027-03-01'::date,
             'Asia/Yekaterinburg', 'planner.publication-preview.v1',
             'planner.publication-preview-hash.v1', repeat('c', 64),
             'planner.calendar-targets.v1', 'planner.goal-evaluation.v1',
             'planner.score-coverage.v1', $5::uuid, $6::timestamptz)
        `,
          [
            spaceId,
            draft.aggregateId,
            value.mode,
            value.activeDate,
            firstMemberId,
            value.publishedAt,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
    await expectUnpublished(draft.aggregateId)
  })

  it('rejects a publish command receipt with a wrong result kind and no exact action/detail', async () => {
    await expect(
      pool.query(`
        INSERT INTO command_receipts
          (actor_scope, command_type, command_id, fingerprint, result_kind,
           aggregate_id, aggregate_revision, completed_at)
        VALUES
          ('member:${firstMemberId}', 'planning.publish-month.v1',
           gen_random_uuid(), repeat('d', 64), 'planning.plan-draft.v1',
           gen_random_uuid(), 1, now())
      `),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('serializes a concurrent draft edit against publication without a mixed commit', async () => {
    clock.set(new Date('2027-03-31T19:00:00.000Z'))
    const fixture = await draftWithChecklist('2027-04')
    const attempts = await Promise.allSettled([
      application.publishMonth.execute(publishCommand(fixture)),
      application.updateMonthFocus.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(String(fixture.preview['draftRevision'])),
        payload: {
          planMonthId: fixture.planMonthId,
          focus: 'Concurrent edit won',
        },
      }),
    ])
    expect(
      attempts.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1)
    const state = await pool.query<Record<string, string | null>>(
      `
      SELECT month.status, draft.focus,
             count(publication.id)::text publications
        FROM plan_months month
        JOIN plan_drafts draft ON draft.plan_month_id = month.id
        LEFT JOIN plan_publications publication
          ON publication.plan_month_id = month.id
       WHERE month.id = $1::uuid
       GROUP BY month.status, draft.focus
    `,
      [fixture.planMonthId],
    )
    const row = state.rows[0]!
    if (row['status'] === 'published') {
      expect(row).toEqual({
        status: 'published',
        focus: 'Atomic P07 integration',
        publications: '1',
      })
      expect(
        attempts.find((value) => value.status === 'rejected'),
      ).toMatchObject({ reason: { name: 'PlanDraftNotEditableError' } })
    } else {
      expect(row).toEqual({
        status: 'draft',
        focus: 'Concurrent edit won',
        publications: '0',
      })
      expect(
        attempts.find((value) => value.status === 'rejected'),
      ).toMatchObject({ reason: { name: 'PublicationPreviewConflictError' } })
    }
  })

  it('prioritizes a stale confirmed preview over newly introduced blockers and returns blockers for an exact blocked preview', async () => {
    clock.set(new Date('2027-04-30T19:00:00.000Z'))
    const clean = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2027-05', focus: 'Initially clean' },
    })
    const cleanPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2027-05',
    })
    if (cleanPreview === null) throw new Error('clean preview missing')
    expect(cleanPreview.blockers).toEqual([])
    clock.set(new Date('2027-05-31T19:00:00.000Z'))
    await expect(
      application.publishMonth.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(cleanPreview.draftRevision),
        payload: {
          planMonthId: clean.aggregateId,
          previewSchemaVersion: cleanPreview.schemaVersion,
          previewHashVersion: cleanPreview.previewHashVersion,
          previewHash: cleanPreview.previewHash,
        },
      }),
    ).rejects.toMatchObject({ name: 'PublicationPreviewConflictError' })
    await expectUnpublished(clean.aggregateId)

    const blocked = await application.createEmptyDraft.execute({
      commandId: randomUUID(),
      trustedActor: actor(),
      payload: { targetMonth: '2027-08', focus: 'Already blocked' },
    })
    const blockedPreview = await application.buildPublicationPreview.execute({
      trustedUserId: firstUserId,
      targetMonth: '2027-08',
    })
    if (blockedPreview === null) throw new Error('blocked preview missing')
    expect(blockedPreview.blockers).not.toEqual([])
    await expect(
      application.publishMonth.execute({
        commandId: randomUUID(),
        trustedActor: actor(),
        expectedRevision: BigInt(blockedPreview.draftRevision),
        payload: {
          planMonthId: blocked.aggregateId,
          previewSchemaVersion: blockedPreview.schemaVersion,
          previewHashVersion: blockedPreview.previewHashVersion,
          previewHash: blockedPreview.previewHash,
        },
      }),
    ).rejects.toMatchObject({
      name: 'PlanPublicationBlockedError',
      blockers: blockedPreview.blockers,
    })
    await expectUnpublished(blocked.aggregateId)
  })

  async function publicationState(
    planMonthId: string,
    commandId: string,
  ): Promise<readonly Record<string, string | null>[]> {
    const rows = await pool.query<Record<string, string | null>>(
      `
      SELECT month.status, month.revision::text month_revision,
             month.xmin::text month_xmin,
             month.active_publication_id::text active_publication_id,
             draft.revision::text draft_revision,
             draft.xmin::text draft_xmin,
             (SELECT count(*)::text FROM plan_publications publication
               WHERE publication.plan_month_id = month.id) publications,
             (SELECT count(*)::text FROM plan_goal_snapshots snapshot
               WHERE snapshot.plan_month_id = month.id) snapshots,
             (SELECT count(*)::text FROM fixed_expectations expectation
               JOIN plan_goal_snapshots snapshot
                 ON snapshot.id = expectation.plan_goal_snapshot_id
              WHERE snapshot.plan_month_id = month.id) fixed_expectations,
             (SELECT count(*)::text FROM flexible_periods period
               JOIN plan_goal_snapshots snapshot
                 ON snapshot.id = period.plan_goal_snapshot_id
              WHERE snapshot.plan_month_id = month.id) flexible_periods,
             (SELECT count(*)::text FROM planning_publication_changes change
               JOIN plan_publications publication
                 ON publication.id = change.publication_id
              WHERE publication.plan_month_id = month.id) publication_changes,
             (SELECT count(*)::text FROM planning_action_groups action
               WHERE action.plan_month_id = month.id
                 AND action.action_kind = 'month_published') actions,
             (SELECT count(*)::text FROM command_receipts receipt
               WHERE receipt.command_id = $2::uuid
                 AND receipt.command_type = 'planning.publish-month.v1') receipts
        FROM plan_months month
        JOIN plan_drafts draft ON draft.plan_month_id = month.id
       WHERE month.id = $1::uuid
    `,
      [planMonthId, commandId],
    )
    return rows.rows
  }

  async function expectUnpublished(planMonthId: string): Promise<void> {
    const rows = await pool.query<Record<string, string | null>>(
      `
      SELECT month.status, month.revision::text revision,
             month.active_publication_id::text active_publication_id,
             (SELECT count(*)::text FROM plan_publications publication
               WHERE publication.plan_month_id = month.id) publications,
             (SELECT count(*)::text FROM planning_action_groups action
               WHERE action.plan_month_id = month.id
                 AND action.action_kind = 'month_published') actions,
             (SELECT count(*)::text FROM command_receipts receipt
               WHERE receipt.result_kind = 'planning.plan-publication.v1'
                 AND receipt.aggregate_id IN (
                   SELECT id FROM plan_publications publication
                    WHERE publication.plan_month_id = month.id
                 )) receipts
        FROM plan_months month WHERE month.id = $1::uuid
    `,
      [planMonthId],
    )
    expect(rows.rows).toEqual([
      {
        status: 'draft',
        revision: '1',
        active_publication_id: null,
        publications: '0',
        actions: '0',
        receipts: '0',
      },
    ])
  }
})
