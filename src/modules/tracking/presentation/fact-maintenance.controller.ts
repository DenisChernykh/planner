import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'

import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
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
import { COMMAND_FINGERPRINT_CONFLICT_PROBLEM } from '@/platform/http/errors/problem-registry'
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
  CloseDayPathDto,
  CloseDayRequestDto,
  type CloseDayPreviewResponseV1,
  CorrectFactRequestDto,
  DeleteFactRequestDto,
  FactRecordPathDto,
  RecordWeeklyTaskResultRequestDto,
  type TrackingDayCloseMutationResponseV1,
  UndoFactRequestDto,
  WeeklyTaskPathDto,
  toCloseDayPreviewResponse,
  toTrackingDayCloseMutationResponse,
} from './fact-maintenance.dto'
import {
  type TrackingFactMutationResponseV1,
  toTrackingFactMutationResponse,
} from './scalar-fact.dto'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_CLOSE_DAY_ALREADY_CLOSED_PROBLEM,
  TRACKING_CLOSE_DAY_PREVIEW_CONFLICT_PROBLEM,
  TRACKING_CLOSE_DAY_REVISION_CONFLICT_PROBLEM,
  TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_CORRECTION_REQUIRED_PROBLEM,
  TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_UNDO_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_VALUE_INVALID_PROBLEM,
  TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED_PROBLEM,
  TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE_PROBLEM,
} from './tracking-problem.definitions'
import { FactHistoryQueryDto } from './fact-history.dto'
import type { FactHistoryPage } from '../application/get-fact-history.query'

const uuid = {
  type: 'string' as const,
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const date = {
  type: 'string' as const,
  format: 'date' as const,
  pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$',
}
const positive = { type: 'string' as const, pattern: '^[1-9][0-9]*$' }
const nonnegative = {
  type: 'string' as const,
  pattern: '^(?:0|[1-9][0-9]*)$',
}
const object = (
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})
const ref = (name: string): Record<string, unknown> => ({
  $ref: `#/components/schemas/${name}`,
})
const correctBody = object(
  {
    commandId: uuid,
    expectedRevision: positive,
    value: {
      oneOf: [
        ref('TrackingBooleanFactValueV1'),
        ref('TrackingQuantityFactValueV1'),
        ref('TrackingTimeFactValueV1'),
        ref('TrackingRatingFactValueV1'),
        ref('TrackingTextFactValueV1'),
        ref('TrackingChecklistFactValueV1'),
        ref('TrackingOrFactValueV1'),
      ],
      discriminator: { propertyName: 'kind' },
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 2_000,
      pattern: '^[\\s\\S]*\\S[\\s\\S]*$',
    },
  },
  ['commandId', 'expectedRevision', 'value', 'reason'],
)
const deleteBody = object(
  {
    commandId: uuid,
    expectedRevision: positive,
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 2_000,
      pattern: '^[\\s\\S]*\\S[\\s\\S]*$',
    },
  },
  ['commandId', 'expectedRevision', 'reason'],
)
const undoBody = object({ commandId: uuid, expectedRevision: positive }, [
  'commandId',
  'expectedRevision',
])
const closeDayBody = object(
  {
    commandId: uuid,
    expectedRevision: nonnegative,
    previewSchemaVersion: {
      type: 'string',
      enum: ['tracking.close-day-preview.v1'],
    },
    previewHashVersion: {
      type: 'string',
      enum: ['tracking.close-day-preview-hash.v1'],
    },
    previewHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
  [
    'commandId',
    'expectedRevision',
    'previewSchemaVersion',
    'previewHashVersion',
    'previewHash',
  ],
)
const weeklyResultBody = object(
  {
    commandId: uuid,
    result: { type: 'string', enum: ['done', 'not_done'] },
  },
  ['commandId', 'result'],
)
const commonProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  'MALFORMED_REQUEST' as const,
  'PAYLOAD_TOO_LARGE' as const,
  'UNSUPPORTED_MEDIA_TYPE' as const,
  'VALIDATION_FAILED' as const,
  'DEPENDENCY_UNAVAILABLE' as const,
]
const commandProblems = [
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  ...commonProblems,
]
const readProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  'VALIDATION_FAILED' as const,
  'DEPENDENCY_UNAVAILABLE' as const,
]

