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
import { RequestValidationError } from '@/platform/http/errors/request-validation.error'
import { COMMAND_FINGERPRINT_CONFLICT_PROBLEM } from '@/platform/http/errors/problem-registry'

import {
  PLANNING_APPLICATION,
  type PlanningApplication,
} from '../application/planning-application'
import { CANONICAL_CALENDAR_MONTH_PATTERN } from '../domain/planning-values'
import {
  GoalDefinitionNotFoundError,
  PlanDraftNotFoundError,
  ActivePlanMonthNotFoundError,
  PlanPublicationNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from '../application/planning-errors'
import {
  GOAL_DEFINITION_NOT_FOUND_PROBLEM,
  GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
  DRAFT_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  ACTIVE_PLAN_MONTH_NOT_FOUND_PROBLEM,
  PLAN_MONTH_ALREADY_PUBLISHED_PROBLEM,
  PLAN_PUBLICATION_BLOCKED_PROBLEM,
  PLAN_PUBLICATION_NOT_FOUND_PROBLEM,
  PUBLICATION_PREVIEW_CONFLICT_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
  PLAN_MONTH_ALREADY_EXISTS_PROBLEM,
  PLAN_SEED_ALREADY_CONSUMED_PROBLEM,
} from './planning-problem.definitions'
import {
  CopyGoalDefinitionRequestDto,
  CreateGoalDefinitionRequestDto,
  CreateGoalDefinitionVersionRequestDto,
  GoalDefinitionDetailResponseDto,
  GoalDefinitionPathDto,
  GoalDefinitionResultResponseDto,
  GoalDefinitionStateRequestDto,
  GoalDefinitionSummaryResponseDto,
  ListGoalDefinitionsQueryDto,
} from './goal-catalog.dto'
import {
  type GoalDefinitionDetailResponse,
  type GoalDefinitionResultResponse,
  type GoalDefinitionSummaryResponse,
  toGoalDefinitionDetailResponse,
  toGoalDefinitionResultResponse,
  toGoalDefinitionSummaryResponse,
} from './goal-catalog.response'
import {
  AddDraftGoalRequestDto,
  CreateDraftFromSeedRequestDto,
  DraftGoalPathDto,
  DraftMonthQueryDto,
  PlanMonthPathDto,
  RemoveDraftGoalRequestDto,
  ReorderDraftGoalsRequestDto,
  type SourceProvenanceDto,
  UpdateDraftGoalRequestDto,
} from './draft-goal.dto'
import {
  toDraftEditorResponse,
  toDraftMutationResponse,
  type DraftEditorResponse,
  type DraftMutationResponse,
} from './draft-goal.response'
import {
  toPublicationPreviewResponse,
  type PublicationPreviewResponse,
} from './publication-preview.response'
import { PublicationPathDto, PublishMonthRequestDto } from './publication.dto'
import {
  toPlanPublicationResultResponse,
  toPublishedSnapshotResponse,
  type PlanPublicationResultResponse,
  type PublishedSnapshotResponse,
} from './publication.response'

const uuidSchema = {
  type: 'string' as const,
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const revisionSchema = {
  type: 'string' as const,
  pattern: '^[1-9][0-9]*$',
}
const addGoalConfigRef = {
  $ref: '#/components/schemas/AddDraftGoalConfigV1',
}
const updateGoalConfigRef = {
  $ref: '#/components/schemas/UpdateDraftGoalConfigV1',
}
const provenanceRef = {
  type: 'object' as const,
  allOf: [{ $ref: '#/components/schemas/SourceProvenanceV1' }],
  nullable: true,
}
const addBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedRevision: revisionSchema,
    goalDefinitionId: uuidSchema,
    config: addGoalConfigRef,
    sourceProvenance: provenanceRef,
  },
  required: [
    'commandId',
    'expectedRevision',
    'goalDefinitionId',
    'config',
    'sourceProvenance',
  ],
}
const updateBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedRevision: revisionSchema,
    goalDefinitionVersionId: uuidSchema,
    config: updateGoalConfigRef,
    sourceProvenance: provenanceRef,
  },
  required: [
    'commandId',
    'expectedRevision',
    'goalDefinitionVersionId',
    'config',
    'sourceProvenance',
  ],
}
const removeBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { commandId: uuidSchema, expectedRevision: revisionSchema },
  required: ['commandId', 'expectedRevision'],
}
const reorderBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedRevision: revisionSchema,
    orderedPlanGoalIds: {
      type: 'array' as const,
      maxItems: 200,
      items: uuidSchema,
    },
  },
  required: ['commandId', 'expectedRevision', 'orderedPlanGoalIds'],
}
const draftMutationResponseSchema = {
  $ref: '#/components/schemas/DraftMutationResponseV1',
}
const createFromSeedBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    targetMonth: {
      type: 'string' as const,
      pattern: CANONICAL_CALENDAR_MONTH_PATTERN,
    },
    actorPersona: {
      type: 'string' as const,
      enum: ['memberA', 'memberB'],
    },
  },
  required: ['commandId', 'targetMonth', 'actorPersona'],
}
const draftEditorResponseSchema = {
  $ref: '#/components/schemas/DraftEditorResponseV1',
}
const publicationPreviewResponseSchema = {
  $ref: '#/components/schemas/PublicationPreviewResponseV1',
}
const publishBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    expectedRevision: revisionSchema,
    previewSchemaVersion: {
      type: 'string' as const,
      pattern: '^[a-z0-9][a-z0-9.-]{0,99}$',
    },
    previewHashVersion: {
      type: 'string' as const,
      pattern: '^[a-z0-9][a-z0-9.-]{0,99}$',
    },
    previewHash: { type: 'string' as const, pattern: '^[0-9a-f]{64}$' },
  },
  required: [
    'commandId',
    'expectedRevision',
    'previewSchemaVersion',
    'previewHashVersion',
    'previewHash',
  ],
}
const metadataProperties = {
  title: {
    type: 'string' as const,
    pattern: '\\S',
    minLength: 1,
    maxLength: 200,
  },
  why: {
    type: 'string' as const,
    pattern: '\\S',
    minLength: 1,
    maxLength: 2_000,
  },
  category: {
    type: 'string' as const,
    pattern: '\\S',
    minLength: 1,
    maxLength: 100,
  },
}
const createBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { commandId: uuidSchema, ...metadataProperties },
  required: ['commandId', 'title', 'why', 'category'],
}
const versionBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    commandId: uuidSchema,
    ...metadataProperties,
    expectedRevision: revisionSchema,
    seriesDecision: { type: 'string' as const, enum: ['continue', 'new'] },
  },
  required: [
    'commandId',
    'title',
    'why',
    'category',
    'expectedRevision',
    'seriesDecision',
  ],
}
const revisionBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { commandId: uuidSchema, expectedRevision: revisionSchema },
  required: ['commandId', 'expectedRevision'],
}

const readProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
  'VALIDATION_FAILED' as const,
  'DEPENDENCY_UNAVAILABLE' as const,
]
const mutationProblems = [
  AUTHENTICATION_REQUIRED_PROBLEM,
  AUTHORIZATION_DENIED_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  'MALFORMED_REQUEST' as const,
  'PAYLOAD_TOO_LARGE' as const,
  'UNSUPPORTED_MEDIA_TYPE' as const,
  'VALIDATION_FAILED' as const,
  'DEPENDENCY_UNAVAILABLE' as const,
]
const draftReadProblems = [
  ...readProblems,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
]
const seedDraftProblems = [
  ...mutationProblems,
  PLAN_MONTH_ALREADY_EXISTS_PROBLEM,
  PLAN_SEED_ALREADY_CONSUMED_PROBLEM,
]
const draftMutationBaseProblems = [
  ...mutationProblems,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
  DRAFT_REVISION_CONFLICT_PROBLEM,
]
const draftAddProblems = [
  ...draftMutationBaseProblems,
  GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
]
const draftUpdateProblems = [
  ...draftMutationBaseProblems,
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
  GOAL_DEFINITION_VERSION_NOT_FOUND_PROBLEM,
]
const draftRemoveProblems = [
  ...draftMutationBaseProblems,
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
]
const draftReorderProblems = [
  ...draftMutationBaseProblems,
  DRAFT_GOAL_NOT_FOUND_PROBLEM,
]
const publicationProblems = [
  ...mutationProblems,
  PLAN_DRAFT_NOT_FOUND_PROBLEM,
  PLAN_DRAFT_NOT_EDITABLE_PROBLEM,
  PUBLICATION_PREVIEW_CONFLICT_PROBLEM,
  PLAN_PUBLICATION_BLOCKED_PROBLEM,
  PLAN_MONTH_ALREADY_PUBLISHED_PROBLEM,
]

