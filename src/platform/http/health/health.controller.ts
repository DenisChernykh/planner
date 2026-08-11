import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'

import { HealthService } from './health.service'
import type {
  HealthHttpResult,
  LivenessSnapshot,
  ReadinessSnapshot,
  StartupSnapshot,
} from './health.types'

@Controller('health')
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get('live')
  public live(
    @Res({ passthrough: true }) response: Response,
  ): LivenessSnapshot {
    return this.write(response, this.health.live())
  }

  @Get('startup')
  public startup(
    @Res({ passthrough: true }) response: Response,
  ): StartupSnapshot {
    return this.write(response, this.health.startup())
  }

  @Get('ready')
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
