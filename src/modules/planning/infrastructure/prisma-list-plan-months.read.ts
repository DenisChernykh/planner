import { Injectable } from '@nestjs/common'

import { Prisma } from '@/generated/prisma/client'
import { PrismaClientProvider } from '@/platform/database/prisma-client.provider'

import type {
  ListPlanMonthsReadInput,
  ListPlanMonthsReadPort,
  PlanMonthReadRecord,
} from '../application/list-plan-months.read.port'

interface PlanMonthRow {
  readonly plan_month_id: string
  readonly target_month: string
  readonly month_start: string
  readonly status: string
  readonly lifecycle_mode: string
  readonly month_revision: string
  readonly facts_revision: string
  readonly draft_revision: string | null
  readonly publication_id: string | null
  readonly publication_revision: string | null
  readonly active_local_date: string | null
  readonly active_publication_id: string | null
  readonly report_revision_id: string | null
  readonly report_revision: string | null
  readonly report_status: string | null
}

const select = Prisma.sql`
  SELECT month.id::text AS plan_month_id,
         to_char(month.month_start, 'YYYY-MM') AS target_month,
         month.month_start::text AS month_start,
         month.status,
         month.lifecycle_mode,
         month.revision::text AS month_revision,
         month.facts_revision::text AS facts_revision,
         draft.revision::text AS draft_revision,
         publication.id::text AS publication_id,
         publication.publication_revision::text AS publication_revision,
         publication.active_local_date::text AS active_local_date,
         month.active_publication_id::text AS active_publication_id,
         report.id::text AS report_revision_id,
         report.revision::text AS report_revision,
         report.status AS report_status
    FROM plan_months month
    LEFT JOIN plan_drafts draft
      ON draft.plan_month_id = month.id
    LEFT JOIN LATERAL (
      SELECT candidate.id,
             candidate.publication_revision,
             candidate.active_local_date
        FROM plan_publications candidate
       WHERE candidate.plan_month_id = month.id
         AND candidate.space_id = month.space_id
       ORDER BY candidate.publication_revision DESC, candidate.id DESC
       LIMIT 1
    ) publication ON TRUE
    LEFT JOIN LATERAL (
      SELECT candidate.id,
             candidate.revision,
             candidate.status
        FROM report_revisions candidate
       WHERE candidate.plan_month_id = month.id
       ORDER BY candidate.revision DESC, candidate.id DESC
       LIMIT 1
    ) report ON TRUE
`

function rowToRecord(row: PlanMonthRow): PlanMonthReadRecord {
  if (
    row.status !== 'draft' &&
    row.status !== 'published' &&
    row.status !== 'grace' &&
    row.status !== 'closed'
  ) {
    throw new Error('Invalid plan month status')
  }
  if (row.lifecycle_mode !== 'ordinary' && row.lifecycle_mode !== 'reopened') {
    throw new Error('Invalid plan month lifecycle mode')
  }
  if (
    (row.publication_id === null &&
      (row.publication_revision !== null || row.active_local_date !== null)) ||
    (row.publication_id !== null &&
      (row.publication_revision === null || row.active_local_date === null)) ||
    (row.report_revision_id === null &&
      (row.report_revision !== null || row.report_status !== null)) ||
    (row.report_revision_id !== null &&
      (row.report_revision === null || row.report_status === null))
  ) {
    throw new Error('Invalid plan month reference')
  }
  return {
    planMonthId: row.plan_month_id,
    targetMonth: row.target_month,
    monthStart: row.month_start,
    status: row.status,
    mode: row.lifecycle_mode,
    revision: row.month_revision,
    factsRevision: row.facts_revision,
    draftRevision: row.draft_revision,
    latestPublication:
      row.publication_id === null
        ? null
        : {
            publicationId: row.publication_id,
            revision: row.publication_revision!,
            activeLocalDate: row.active_local_date!,
            isActive: row.active_publication_id === row.publication_id,
          },
    latestReport:
      row.report_revision_id === null
        ? null
        : {
            reportRevisionId: row.report_revision_id,
            revision: row.report_revision!,
            status: row.report_status as 'original' | 'revised',
          },
  }
}

@Injectable()
export class PrismaListPlanMonthsRead implements ListPlanMonthsReadPort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public async read(
    input: ListPlanMonthsReadInput,
  ): Promise<readonly PlanMonthReadRecord[]> {
    const rows = await this.database.withClient((client) => {
      const order = Prisma.sql`
        ORDER BY month.month_start DESC, month.id DESC
        LIMIT ${input.limit}
      `
      if (input.cursor === null) {
        return client.$queryRaw<PlanMonthRow[]>`
          ${select}
          WHERE month.space_id = ${input.spaceId}::uuid
          ${order}
        `
      }
      const cursorMonth = `${input.cursor.targetMonth}-01`
      return client.$queryRaw<PlanMonthRow[]>`
        ${select}
        WHERE month.space_id = ${input.spaceId}::uuid
          AND (
            month.month_start < ${cursorMonth}::date
            OR (
              month.month_start = ${cursorMonth}::date
              AND month.id < ${input.cursor.planMonthId}::uuid
            )
          )
        ${order}
      `
    })
    return rows.map(rowToRecord)
  }
}
