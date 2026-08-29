import { Injectable } from '@nestjs/common'

import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  MonthHistoryActorRecord,
  MonthHistoryEventRecord,
  MonthHistoryHeaderRecord,
  MonthHistoryMode,
  MonthHistoryReadPort,
  MonthHistoryStatus,
} from '../application/month-history.read.port'

interface HeaderRow {
  readonly plan_month_id: string
  readonly target_month: string
  readonly status: string
  readonly lifecycle_mode: string
  readonly revision: string
}

interface EventRow {
  readonly action_id: string
  readonly action_kind: string
  readonly member_id: string | null
  readonly system_actor_id: string | null
  readonly before_revision: string
  readonly after_revision: string
  readonly occurred_at: Date
  readonly reason: string | null
  readonly publication_id: string | null
  readonly publication_revision: string | null
  readonly report_revision_id: string | null
  readonly report_revision: string | null
  readonly previous_action_kind: string | null
}

const lifecycleKinds = [
  'month_published',
  'month_publication_cancelled',
  'month_grace_started',
  'month_closed',
  'month_reopened',
  'month_reclosed',
] as const

function actor(
  memberId: string | null,
  systemId: string | null,
): MonthHistoryActorRecord {
  if (memberId !== null && systemId === null)
    return { kind: 'member', id: memberId }
  if (memberId === null && systemId !== null)
    return { kind: 'system', id: systemId }
  throw new Error('Invalid month history actor')
}

function status(value: string): MonthHistoryStatus {
  if (
    value === 'draft' ||
    value === 'published' ||
    value === 'grace' ||
    value === 'closed'
  )
    return value
  throw new Error('Invalid month history status')
}

function mode(value: string): MonthHistoryMode {
  if (value === 'ordinary' || value === 'reopened') return value
  throw new Error('Invalid month history mode')
}

function eventState(
  row: EventRow,
): Pick<MonthHistoryEventRecord, 'kind' | 'before' | 'after'> {
  const previousMode: MonthHistoryMode =
    row.previous_action_kind === 'month_reopened' ||
    row.previous_action_kind === 'month_reclosed'
      ? 'reopened'
      : 'ordinary'
  switch (row.action_kind) {
    case 'month_published':
      return {
        kind: 'published',
        before: {
          status: 'draft',
          mode: 'ordinary',
          revision: row.before_revision,
        },
        after: {
          status: 'published',
          mode: 'ordinary',
          revision: row.after_revision,
        },
      }
    case 'month_publication_cancelled':
      return {
        kind: 'publication_cancelled',
        before: {
          status: 'published',
          mode: 'ordinary',
          revision: row.before_revision,
        },
        after: {
          status: 'draft',
          mode: 'ordinary',
          revision: row.after_revision,
        },
      }
    case 'month_grace_started':
      return {
        kind: 'grace_started',
        before: {
          status: 'published',
          mode: 'ordinary',
          revision: row.before_revision,
        },
        after: {
          status: 'grace',
          mode: 'ordinary',
          revision: row.after_revision,
        },
      }
    case 'month_closed':
      return {
        kind: 'closed',
        before: {
          status: 'grace',
          mode: 'ordinary',
          revision: row.before_revision,
        },
        after: {
          status: 'closed',
          mode: 'ordinary',
          revision: row.after_revision,
        },
      }
    case 'month_reopened':
      return {
        kind: 'reopened',
        before: {
          status: 'closed',
          mode: previousMode,
          revision: row.before_revision,
        },
        after: {
          status: 'grace',
          mode: 'reopened',
          revision: row.after_revision,
        },
      }
    case 'month_reclosed':
      return {
        kind: 'reclosed',
        before: {
          status: 'grace',
          mode: 'reopened',
          revision: row.before_revision,
        },
        after: {
          status: 'closed',
          mode: 'reopened',
          revision: row.after_revision,
        },
      }
    default:
      throw new Error('Invalid month history event')
  }
}

