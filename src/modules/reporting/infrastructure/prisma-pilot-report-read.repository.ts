import {
  CALENDAR_TARGETS_FORMULA_VERSION,
  GOAL_EVALUATION_FORMULA_VERSION,
  SCORE_COVERAGE_FORMULA_VERSION,
} from '@/modules/progress'
import type {
  FactPersistencePort,
  GetGoalProgressPersistenceInput,
} from '@/modules/tracking'
import { TrackingProgressSourceInvalidError } from '@/modules/tracking'
import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { reportPayloadChecksum } from '@/shared/application/report-payload-integrity'

import {
  PilotReportSourceChangedError,
  PilotReportSourceInvalidError,
} from '../application/pilot-report.errors'
import type {
  PilotReportMonthReadPort,
  PilotReportReadPort,
} from '../application/pilot-report-read.port'
import type {
  CalculatePilotReportInput,
  PilotReportMonthSourceInput,
  PilotReportMonthSourceV1,
  PilotReportReadModelV1,
  PilotReportSourceGoalV1,
  PilotReportSourceV1,
} from '../application/pilot-report.types'

const MAX_GOALS = 200n
const MAX_MATERIALIZED_UNITS = 10_000n
const MAX_CURRENT_FACTS = 10_000n

type GoalProgressInputReader = Pick<FactPersistencePort, 'getGoalProgressInput'>

type HeaderRow = {
  readonly space_id: string
  readonly plan_month_id: string
  readonly publication_id: string
  readonly publication_revision: bigint
  readonly facts_revision: bigint
  readonly calendar_formula_version: string
  readonly evaluation_formula_version: string
  readonly score_formula_version: string
  readonly goal_count: bigint
  readonly materialized_count: bigint
  readonly current_fact_count: bigint
}

type MemberRow = {
  readonly member_id: string
  readonly slot: number
}

