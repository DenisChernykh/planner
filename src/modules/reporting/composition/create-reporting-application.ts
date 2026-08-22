import { PrismaFactPersistence } from '@/modules/tracking'
import type { WorkspaceMemberResolver } from '@/modules/workspace'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import type { ProductClock } from '@/shared/application/product-clock'

import { BuildPilotReportQuery } from '../application/build-pilot-report.query'
import { CalculatePilotReportUseCase } from '../application/calculate-pilot-report.use-case'
import type { ReportingApplication } from '../application/reporting-application'
import { PrismaPilotReportReadRepository } from '../infrastructure/prisma-pilot-report-read.repository'

export function createReportingApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
  readonly workspaceMembers: WorkspaceMemberResolver
  readonly clock: ProductClock
}): ReportingApplication {
  const progressInputs = new PrismaFactPersistence(dependencies.database)
  const reports = new PrismaPilotReportReadRepository(
    dependencies.database,
    progressInputs,
  )
  return Object.freeze({
    calculatePilotReport: new CalculatePilotReportUseCase(
      reports,
      dependencies.transaction,
    ),
    buildPilotReport: new BuildPilotReportQuery(
      dependencies.workspaceMembers,
      reports,
      dependencies.transaction,
      dependencies.clock,
    ),
  })
}