@ApiTags('planning')
@ApiSecurity('sessionCookie')
@Controller('planning/catalog/goal-definitions')
export class PlanningController {
  public constructor(
    @Inject(PLANNING_APPLICATION)
    private readonly planning: PlanningApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List active or archived goal definitions.' })
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: ['active', 'archived', 'all'] },
  })
  @ApiOkResponse({ type: [GoalDefinitionSummaryResponseDto] })
  @ApiProblemResponses(...readProblems)
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: ListGoalDefinitionsQueryDto,
  ): Promise<readonly GoalDefinitionSummaryResponse[]> {
    const trustedActor = await this.actor(principal)
    const values = await this.planning.listGoalDefinitions.execute({
      trustedActor,
      ...(query.state === undefined ? {} : { state: query.state }),
    })
    return values.map(toGoalDefinitionSummaryResponse)
  }

  @Get(':goalDefinitionId')
  @ApiOperation({ summary: 'Read one goal definition and its versions.' })
  @ApiParam({ name: 'goalDefinitionId', required: true, schema: uuidSchema })
  @ApiOkResponse({ type: GoalDefinitionDetailResponseDto })
  @ApiProblemResponses(...readProblems, GOAL_DEFINITION_NOT_FOUND_PROBLEM)
  public async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: GoalDefinitionPathDto,
  ): Promise<GoalDefinitionDetailResponse> {
    const trustedActor = await this.actor(principal)
    const value = await this.planning.getGoalDefinition.execute({
      trustedActor,
      goalDefinitionId: path.goalDefinitionId,
    })
    if (value === null) throw new GoalDefinitionNotFoundError()
    return toGoalDefinitionDetailResponse(value)
  }

  @Post()
  @ApiOperation({
    summary: 'Create a metadata-only goal definition.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiCreatedResponse({ type: GoalDefinitionResultResponseDto })
  @ApiBody({ required: true, schema: createBodySchema })
  @ApiProblemResponses(...mutationProblems)
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: CreateGoalDefinitionRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    const result = await this.planning.createGoalDefinition.execute({
      commandId: body.commandId,
      trustedActor: await this.actor(principal),
      payload: { title: body.title, why: body.why, category: body.category },
    })
    return toGoalDefinitionResultResponse(result)
  }

  @Post(':goalDefinitionId/versions')
  @ApiOperation({
    summary: 'Append an immutable metadata version.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'goalDefinitionId', required: true, schema: uuidSchema })
  @ApiCreatedResponse({ type: GoalDefinitionResultResponseDto })
  @ApiBody({ required: true, schema: versionBodySchema })
  @ApiProblemResponses(
    ...mutationProblems,
    GOAL_DEFINITION_NOT_FOUND_PROBLEM,
    GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
    GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  )
  public async version(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: GoalDefinitionPathDto,
    @Body() body: CreateGoalDefinitionVersionRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    const result = await this.planning.createGoalDefinitionVersion.execute({
      commandId: body.commandId,
      trustedActor: await this.actor(principal),
      expectedRevision: BigInt(body.expectedRevision),
      payload: {
        goalDefinitionId: path.goalDefinitionId,
        title: body.title,
        why: body.why,
        category: body.category,
        seriesDecision: body.seriesDecision,
      },
    })
    return toGoalDefinitionResultResponse(result)
  }

  @Post(':goalDefinitionId/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a goal definition without deletion.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'goalDefinitionId', required: true, schema: uuidSchema })
  @ApiOkResponse({ type: GoalDefinitionResultResponseDto })
  @ApiBody({ required: true, schema: revisionBodySchema })
  @ApiProblemResponses(
    ...mutationProblems,
    GOAL_DEFINITION_NOT_FOUND_PROBLEM,
    GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
    GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  )
  public archive(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: GoalDefinitionPathDto,
    @Body() body: GoalDefinitionStateRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    return this.stateChange('archiveGoalDefinition', principal, path, body)
  }

  @Post(':goalDefinitionId/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Restore an archived goal definition.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'goalDefinitionId', required: true, schema: uuidSchema })
  @ApiOkResponse({ type: GoalDefinitionResultResponseDto })
  @ApiBody({ required: true, schema: revisionBodySchema })
  @ApiProblemResponses(
    ...mutationProblems,
    GOAL_DEFINITION_NOT_FOUND_PROBLEM,
    GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
    GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  )
  public restore(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: GoalDefinitionPathDto,
    @Body() body: GoalDefinitionStateRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    return this.stateChange('restoreGoalDefinition', principal, path, body)
  }

  @Post(':goalDefinitionId/copy')
  @ApiOperation({
    summary: 'Copy current metadata into a new definition and series.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiParam({ name: 'goalDefinitionId', required: true, schema: uuidSchema })
  @ApiCreatedResponse({ type: GoalDefinitionResultResponseDto })
  @ApiBody({ required: true, schema: revisionBodySchema })
  @ApiProblemResponses(
    ...mutationProblems,
    GOAL_DEFINITION_NOT_FOUND_PROBLEM,
    GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
  )
  public async copy(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: GoalDefinitionPathDto,
    @Body() body: CopyGoalDefinitionRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    const result = await this.planning.copyGoalDefinition.execute({
      commandId: body.commandId,
      trustedActor: await this.actor(principal),
      expectedRevision: BigInt(body.expectedRevision),
      payload: { sourceGoalDefinitionId: path.goalDefinitionId },
    })
    return toGoalDefinitionResultResponse(result)
  }

  private async stateChange(
    command: 'archiveGoalDefinition' | 'restoreGoalDefinition',
    principal: AuthenticatedPrincipal,
    path: GoalDefinitionPathDto,
    body: GoalDefinitionStateRequestDto,
  ): Promise<GoalDefinitionResultResponse> {
    const result = await this.planning[command].execute({
      commandId: body.commandId,
      trustedActor: await this.actor(principal),
      expectedRevision: BigInt(body.expectedRevision),
      payload: { goalDefinitionId: path.goalDefinitionId },
    })
    return toGoalDefinitionResultResponse(result)
  }

  private async actor(principal: AuthenticatedPrincipal): Promise<{
    readonly kind: 'member'
    readonly id: string
  }> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member' as const, id: member.memberId }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError) {
        throw new PlanningAuthorizationDeniedError()
      }
      if (error instanceof WorkspaceDependencyUnavailableError) {
        throw new PlanningDependencyUnavailableError({ cause: error })
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}

@ApiTags('planning')
@ApiSecurity('sessionCookie')
@Controller('planning/drafts')
export class PlanningDraftController {
  public constructor(
    @Inject(PLANNING_APPLICATION)
    private readonly planning: PlanningApplication,
    @Inject(WORKSPACE_MEMBER_RESOLVER)
    private readonly workspaceMembers: WorkspaceMemberResolver,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the typed monthly draft editor.' })
  @ApiQuery({
    name: 'targetMonth',
    required: true,
    schema: { type: 'string', pattern: CANONICAL_CALENDAR_MONTH_PATTERN },
  })
  @ApiOkResponse({
    description: 'Typed draft editor view.',
    schema: draftEditorResponseSchema,
  })
  @ApiProblemResponses(...draftReadProblems)
  public async editor(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: DraftMonthQueryDto,
  ): Promise<DraftEditorResponse> {
    const value = await this.planning.getDraftEditor.execute({
      trustedActor: await this.actor(principal),
      targetMonth: query.targetMonth,
    })
    if (value === null) throw new PlanDraftNotFoundError()
    return toDraftEditorResponse(value)
  }

  @Get('publication-preview')
  @ApiOperation({ summary: 'Build a revision-bound publication preview.' })
  @ApiQuery({
    name: 'targetMonth',
    required: true,
    schema: { type: 'string', pattern: CANONICAL_CALENDAR_MONTH_PATTERN },
  })
  @ApiOkResponse({
    description: 'Publication preview with blockers as data.',
    schema: publicationPreviewResponseSchema,
  })
  @ApiProblemResponses(...draftReadProblems)
  public async publicationPreview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: DraftMonthQueryDto,
  ): Promise<PublicationPreviewResponse> {
    const value = await this.planning.buildPublicationPreview.execute({
      trustedUserId: principal.userId,
      targetMonth: query.targetMonth,
    })
    if (value === null) throw new PlanDraftNotFoundError()
    return toPublicationPreviewResponse(value)
  }

  @Post('from-seed')
  @ApiOperation({
    summary: 'Create a complete editable draft from the one-time April seed.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiCreatedResponse({
    description: 'Draft aggregate reference at revision one.',
    schema: draftMutationResponseSchema,
  })
  @ApiBody({ required: true, schema: createFromSeedBodySchema })
  @ApiProblemResponses(...seedDraftProblems)
  public async createFromSeed(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: CreateDraftFromSeedRequestDto,
  ): Promise<DraftMutationResponse> {
    return toDraftMutationResponse(
      await this.planning.createDraftFromSeed.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        payload: {
          targetMonth: body.targetMonth,
          actorPersona: body.actorPersona,
        },
      }),
    )
  }

  @Post(':planMonthId/publish')
  @ApiOperation({
    summary: 'Atomically publish the confirmed monthly plan snapshot.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiCreatedResponse({
    description: 'Immutable publication aggregate reference.',
    schema: { $ref: '#/components/schemas/PlanPublicationResultResponseV1' },
  })
  @ApiParam({ name: 'planMonthId', required: true, schema: uuidSchema })
  @ApiBody({ required: true, schema: publishBodySchema })
  @ApiProblemResponses(...publicationProblems)
  public async publish(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: PlanMonthPathDto,
    @Body() body: PublishMonthRequestDto,
  ): Promise<PlanPublicationResultResponse> {
    return toPlanPublicationResultResponse(
      await this.planning.publishMonth.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          planMonthId: path.planMonthId,
          previewSchemaVersion: body.previewSchemaVersion,
          previewHashVersion: body.previewHashVersion,
          previewHash: body.previewHash,
        },
      }),
    )
  }

  @Post(':planMonthId/goals')
  @ApiOperation({
    summary: 'Attach a typed goal to the draft.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiCreatedResponse({
    description: 'Draft aggregate reference.',
    schema: draftMutationResponseSchema,
  })
  @ApiParam({ name: 'planMonthId', required: true, schema: uuidSchema })
  @ApiBody({ required: true, schema: addBodySchema })
  @ApiProblemResponses(...draftAddProblems)
  public async add(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: PlanMonthPathDto,
    @Body() body: AddDraftGoalRequestDto,
  ): Promise<DraftMutationResponse> {
    const sourceProvenance = plainProvenance(body.sourceProvenance)
    return toDraftMutationResponse(
      await this.planning.addDraftGoal.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          planMonthId: path.planMonthId,
          goalDefinitionId: body.goalDefinitionId,
          config: body.config as never,
          sourceProvenance,
        },
      }),
    )
  }

  @Post(':planMonthId/goals/:planGoalId/update')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Append a typed draft-goal revision.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiOkResponse({
    description: 'Draft aggregate reference.',
    schema: draftMutationResponseSchema,
  })
  @ApiParam({ name: 'planMonthId', required: true, schema: uuidSchema })
  @ApiParam({ name: 'planGoalId', required: true, schema: uuidSchema })
  @ApiBody({ required: true, schema: updateBodySchema })
  @ApiProblemResponses(...draftUpdateProblems)
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: DraftGoalPathDto,
    @Body() body: UpdateDraftGoalRequestDto,
  ): Promise<DraftMutationResponse> {
    const sourceProvenance = plainProvenance(body.sourceProvenance)
    return toDraftMutationResponse(
      await this.planning.updateDraftGoal.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          planMonthId: path.planMonthId,
          planGoalId: path.planGoalId,
          goalDefinitionVersionId: body.goalDefinitionVersionId,
          config: body.config as never,
          sourceProvenance,
        },
      }),
    )
  }

  @Post(':planMonthId/goals/:planGoalId/remove')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Detach a goal from the draft.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiOkResponse({
    description: 'Draft aggregate reference.',
    schema: draftMutationResponseSchema,
  })
  @ApiParam({ name: 'planMonthId', required: true, schema: uuidSchema })
  @ApiParam({ name: 'planGoalId', required: true, schema: uuidSchema })
  @ApiBody({ required: true, schema: removeBodySchema })
  @ApiProblemResponses(...draftRemoveProblems)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: DraftGoalPathDto,
    @Body() body: RemoveDraftGoalRequestDto,
  ): Promise<DraftMutationResponse> {
    return toDraftMutationResponse(
      await this.planning.removeDraftGoal.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: { planMonthId: path.planMonthId, planGoalId: path.planGoalId },
      }),
    )
  }

  @Post(':planMonthId/goals/reorder')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Replace the complete active draft-goal order.',
    security: [{ sessionCookie: [], csrfToken: [] }],
  })
  @ApiOkResponse({
    description: 'Draft aggregate reference.',
    schema: draftMutationResponseSchema,
  })
  @ApiParam({ name: 'planMonthId', required: true, schema: uuidSchema })
  @ApiBody({ required: true, schema: reorderBodySchema })
  @ApiProblemResponses(...draftReorderProblems)
  public async reorder(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: PlanMonthPathDto,
    @Body() body: ReorderDraftGoalsRequestDto,
  ): Promise<DraftMutationResponse> {
    return toDraftMutationResponse(
      await this.planning.reorderDraftGoals.execute({
        commandId: body.commandId,
        trustedActor: await this.actor(principal),
        expectedRevision: BigInt(body.expectedRevision),
        payload: {
          planMonthId: path.planMonthId,
          orderedPlanGoalIds: body.orderedPlanGoalIds,
        },
      }),
    )
  }

  private async actor(
    principal: AuthenticatedPrincipal,
  ): Promise<{ readonly kind: 'member'; readonly id: string }> {
    try {
      const member = await this.workspaceMembers.resolveUser(principal.userId)
      return { kind: 'member', id: member.memberId }
    } catch (error: unknown) {
      if (error instanceof WorkspaceMemberNotFoundError)
        throw new PlanningAuthorizationDeniedError()
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}

@ApiTags('planning')
@ApiSecurity('sessionCookie')
@Controller('planning/publications')
export class PlanningPublicationController {
  public constructor(
    @Inject(PLANNING_APPLICATION)
    private readonly planning: PlanningApplication,
  ) {}

  @Get(':publicationId')
  @ApiOperation({ summary: 'Read one immutable published plan snapshot.' })
  @ApiOkResponse({
    schema: { $ref: '#/components/schemas/PublishedSnapshotResponseV1' },
  })
  @ApiParam({ name: 'publicationId', required: true, schema: uuidSchema })
  @ApiProblemResponses(...readProblems, PLAN_PUBLICATION_NOT_FOUND_PROBLEM)
  public async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() path: PublicationPathDto,
  ): Promise<PublishedSnapshotResponse> {
    const value = await this.planning.getPublishedSnapshot.execute({
      trustedUserId: principal.userId,
      publicationId: path.publicationId,
    })
    if (value === null) throw new PlanPublicationNotFoundError()
    return toPublishedSnapshotResponse(value)
  }
}

