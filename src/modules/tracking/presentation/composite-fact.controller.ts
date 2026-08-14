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
  RecordChecklistItemRequestDto,
  RecordCompositeOccurrenceRequestDto,
  RecordOrVariantRequestDto,
  RecordTextRequestDto,
} from './composite-fact.dto'
import {
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
const decimal = {
  type: 'string' as const,
  pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$',
}
const nullableUuid = { ...uuid, nullable: true }
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
const fixedProperties = {
  ...commonProperties,
  expectationDate: date,
  checkpointId: nullableUuid,
}
const textBody = object(
  {
    ...fixedProperties,
    text: { type: 'string', minLength: 1 },
    result: { type: 'string', enum: ['done', 'not_done'] },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'text',
    'result',
  ],
)
const checklistItemBody = object(
  {
    ...fixedProperties,
    checklistItemId: uuid,
    state: { type: 'string', enum: ['done', 'not_done'] },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'checklistItemId',
    'state',
  ],
)
const orVariantBody = object(
  {
    ...fixedProperties,
    variantId: uuid,
    value: decimal,
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'expectationDate',
    'checkpointId',
    'variantId',
    'value',
  ],
)
const compositeOccurrenceBody = object(
  {
    ...commonProperties,
    localDate: date,
    component: {
      oneOf: [
        ref('TrackingChecklistOccurrenceComponentV1'),
        ref('TrackingOrOccurrenceComponentV1'),
      ],
      discriminator: { propertyName: 'kind' },
    },
  },
  [
    'commandId',
    'publicationId',
    'planGoalSnapshotId',
    'localDate',
    'component',
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
export class CompositeFactController {
  public constructor(
    @Inject(TRACKING_APPLICATION)
    private readonly tracking: TrackingApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Post('text')
  @ApiOperation({
    summary: 'Record a fixed text fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: textBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordText(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordTextRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordText.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          checkpointId: body.checkpointId,
          text: body.text,
          result: body.result,
        },
      }),
    )
  }

  @Post('checklist-item')
  @ApiOperation({
    summary: 'Record a fixed checklist-item fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: checklistItemBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordChecklistItem(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordChecklistItemRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordChecklistItem.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          checkpointId: body.checkpointId,
          checklistItemId: body.checklistItemId,
          state: body.state,
        },
      }),
    )
  }

  @Post('or-variant')
  @ApiOperation({
    summary: 'Record a fixed OR-variant fact.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: orVariantBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordOrVariant(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordOrVariantRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordOrVariant.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          expectationDate: body.expectationDate,
          checkpointId: body.checkpointId,
          variantId: body.variantId,
          value: body.value,
        },
      }),
    )
  }

  @Post('composite-occurrence')
  @ApiOperation({
    summary: 'Record a flexible checklist or OR occurrence.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiBody({ required: true, schema: compositeOccurrenceBody })
  @ApiCreatedResponse({ type: TrackingFactMutationResponseV1Dto })
  @ApiProblemResponses(...mutationProblems)
  public async recordCompositeOccurrence(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: RecordCompositeOccurrenceRequestDto,
  ): Promise<TrackingFactMutationResponseV1> {
    return toTrackingFactMutationResponse(
      await this.tracking.recordCompositeOccurrence.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          publicationId: body.publicationId,
          planGoalSnapshotId: body.planGoalSnapshotId,
          localDate: body.localDate,
          component: body.component,
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
