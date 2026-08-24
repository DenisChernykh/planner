import { Controller, Get, Inject } from '@nestjs/common'
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger'

import {
  AUTHENTICATION_REQUIRED_PROBLEM,
  CurrentPrincipal,
  type AuthenticatedPrincipal,
} from '@/modules/auth'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'

import { GetCurrentWorkspaceQuery } from '../application/get-current-workspace.query'
import {
  CurrentWorkspaceAuthorizationDeniedError,
  CurrentWorkspaceDependencyUnavailableError,
  CurrentWorkspaceStateConflictError,
} from '../application/workspace-errors'
import {
  WORKSPACE_AUTHORIZATION_DENIED_PROBLEM,
  WORKSPACE_STATE_CONFLICT_PROBLEM,
} from './workspace-problem.definitions'
import {
  toWorkspaceCurrentResponse,
  type WorkspaceCurrentResponseV1,
} from './workspace-response'

const ref = (name: string): Record<string, unknown> => ({
  $ref: `#/components/schemas/${name}`,
})

@ApiTags('workspace')
@ApiSecurity('sessionCookie')
@Controller('workspace')
export class WorkspaceController {
  public constructor(
    @Inject(GetCurrentWorkspaceQuery)
    private readonly currentWorkspace: GetCurrentWorkspaceQuery,
  ) {}

  @Get('current')
  @ApiOperation({
    summary: 'Read current workspace and member presentation context.',
  })
  @ApiOkResponse({ schema: ref('WorkspaceCurrentResponseV1') })
  @ApiProblemResponses(
    AUTHENTICATION_REQUIRED_PROBLEM,
    WORKSPACE_AUTHORIZATION_DENIED_PROBLEM,
    WORKSPACE_STATE_CONFLICT_PROBLEM,
    'DEPENDENCY_UNAVAILABLE',
  )
  public async current(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceCurrentResponseV1> {
    try {
      return toWorkspaceCurrentResponse(
        await this.currentWorkspace.execute({
          trustedUserId: principal.userId,
        }),
      )
    } catch (error: unknown) {
      if (
        error instanceof CurrentWorkspaceAuthorizationDeniedError ||
        error instanceof CurrentWorkspaceStateConflictError ||
        error instanceof CurrentWorkspaceDependencyUnavailableError
      ) {
        throw error
      }
      throw new CurrentWorkspaceDependencyUnavailableError({ cause: error })
    }
  }
}
