import { Injectable } from '@nestjs/common'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

@Injectable()
export class ActiveRequestTracker {
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  public middleware(): RequestHandler {
    return (request: Request, response: Response, next: NextFunction): void => {
      if (
        request.path === '/health/live' ||
        request.path === '/health/startup'
      ) {
        next()
        return
      }
      this.active += 1
      let completed = false
      const complete = (): void => {
        if (completed) return
        completed = true
        response.off('finish', complete)
        response.off('close', complete)
        this.active -= 1
        if (this.active === 0) {
          for (const resolve of this.idleWaiters) resolve()
          this.idleWaiters.clear()
        }
      }
      response.once('finish', complete)
      response.once('close', complete)
      next()
    }
  }

  public waitForIdle(signal: AbortSignal): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true)
    if (signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const idle = (): void => {
        signal.removeEventListener('abort', aborted)
        resolve(true)
      }
      const aborted = (): void => {
        this.idleWaiters.delete(idle)
        resolve(false)
      }
      this.idleWaiters.add(idle)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }
}