@ApiTags('tracking')
@ApiSecurity('sessionCookie')
@Controller('tracking')
export class FactMaintenanceController {
  public constructor(
    @Inject(TRACKING_APPLICATION)
    private readonly tracking: TrackingApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get('facts/:factRecordId/history')
  @ApiOperation({
    summary: 'Read the bounded immutable fact revision history.',
  })
  @ApiParam({ name: 'factRecordId', schema: uuid })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: positive,
  })
  @ApiOkResponse({ schema: ref('TrackingFactHistoryResponseV1') })
  @ApiProblemResponses(...readProblems, TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM)
  public getHistory(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: FactRecordPathDto,
    @Query() query: FactHistoryQueryDto,
  ): Promise<FactHistoryPage> {
    return this.tracking.getFactHistory.execute({
      trustedUserId: principal.userId,
      factRecordId: path.factRecordId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    })
  }

  @Post('facts/:factRecordId/correct')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Append a corrected typed fact revision.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'factRecordId', schema: uuid })
  @ApiBody({ required: true, schema: correctBody })
  @ApiOkResponse({ schema: ref('TrackingFactMutationResponseV1Dto') })
  @ApiProblemResponses(
    ...commandProblems,
    TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
    TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
    TRACKING_FACT_VALUE_INVALID_PROBLEM,
  )
  public async correct(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: FactRecordPathDto,
    @Body() body: CorrectFactRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.correctRecord.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          factRecordId: path.factRecordId,
          value: body.value,
          reason: body.reason,
        },
      }),
    )
  }

  @Post('facts/:factRecordId/delete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Append a personal fact tombstone.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'factRecordId', schema: uuid })
  @ApiBody({ required: true, schema: deleteBody })
  @ApiOkResponse({ schema: ref('TrackingFactMutationResponseV1Dto') })
  @ApiProblemResponses(
    ...commandProblems,
    TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
    TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  )
  public async delete(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: FactRecordPathDto,
    @Body() body: DeleteFactRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.deleteRecord.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: { factRecordId: path.factRecordId, reason: body.reason },
      }),
    )
  }

  @Post('facts/:factRecordId/undo')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Undo the latest uncompensated own action.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'factRecordId', schema: uuid })
  @ApiBody({ required: true, schema: undoBody })
  @ApiOkResponse({ schema: ref('TrackingFactMutationResponseV1Dto') })
  @ApiProblemResponses(
    ...commandProblems,
    TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
    TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
    TRACKING_FACT_UNDO_UNAVAILABLE_PROBLEM,
  )
  public async undo(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: FactRecordPathDto,
    @Body() body: UndoFactRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.undoLastOwnAction.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: { factRecordId: path.factRecordId },
      }),
    )
  }

  @Get('publications/:publicationId/days/:localDate/close-preview')
  @ApiOperation({ summary: 'Build an actor-relative CloseDay preview.' })
  @ApiParam({ name: 'publicationId', schema: uuid })
  @ApiParam({ name: 'localDate', schema: date })
  @ApiOkResponse({ schema: ref('TrackingCloseDayPreviewResponseV1') })
  @ApiProblemResponses(
    ...readProblems,
    TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM,
  )
  public async closeDayPreview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: CloseDayPathDto,
  ): Promise<CloseDayPreviewResponseV1> {
    return toCloseDayPreviewResponse(
      await this.tracking.previewCloseDay.execute({
        trustedActor: await this.actor(principal),
        publicationId: path.publicationId,
        localDate: path.localDate,
      }),
    )
  }

  @Post('publications/:publicationId/days/:localDate/close')
  @ApiOperation({
    summary: 'Atomically close unresolved fixed expectations for one day.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'publicationId', schema: uuid })
  @ApiParam({ name: 'localDate', schema: date })
  @ApiBody({ required: true, schema: closeDayBody })
  @ApiCreatedResponse({ schema: ref('TrackingDayCloseMutationResponseV1') })
  @ApiProblemResponses(
    ...commandProblems,
    TRACKING_CLOSE_DAY_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_CLOSE_DAY_TARGET_UNAVAILABLE_PROBLEM,
    TRACKING_CLOSE_DAY_REVISION_CONFLICT_PROBLEM,
    TRACKING_CLOSE_DAY_PREVIEW_CONFLICT_PROBLEM,
    TRACKING_CLOSE_DAY_ALREADY_CLOSED_PROBLEM,
  )
  public async closeDay(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: CloseDayPathDto,
    @Body() body: CloseDayRequestDto,
  ): Promise<TrackingDayCloseMutationResponseV1> {
    return toTrackingDayCloseMutationResponse(
      await this.tracking.closeDay.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          publicationId: path.publicationId,
          localDate: path.localDate,
          previewSchemaVersion: body.previewSchemaVersion,
          previewHashVersion: body.previewHashVersion,
          previewHash: body.previewHash,
        },
      }),
    )
  }

  @Post('publications/:publicationId/weekly-tasks/:flexiblePeriodId/result')
  @ApiOperation({
    summary: 'Record the initial result of a weekly planned task.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'publicationId', schema: uuid })
  @ApiParam({ name: 'flexiblePeriodId', schema: uuid })
  @ApiBody({ required: true, schema: weeklyResultBody })
  @ApiCreatedResponse({ schema: ref('TrackingFactMutationResponseV1Dto') })
  @ApiProblemResponses(
    ...commandProblems,
    TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND_PROBLEM,
    TRACKING_WEEKLY_TASK_TARGET_UNAVAILABLE_PROBLEM,
    TRACKING_FACT_CORRECTION_REQUIRED_PROBLEM,
    TRACKING_WEEKLY_TASK_ALREADY_SYSTEM_CLOSED_PROBLEM,
  )
  public async recordWeeklyTaskResult(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: WeeklyTaskPathDto,
    @Body() body: RecordWeeklyTaskResultRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordWeeklyTaskResult.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: path.publicationId,
          flexiblePeriodId: path.flexiblePeriodId,
          result: body.result,
        },
      }),
    )
  }

  private async actor(principal: AuthenticatedPrincipal): Promise<ActorRef> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member', id: member.memberId }
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
