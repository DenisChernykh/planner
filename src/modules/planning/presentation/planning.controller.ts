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

import {
  PLANNING_APPLICATION,
  type PlanningApplication,
} from '../application/planning-application'
import {
  GoalDefinitionNotFoundError,
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from '../application/planning-errors'
import {
  COMMAND_FINGERPRINT_CONFLICT_PROBLEM,
  GOAL_DEFINITION_NOT_FOUND_PROBLEM,
  GOAL_DEFINITION_REVISION_CONFLICT_PROBLEM,
  GOAL_DEFINITION_STATE_CONFLICT_PROBLEM,
  PLANNING_AUTHORIZATION_DENIED_PROBLEM,
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

const uuidSchema = {
  type: 'string' as const,
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const revisionSchema = {
  type: 'string' as const,
  pattern: '^[1-9][0-9]*$',
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
