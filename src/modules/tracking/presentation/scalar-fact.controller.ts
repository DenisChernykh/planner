import { Body, Controller, Inject, Post } from '@nestjs/common'
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
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
  RecordCheckpointRequestDto,
  RecordFactRequestDto,
  RecordRatingRequestDto,
  RecordTimeRequestDto,
  TrackingFactMutationResponseV1Dto,
  type TrackingFactMutationResponseV1,
  toTrackingFactMutationResponse,
} from './scalar-fact.dto'
import {
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_VALUE_INVALID_PROBLEM,
} from './tracking-problem.definitions'

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
const commonProperties = {
  commandId: uuid,
  publicationId: uuid,
  planGoalSnapshotId: uuid,
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
const factBody = object(
  {
    ...commonProperties,
    expectedRevision: positive,
    localDate: date,
    value: {
      oneOf: [
        ref('TrackingBooleanFactValueV1'),
        ref('TrackingQuantityFactValueV1'),
      ],
      discriminator: { propertyName: 'kind' },
    },
  },
  ['commandId', 'publicationId', 'planGoalSnapshotId', 'localDate', 'value'],
)
const timeBody = object(
  {
    ...commonProperties,
    expectationDate: date,
    value: {
      type: 'string',
      pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
    },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'value',
  ],
)
const ratingBody = object(
  {
    ...commonProperties,
    expectationDate: date,
    value: {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'value',
  ],
)
const checkpointBody = object(
  {
    ...commonProperties,
    expectationDate: date,
    checkpointId: uuid,
    value: {
      oneOf: [
        ref('TrackingBooleanFactValueV1'),
        ref('TrackingTimeFactValueV1'),
        ref('TrackingRatingFactValueV1'),
      ],
      discriminator: { propertyName: 'kind' },
    },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'value',
  ],
)
const mutationProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  TRACKING_AUTHORIZATION_DENIED_PROBLEM,
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  TRACKING_FACT_TARGET_NOT_FOUND_PROBLEM,
  TRACKING_FACT_TARGET_UNAVAILABLE_PROBLEM,
  TRACKING_FACT_REVISION_CONFLICT_PROBLEM,
  TRACKING_FACT_VALUE_INVALID_PROBLEM,
  'MALFORMED_REQUEST' as const,
  'PAYLOAD_TOO_LARGE' as const,
  'UNSUPPORTED_MEDIA_TYPE' as const,
  'VALIDATION_FAILED' as const,
  'DEPENDENCY_UNAVAILABLE' as const,
]

@ApiTags('tracking')
@ApiSecurity('sessionCookie')
@Controller('tracking/facts')
export class ScalarFactController {
  public constructor(
    @Inject(TRACKING_APPLICATION)
    private readonly tracking: TrackingApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Record a Boolean or quantity fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: factBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordFact(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordFactRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    const result = await this.tracking.recordFact.execute({
      commandId: body.commandId,
      trustedActor: await this.actor(principal),
      ...(body.expectedRevision === undefined
        ? {}
        : { expectedRevision: BigInt(body.expectedRevision) }),
      payload: {
        publicationId: body.publicationId,
        planGoalSnapshotId: body.planGoalSnapshotId,
        localDate: body.localDate,
        value: body.value,
      },
    })
    return toTrackingFactMutationResponse(result)
  }

  @Post('time')
  @ApiOperation({
    summary: 'Record an actual-time fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: timeBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordTime(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordTimeRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordTime.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          value: body.value,
        },
      }),
    )
  }

  @Post('rating')
  @ApiOperation({
    summary: 'Record a rating fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: ratingBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordRating(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordRatingRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordRating.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          value: body.value,
        },
      }),
    )
  }

  @Post('checkpoint')
  @ApiOperation({
    summary: 'Record a scalar checkpoint fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: checkpointBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordCheckpoint(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordCheckpointRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordCheckpoint.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          checkpointId: body.checkpointId,
          value: body.value,
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
