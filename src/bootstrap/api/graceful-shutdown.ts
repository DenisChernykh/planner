import type { ApiRuntime } from './api-runtime'

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
    await resources.database
      .close(this.deadlineSignal(cleanupBudget))
      .catch(() => {
        failed = true
      })
    await resources.application.close().catch(() => {
      failed = true
    })
    return { exitCode: failed ? 1 : 0, forced }
  }
}