type GoalRow = {
  readonly plan_goal_snapshot_id: string
  readonly title: string
  readonly display_order: number
  readonly scope_kind: 'personal' | 'shared'
  readonly owner_member_id: string | null
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient

function restoreStoredReport(value: unknown): PilotReportReadModelV1 {
  if (value === null || typeof value !== 'object') {
    throw new PilotReportSourceInvalidError()
  }
  const payload = value as Record<string, unknown>
  const sourceValue = payload.source
  if (
    sourceValue === null ||
    typeof sourceValue !== 'object' ||
    payload.status !== 'closed'
  ) {
    throw new PilotReportSourceInvalidError()
  }
  const source = sourceValue as Record<string, unknown>
  if (
    typeof source.publicationRevision !== 'string' ||
    typeof source.factsRevision !== 'string'
  ) {
    throw new PilotReportSourceInvalidError()
  }
  try {
    return freeze({
      ...payload,
      status: 'closed' as const,
      source: {
        ...source,
        publicationRevision: BigInt(source.publicationRevision),
        factsRevision: BigInt(source.factsRevision),
      },
    }) as PilotReportReadModelV1
  } catch (error: unknown) {
    throw new PilotReportSourceInvalidError({ cause: error })
  }
}

export class PrismaPilotReportReadRepository
  implements PilotReportReadPort, PilotReportMonthReadPort
{
  public constructor(
    private readonly database: PrismaClientProvider,
    private readonly progressInputs: GoalProgressInputReader,
  ) {}

  public load(
    input: CalculatePilotReportInput,
  ): Promise<PilotReportSourceV1 | null> {
    return this.database.withClient((client) =>
      this.loadForPublication(client, input),
    )
  }

  public loadByMonth(
    input: PilotReportMonthSourceInput,
  ): Promise<PilotReportMonthSourceV1 | null> {
    return this.database.withClient(async (client) => {
      const rows = await client.$queryRaw<
        {
          readonly publication_id: string
          readonly publication_snapshot_hash: string
          readonly lifecycle_status: 'published' | 'grace' | 'closed'
          readonly active_local_date: string
          readonly report_payload: Prisma.JsonValue
          readonly report_publication_snapshot_hash: string | null
          readonly report_payload_checksum: string | null
        }[]
      >`
        SELECT publication.id::text publication_id,
               publication.preview_hash publication_snapshot_hash,
               month.status lifecycle_status,
               publication.active_local_date::text active_local_date,
               revision.payload report_payload,
               revision.publication_snapshot_hash report_publication_snapshot_hash,
               revision.payload_checksum report_payload_checksum
          FROM plan_months month
          JOIN plan_publications publication
            ON publication.id = month.active_publication_id
          LEFT JOIN report_revisions revision
            ON revision.plan_month_id = month.id
           AND revision.status = 'original'
         WHERE month.space_id = ${input.spaceId}::uuid
           AND month.month_start = ${`${input.targetMonth}-01`}::date
           AND month.status IN ('published', 'grace', 'closed')
      `
      if (rows.length > 1) throw new PilotReportSourceInvalidError()
      const row = rows[0]
      if (row === undefined) return null
      if (row.lifecycle_status === 'closed') {
        if (
          row.report_payload === null ||
          row.report_publication_snapshot_hash !==
            row.publication_snapshot_hash ||
          row.report_payload_checksum === null ||
          !/^[0-9a-f]{64}$/.test(row.report_payload_checksum) ||
          reportPayloadChecksum(row.report_payload) !==
            row.report_payload_checksum
        ) {
          throw new PilotReportSourceInvalidError()
        }
        return freeze({
          storedReport: restoreStoredReport(row.report_payload),
          lifecycleStatus: 'closed' as const,
          activeLocalDate: row.active_local_date,
        })
      }
      const source = await this.loadForPublication(client, {
        spaceId: input.spaceId,
        publicationId: row.publication_id,
        asOfLocalDate: input.asOfLocalDate,
      })
      if (source === null) return null
      return freeze({
        source,
        lifecycleStatus: row.lifecycle_status,
        activeLocalDate: row.active_local_date,
      })
    })
  }

  private async loadForPublication(
    client: DatabaseClient,
    input: CalculatePilotReportInput,
  ): Promise<PilotReportSourceV1 | null> {
    const headers = await client.$queryRaw<HeaderRow[]>`
        SELECT publication.space_id::text space_id,
               publication.plan_month_id::text plan_month_id,
               publication.id::text publication_id,
               publication.publication_revision,
               month.facts_revision,
               publication.calendar_formula_version,
               publication.evaluation_formula_version,
               publication.score_formula_version,
               (SELECT count(*)
                  FROM plan_goal_snapshots snapshot
                 WHERE snapshot.publication_id = publication.id) goal_count,
               ((SELECT count(*)
                   FROM fixed_expectations expectation
                  WHERE expectation.publication_id = publication.id) +
                (SELECT count(*)
                   FROM flexible_periods period
                  WHERE period.publication_id = publication.id)) materialized_count,
               (SELECT count(*)
                  FROM tracking_fact_records record
                 WHERE record.publication_id = publication.id
                   AND record.current_revision_id IS NOT NULL) current_fact_count
         FROM plan_publications publication
          JOIN plan_months month ON month.id = publication.plan_month_id
         WHERE publication.id = ${input.publicationId}::uuid
           AND publication.space_id = ${input.spaceId}::uuid
           AND month.active_publication_id = publication.id
           AND month.status IN ('published', 'grace')
      `
    if (headers.length > 1) throw new PilotReportSourceInvalidError()
    const header = headers[0]
    if (header === undefined) return null
    if (
      header.calendar_formula_version !== CALENDAR_TARGETS_FORMULA_VERSION ||
      header.evaluation_formula_version !== GOAL_EVALUATION_FORMULA_VERSION ||
      header.score_formula_version !== SCORE_COVERAGE_FORMULA_VERSION ||
      header.goal_count > MAX_GOALS ||
      header.materialized_count > MAX_MATERIALIZED_UNITS ||
      header.current_fact_count > MAX_CURRENT_FACTS
    ) {
      throw new PilotReportSourceInvalidError()
    }

    const members = await client.$queryRaw<MemberRow[]>`
        SELECT id::text member_id, slot
          FROM memberships
         WHERE space_id = ${input.spaceId}::uuid
         ORDER BY slot, id
      `
    if (
      members.length !== 2 ||
      members[0]?.slot !== 1 ||
      members[1]?.slot !== 2 ||
      members[0].member_id === members[1].member_id
    ) {
      throw new PilotReportSourceInvalidError()
    }
    const memberIds = [members[0].member_id, members[1].member_id] as const
    const memberSet = new Set(memberIds)
    const rows = await client.$queryRaw<GoalRow[]>`
        SELECT id::text plan_goal_snapshot_id, title, display_order,
               scope_kind, owner_member_id::text
          FROM plan_goal_snapshots
         WHERE publication_id = ${input.publicationId}::uuid
         ORDER BY display_order, id
         LIMIT ${Number(MAX_GOALS + 1n)}
      `
    const goals: PilotReportSourceGoalV1[] = []
    for (const row of rows) {
      if (
        (row.scope_kind === 'personal' &&
          (row.owner_member_id === null ||
            !memberSet.has(row.owner_member_id))) ||
        (row.scope_kind === 'shared' && row.owner_member_id !== null)
      ) {
        throw new PilotReportSourceInvalidError()
      }
      const readInput: GetGoalProgressPersistenceInput = {
        spaceId: input.spaceId,
        publicationId: input.publicationId,
        planGoalSnapshotId: row.plan_goal_snapshot_id,
        asOfLocalDate: input.asOfLocalDate,
      }
      let progressInput
      try {
        progressInput =
          await this.progressInputs.getGoalProgressInput(readInput)
      } catch (error: unknown) {
        if (error instanceof TrackingProgressSourceInvalidError) {
          throw new PilotReportSourceInvalidError({ cause: error })
        }
        throw error
      }
      if (progressInput === null) throw new PilotReportSourceInvalidError()
      goals.push({
        planGoalSnapshotId: row.plan_goal_snapshot_id,
        title: row.title,
        displayOrder: row.display_order,
        scope:
          row.scope_kind === 'shared'
            ? { kind: 'shared' }
            : {
                kind: 'personal',
                ownerMemberId: row.owner_member_id!,
              },
        progressInput,
      })
    }
    const finalRevisions = await client.$queryRaw<
      { readonly facts_revision: bigint }[]
    >`
        SELECT facts_revision
          FROM plan_months
         WHERE id = ${header.plan_month_id}::uuid
           AND active_publication_id = ${input.publicationId}::uuid
           AND status IN ('published', 'grace')
      `
    if (
      finalRevisions.length !== 1 ||
      finalRevisions[0]!.facts_revision !== header.facts_revision
    ) {
      throw new PilotReportSourceChangedError()
    }
    return freeze({
      spaceId: header.space_id,
      planMonthId: header.plan_month_id,
      publicationId: header.publication_id,
      publicationRevision: header.publication_revision,
      factsRevision: header.facts_revision,
      formulaVersions: {
        calendar: CALENDAR_TARGETS_FORMULA_VERSION,
        evaluation: GOAL_EVALUATION_FORMULA_VERSION,
        scoreCoverage: SCORE_COVERAGE_FORMULA_VERSION,
      },
      memberIds,
      goals,
    })
  }
}
