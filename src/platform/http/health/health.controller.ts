import { Controller, Get, Req, Res } from '@nestjs/common'
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'

import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import { PublicEndpoint } from '@/platform/http/policy/public-endpoint.decorator'

import { HealthService } from './health.service'
import type {
  HealthHttpResult,
  LivenessSnapshot,
  ReadinessSnapshot,
  StartupSnapshot,
} from './health.types'

@Controller('health')
@ApiTags('health')
@PublicEndpoint()
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({
    operationId: 'healthLive',
    summary: 'Check process liveness',
    security: [],
  })
  @ApiOkResponse({
    description: 'The HTTP process is alive.',
    schema: healthStatusSchema(['ok']),
  })
  @ApiProblemResponses('INTERNAL_ERROR')
  public live(
    @Res({ passthrough: true }) response: Response,
  ): LivenessSnapshot {
    return this.write(response, this.health.live())
  }

  @Get('startup')
  @ApiOperation({
    operationId: 'healthStartup',
    summary: 'Check the irreversible startup latch',
    security: [],
  })
  @ApiOkResponse({
    description: 'Startup completed successfully.',
    schema: healthStatusSchema(['ok']),
  })
  @ApiResponse({
    status: 503,
    description: 'Startup is incomplete.',
    schema: healthStatusSchema(['starting']),
  })
  @ApiProblemResponses('INTERNAL_ERROR')
  public startup(
    @Res({ passthrough: true }) response: Response,
  ): StartupSnapshot {
    return this.write(response, this.health.startup())
  }

  @Get('ready')
  @ApiOperation({
    operationId: 'healthReady',
    summary: 'Check bounded dependency readiness',
    security: [],
  })
  @ApiOkResponse({
    description: 'All required dependencies are available.',
    schema: healthStatusSchema(['ok']),
  })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable.',
    schema: healthStatusSchema(['unavailable']),
  })
  @ApiProblemResponses('INTERNAL_ERROR')
  public async ready(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessSnapshot> {
    const parent = new AbortController()
    const abort = (): void => parent.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      return this.write(response, await this.health.ready(parent.signal))
    } finally {
      request.off('aborted', abort)
      response.off('close', abort)
    }
  }

  private write<T>(response: Response, result: HealthHttpResult<T>): T {
    response.status(result.statusCode)
    return result.body
  }
}

function healthStatusSchema(values: readonly string[]): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', enum: [...values] } },
  }
}
