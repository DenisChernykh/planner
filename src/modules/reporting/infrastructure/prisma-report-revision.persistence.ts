import { randomUUID } from 'node:crypto'

import type {
  CloseMonthReport,
  CloseMonthReportPersistenceInput,
} from '@/modules/planning/application/close-month.command'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import { reportPayloadChecksum } from '@/shared/application/report-payload-integrity'

import type { PilotReportRevisionPersistencePort } from '../application/build-pilot-report-revision'

export class PrismaReportRevisionPersistence implements PilotReportRevisionPersistencePort {
  public constructor(private readonly database: PrismaClientProvider) {}

  public append(input: {
    readonly report: CloseMonthReport
    readonly input: CloseMonthReportPersistenceInput
  }): Promise<{
    readonly reportRevisionId: string
    readonly revision: bigint
    readonly factsRevision: bigint
  }> {
    return this.database.withClient(async (client) => {
      const revisions = await client.$queryRaw<
        { readonly next_revision: bigint }[]
      >`
        SELECT COALESCE(MAX(revision), 0) + 1 next_revision
          FROM report_revisions
         WHERE plan_month_id = ${input.report.planMonthId}::uuid
      `
      const revision = revisions[0]!.next_revision
      const reportRevisionId = randomUUID()
      await client.$executeRaw`
        INSERT INTO report_revisions
          (id, plan_month_id, publication_id, revision,
           publication_snapshot_hash, source_facts_revision, formula_version,
           payload, payload_checksum, status, created_at,
           created_by_system_actor_id, created_by_member_id)
        VALUES
          (${reportRevisionId}::uuid, ${input.report.planMonthId}::uuid,
           ${input.report.publicationId}::uuid, ${revision},
           ${input.input.publicationSnapshotHash}, ${input.report.factsRevision},
           ${input.report.formulaVersion},
           ${JSON.stringify(input.report.payload, (_key, value: unknown) =>
             typeof value === 'bigint' ? value.toString(10) : value,
           )}::jsonb,
           ${reportPayloadChecksum(input.report.payload)},
           ${input.input.revisionStatus}, ${input.input.occurredAt},
           ${
             input.input.createdBy.kind === 'system'
               ? input.input.createdBy.id
               : null
           },
           ${
             input.input.createdBy.kind === 'member'
               ? input.input.createdBy.id
               : null
           }::uuid)
      `
      return {
        reportRevisionId,
        revision,
        factsRevision: input.report.factsRevision,
      }
    })
  }
}