@Injectable()
export class PrismaMonthHistoryRead implements MonthHistoryReadPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public readHeader(input: {
    readonly spaceId: string
    readonly planMonthId: string
  }): Promise<MonthHistoryHeaderRecord | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<HeaderRow[]>`
        SELECT month.id::text plan_month_id,
               to_char(month.month_start, 'YYYY-MM') target_month,
               month.status, month.lifecycle_mode,
               month.revision::text
          FROM plan_months month
         WHERE month.id = ${input.planMonthId}::uuid
           AND month.space_id = ${input.spaceId}::uuid
      `
      const row = rows[0]
      return row === undefined
        ? null
        : {
            planMonthId: row.plan_month_id,
            targetMonth: row.target_month,
            current: {
              status: status(row.status),
              mode: mode(row.lifecycle_mode),
              revision: row.revision,
            },
          }
    })
  }

  public readEvents(input: {
    readonly spaceId: string
    readonly planMonthId: string
    readonly limit: number
    readonly cursor: bigint | null
  }): Promise<readonly MonthHistoryEventRecord[]> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<EventRow[]>`
        WITH lifecycle AS (
          SELECT action.*,
                 lag(action.action_kind) OVER (
                   PARTITION BY action.plan_month_id
                   ORDER BY action.after_revision, action.id
                 ) previous_action_kind
            FROM planning_action_groups action
           WHERE action.plan_month_id = ${input.planMonthId}::uuid
             AND action.action_kind IN (${lifecycleKinds[0]}, ${lifecycleKinds[1]},
               ${lifecycleKinds[2]}, ${lifecycleKinds[3]},
               ${lifecycleKinds[4]}, ${lifecycleKinds[5]})
        )
        SELECT action.id::text action_id, action.action_kind,
               action.member_id::text, action.system_actor_id,
               action.before_revision::text,
               action.after_revision::text, action.occurred_at,
               reopen.reason,
               publication.id::text publication_id,
               publication.publication_revision::text,
               report.id::text report_revision_id,
               report.revision::text report_revision,
               action.previous_action_kind
          FROM lifecycle action
          JOIN plan_months month ON month.id = action.plan_month_id
          LEFT JOIN planning_publication_changes publication_change
            ON publication_change.action_id = action.id
          LEFT JOIN plan_publications publication
            ON publication.id = publication_change.publication_id
          LEFT JOIN planning_month_reopen_changes reopen
            ON reopen.action_id = action.id
          LEFT JOIN LATERAL (
            SELECT candidate.id, candidate.revision
              FROM report_revisions candidate
             WHERE candidate.plan_month_id = action.plan_month_id
               AND action.action_kind IN ('month_closed', 'month_reclosed')
               AND candidate.revision = (
                 SELECT count(*)::bigint
                   FROM planning_action_groups report_action
                  WHERE report_action.plan_month_id = action.plan_month_id
                    AND report_action.action_kind IN ('month_closed', 'month_reclosed')
                    AND report_action.after_revision <= action.after_revision
               )
             ORDER BY candidate.revision DESC
             LIMIT 1
          ) report ON TRUE
         WHERE month.space_id = ${input.spaceId}::uuid
           AND (${input.cursor}::bigint IS NULL
                OR action.after_revision < ${input.cursor}::bigint)
         ORDER BY action.after_revision DESC, action.id DESC
         LIMIT ${input.limit}
      `
      return Object.freeze(
        rows.map((row): MonthHistoryEventRecord => {
          const state = eventState(row)
          const requiresPublication =
            state.kind === 'published' || state.kind === 'publication_cancelled'
          const requiresReport =
            state.kind === 'closed' || state.kind === 'reclosed'
          if (
            requiresPublication !== (row.publication_id !== null) ||
            requiresPublication !== (row.publication_revision !== null) ||
            requiresReport !== (row.report_revision_id !== null) ||
            requiresReport !== (row.report_revision !== null) ||
            (state.kind === 'reopened') !== (row.reason !== null)
          ) {
            throw new Error('Invalid month history detail')
          }
          return {
            id: row.action_id,
            ...state,
            actor: actor(row.member_id, row.system_actor_id),
            occurredAt: row.occurred_at.toISOString(),
            reason: row.reason,
            publication:
              row.publication_id === null
                ? null
                : {
                    publicationId: row.publication_id,
                    revision: row.publication_revision!,
                  },
            report:
              row.report_revision_id === null
                ? null
                : {
                    reportRevisionId: row.report_revision_id,
                    revision: row.report_revision!,
                  },
          }
        }),
      )
    })
  }
}