@ApiTags('planning')
@ApiSecurity('sessionCookie')
@Controller('planning/months')
export class PlanningMonthController {
  public constructor(
    @Inject(PLANNING_APPLICATION)
    private readonly planning: PlanningApplication,
  ) {}

  @Get('active')
  @ApiOperation({ summary: 'Read the active published plan for today.' })
  @ApiOkResponse({
    schema: { $ref: '#/components/schemas/PublishedSnapshotResponseV1' },
  })
  @ApiProblemResponses(...readProblems, ACTIVE_PLAN_MONTH_NOT_FOUND_PROBLEM)
  public async active(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<PublishedSnapshotResponse> {
    const value = await this.planning.getActiveMonth.execute({
      trustedUserId: principal.userId,
    })
    if (value === null) throw new ActivePlanMonthNotFoundError()
    return toPublishedSnapshotResponse(value)
  }
}

function plainProvenance(value: SourceProvenanceDto | null | undefined): {
  readonly schemaVersion: 1
  readonly sourceDocument: string
  readonly sourcePage: number
  readonly rawValue: string | null
  readonly rawDenominator: string | null
  readonly resolution: string
} | null {
  if (value === null) return null
  if (value === undefined) throw missingProvenanceField('/sourceProvenance')
  if (value.rawValue === undefined) {
    throw missingProvenanceField('/sourceProvenance/rawValue')
  }
  if (value.rawDenominator === undefined) {
    throw missingProvenanceField('/sourceProvenance/rawDenominator')
  }
  return {
    schemaVersion: value.schemaVersion,
    sourceDocument: value.sourceDocument,
    sourcePage: value.sourcePage,
    rawValue: value.rawValue,
    rawDenominator: value.rawDenominator,
    resolution: value.resolution,
  }
}

function missingProvenanceField(pointer: string): RequestValidationError {
  return new RequestValidationError([
    {
      pointer,
      code: 'invalid_type',
      detail: 'Field has an invalid type.',
    },
    {
      pointer,
      code: 'required',
      detail: 'Required field is missing.',
    },
  ])
}
