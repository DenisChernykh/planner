import { PrismaFactPersistence } from '@/modules/tracking'
import type { PrismaClientProvider } from '@/platform/database/prisma-client.provider'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'

import { CalculatePilotReportUseCase } from '../application/calculate-pilot-report.use-case'
import type { ReportingApplication } from '../application/reporting-application'
import { PrismaPilotReportReadRepository } from '../infrastructure/prisma-pilot-report-read.repository'

export function createReportingApplication(dependencies: {
  readonly database: PrismaClientProvider
  readonly transaction: DatabaseTransactionPort
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
  })
}
