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
  TRACKING_APPLICATION,
  type TrackingApplication,
} from '../application/tracking-application'
import {
  TrackingAuthorizationDeniedError,
  TrackingDependencyUnavailableError,
} from '../application/tracking-errors'
import {
  CANONICAL_TRACKING_MONTH_PATTERN,
  canonicalTrackingMonthPath,
} from './tracking-query.dto'
import {
  type TrackingMonthResponseV1,
  type TrackingTodayResponseV1,
  toTrackingMonthResponse,
  toTrackingTodayResponse,
} from './tracking-query.response'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_QUERY_INVALID_PROBLEM,
} from './tracking-problem.definitions'

const readProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  'DEPENDENCY_UNAVAILABLE' as const,
]

@ApiTags('tracking')
@ApiSecurity('sessionCookie')
@Controller('tracking')
export class TrackingQueryController {
  public constructor(
    @Inject(TRACKING_APPLICATION)
    private readonly tracking: TrackingApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get('today')
  @ApiOperation({
    summary: 'Read the channel-neutral tracking state for today.',
  })
  @ApiOkResponse({
    schema: { $ref: '#/components/schemas/TrackingTodayResponseV1' },
  })
  @ApiProblemResponses(...readProblems)
  public async today(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<TrackingTodayResponseV1> {
    const trustedActor = await this.actor(principal)
    return toTrackingTodayResponse(
      await this.tracking.getToday.execute({ trustedActor }),
    )
  }

  @Get('months/:targetMonth')
  @ApiOperation({ summary: 'Read a complete channel-neutral tracking month.' })
  @ApiParam({
    name: 'targetMonth',
    required: true,
    schema: { type: 'string', pattern: CANONICAL_TRACKING_MONTH_PATTERN },
  })
  @ApiOkResponse({
    schema: { $ref: '#/components/schemas/TrackingMonthResponseV1' },
  })
  @ApiProblemResponses(...readProblems, TRACKING_QUERY_INVALID_PROBLEM)
  public async month(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('targetMonth') targetMonth: string,
  ): Promise<TrackingMonthResponseV1> {
    const canonicalMonth = canonicalTrackingMonthPath(targetMonth)
    const trustedActor = await this.actor(principal)
    return toTrackingMonthResponse(
      await this.tracking.getMonth.execute({
        trustedActor,
        targetMonth: canonicalMonth,
      }),
    )
  }

  private async actor(principal: AuthenticatedPrincipal): Promise<ActorRef> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member' as const, id: member.memberId }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new TrackingAuthorizationDeniedError()
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new TrackingDependencyUnavailableError({ cause: error })
      }
      throw new TrackingDependencyUnavailableError({ cause: error })
    }
  }
}
