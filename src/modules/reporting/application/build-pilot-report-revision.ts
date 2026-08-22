import type {
  CloseMonthReport,
  CloseMonthReportPersistenceInput,
  CloseMonthReportPort,
} from '@/modules/planning/application/close-month.command'

import { calculatePilotReport } from './calculate-pilot-report.use-case'
import type { PilotReportReadPort } from './pilot-report-read.port'
import { buildPilotReportSeries } from './pilot-series.builder'
import {
  PILOT_REPORT_READ_SCHEMA_VERSION,
  type PilotReportReadModelV1,
} from './pilot-report.types'

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

export class BuildPilotReportRevision implements CloseMonthReportPort {
  public constructor(
    private readonly reports: PilotReportReadPort,
    private readonly revisions: PilotReportRevisionPersistencePort,
  ) {}

  public async build(
    input: Parameters<CloseMonthReportPort['build']>[0],
  ): Promise<Awaited<ReturnType<CloseMonthReportPort['build']>>> {
    const source = await this.reports.load({
      spaceId: input.spaceId,
      publicationId: input.publicationId,
      asOfLocalDate: input.asOfLocalDate,
    })
    if (source === null || source.planMonthId !== input.planMonthId) {
      throw new Error('Pilot report source is unavailable for close')
    }
    const report = calculatePilotReport(
      {
        spaceId: input.spaceId,
        publicationId: input.publicationId,
        asOfLocalDate: input.asOfLocalDate,
      },
      source,
    )
    const payload: PilotReportReadModelV1 = freeze({
      schemaVersion: PILOT_REPORT_READ_SCHEMA_VERSION,
      status: 'closed',
      source: report.source,
      sections: buildPilotReportSeries(source, report, input.asOfLocalDate),
    })
    return Object.freeze({
      planMonthId: report.source.planMonthId,
      publicationId: report.source.publicationId,
      publicationRevision: report.source.publicationRevision,
      factsRevision: report.source.factsRevision,
      formulaVersion: [
        source.formulaVersions.calendar,
        source.formulaVersions.evaluation,
        source.formulaVersions.scoreCoverage,
      ].join('|'),
      payload,
    })
  }

  public async persist(
    input: Parameters<CloseMonthReportPort['persist']>[0],
  ): Promise<Awaited<ReturnType<CloseMonthReportPort['persist']>>> {
    const report = await this.build(input)
    return this.revisions.append({ report, input })
  }
}

export interface PilotReportRevisionPersistencePort {
  append(input: {
    readonly report: CloseMonthReport
    readonly input: CloseMonthReportPersistenceInput
  }): Promise<{
    readonly reportRevisionId: string
    readonly revision: bigint
    readonly factsRevision: bigint
  }>
}
