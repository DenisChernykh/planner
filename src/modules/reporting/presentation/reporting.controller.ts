import { Controller, Get, Inject, Param } from '@nestjs/common'
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'

import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  CurrentPrincipal,
  type AuthenticatedPrincipal,
} from '@/modules/auth'
import {
  WORKSPACE_MEMBER_RESOLVER,
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
  type WorkspaceMemberResolver,
} from '@/modules/workspace'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import type { ActorRef } from '@/shared/application/application-command'

import {
  REPORTING_APPLICATION,
  type ReportingApplication,
} from '../application/reporting-application'
import {
  PilotReportAuthorizationDeniedError,
  PilotReportDependencyUnavailableError,
} from '../application/pilot-report.errors'
import {
  CANONICAL_REPORT_MONTH_PATTERN,
  canonicalReportMonthPath,
} from './reporting-query.dto'
import {
  toPilotReportReadResponse,
  type PilotReportReadResponseV1,
} from './reporting-query.response'
import {
  REPORTING_AUTHORIZATION_DENIED_PROBLEM,
  REPORTING_NOT_FOUND_PROBLEM,
  REPORTING_QUERY_INVALID_PROBLEM,
  REPORTING_SOURCE_CHANGED_PROBLEM,
} from './reporting-problem.definitions'

const readProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  REPORTING_AUTHORIZATION_DENIED_PROBLEM,
  REPORTING_NOT_FOUND_PROBLEM,
  REPORTING_SOURCE_CHANGED_PROBLEM,
  'DEPENDENCY_UNAVAILABLE' as const,
]

@ApiTags('reporting')
@ApiSecurity('sessionCookie')
@Controller('reporting')
export class ReportingController {
  public constructor(
    @Inject(REPORTING_APPLICATION)
    private readonly reporting: ReportingApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get('months/:targetMonth')
  @ApiOperation({ summary: 'Read the pilot report for a month.' })
  @ApiParam({
    name: 'targetMonth',
    required: true,
    schema: { type: 'string', pattern: CANONICAL_REPORT_MONTH_PATTERN },
  })
  @ApiOkResponse({
    schema: { $ref: '#/components/schemas/PilotReportReadResponseV1' },
  })
  @ApiProblemResponses(...readProblems, REPORTING_QUERY_INVALID_PROBLEM)
  public async month(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('targetMonth') targetMonth: string,
  ): Promise<PilotReportReadResponseV1> {
    return toPilotReportReadResponse(
      await this.reporting.buildPilotReport.execute({
        trustedActor: await this.actor(principal),
        targetMonth: canonicalReportMonthPath(targetMonth),
      }),
    )
  }

  private async actor(principal: AuthenticatedPrincipal): Promise<ActorRef> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member', id: member.memberId }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new PilotReportAuthorizationDeniedError()
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new PilotReportDependencyUnavailableError({ cause: error })
      }
      throw new PilotReportDependencyUnavailableError({ cause: error })
    }
  }
}
