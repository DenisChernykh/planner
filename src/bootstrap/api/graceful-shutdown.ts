import type { ApiRuntime } from './api-runtime'
import type { ObservabilityRuntime } from '@/platform/observability/observability.runtime'

export interface GracefulShutdownResult {
  readonly exitCode: 0 | 1
  readonly forced: boolean
}

export type DeadlineSignalFactory = (milliseconds: number) => AbortSignal

export class GracefulShutdownCoordinator {
  private shutdownPromise: Promise<GracefulShutdownResult> | undefined

  public constructor(
    private readonly runtime: ApiRuntime,
    private readonly deadlineSignal: DeadlineSignalFactory = (milliseconds) =>
      AbortSignal.timeout(Math.max(1, milliseconds)),
    private readonly observability?: ObservabilityRuntime,
  ) {}

  public shutdown(reason: string): Promise<GracefulShutdownResult> {
    void reason
    this.shutdownPromise ??= this.shutdownInternal()
    return this.shutdownPromise
  }

  private async shutdownInternal(): Promise<GracefulShutdownResult> {
    this.runtime.cancelStartup()
    const resources = this.runtime.currentResources
    if (resources === undefined) return { exitCode: 0, forced: false }

    let failed = false
    let forced = false
    await resources.application.closeListener().catch(() => {
      failed = true
    })
    resources.application.closeIdleConnections()
    const idle = await resources.requestTracker.waitForIdle(
      this.deadlineSignal(resources.httpDrainTimeoutMs),
    )
    if (!idle) {
      forced = true
      failed = true
      resources.application.closeAllConnections()
    }
    const cleanupBudget = Math.max(
      1,
      resources.shutdownGraceMs - resources.httpDrainTimeoutMs,
    )
    const cleanupSignal = this.deadlineSignal(cleanupBudget)
    const dependencyCleanup = await Promise.allSettled([
      resources.database.close(cleanupSignal),
      resources.redis.close(cleanupSignal),
    ])
    if (dependencyCleanup.some((result) => result.status === 'rejected')) {
      failed = true
    }
    await this.observability?.close(cleanupSignal).catch(() => undefined)
    await resources.application.close().catch(() => {
      failed = true
    })
    return { exitCode: failed ? 1 : 0, forced }
  }
}
