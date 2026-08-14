export type PeriodicMaintenanceTask = (signal: AbortSignal) => Promise<void>

export type PeriodicMaintenanceEvent =
  | { readonly type: 'cycle_started' }
  | { readonly type: 'cycle_succeeded'; readonly durationMs: number }
  | {
      readonly type: 'cycle_failed'
      readonly durationMs: number
      readonly error: unknown
    }
  | { readonly type: 'shutdown_grace_exceeded'; readonly graceMs: number }

export type PeriodicMaintenanceObserver = (
  event: PeriodicMaintenanceEvent,
) => void

export interface PeriodicMaintenanceOptions {
  readonly delayMs: number
  readonly shutdownGraceMs: number
  readonly runOnStart?: boolean
  readonly observer?: PeriodicMaintenanceObserver
}

const maximumTimerDelayMs = 2_147_483_647

type CycleSettlement =
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: unknown }

type CycleRaceResult = CycleSettlement | { readonly type: 'aborted' }

export class PeriodicMaintenanceRunner {
  private started = false
  private readonly delayMs: number
  private readonly observer: PeriodicMaintenanceObserver | undefined
  private readonly runOnStart: boolean
  private readonly shutdownGraceMs: number

  public constructor(
    private readonly task: PeriodicMaintenanceTask,
    options: PeriodicMaintenanceOptions,
  ) {
    assertTimerDelay('delayMs', options.delayMs, 1)
    assertTimerDelay('shutdownGraceMs', options.shutdownGraceMs, 0)
    this.delayMs = options.delayMs
    this.observer = options.observer
    this.runOnStart = options.runOnStart ?? true
    this.shutdownGraceMs = options.shutdownGraceMs
  }

  public run(signal: AbortSignal): Promise<void> {
    if (this.started) {
      return Promise.reject(
        new Error('Periodic maintenance runner has already started'),
      )
    }
    this.started = true
    return this.runLoop(signal)
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    if (!this.runOnStart && !(await this.waitForDelay(signal))) return
    while (!signal.aborted) {
      const startedAt = performance.now()
      this.emit({ type: 'cycle_started' })
      const cycle = Promise.resolve().then(() => this.task(signal))
      const result = await this.waitForCycleOrAbort(cycle, signal)
      if (result.type === 'failed') {
        this.emit({
          type: 'cycle_failed',
          durationMs: elapsedMilliseconds(startedAt),
          error: result.error,
        })
        throw result.error
      }
      if (result.type === 'aborted') {
        const settlement = await this.waitForCycleWithinGrace(cycle)
        if (settlement === undefined) {
          this.emit({
            type: 'shutdown_grace_exceeded',
            graceMs: this.shutdownGraceMs,
          })
        } else if (settlement.type === 'succeeded') {
          this.emit({
            type: 'cycle_succeeded',
            durationMs: elapsedMilliseconds(startedAt),
          })
        } else {
          this.emit({
            type: 'cycle_failed',
            durationMs: elapsedMilliseconds(startedAt),
            error: settlement.error,
          })
        }
        return
      }
      this.emit({
        type: 'cycle_succeeded',
        durationMs: elapsedMilliseconds(startedAt),
      })
      if (!(await this.waitForDelay(signal))) return
    }
  }

  private async waitForCycleWithinGrace(
    cycle: Promise<void>,
  ): Promise<CycleSettlement | undefined> {
    let cancelTimer: (() => void) | undefined
    const settlement = await Promise.race([
      cycle.then(
        (): CycleSettlement => ({ type: 'succeeded' }),
        (error: unknown): CycleSettlement => ({ type: 'failed', error }),
      ),
      new Promise<undefined>((resolve) => {
        cancelTimer = startBoundedTimer(this.shutdownGraceMs, () =>
          resolve(undefined),
        )
      }),
    ]).finally(() => cancelTimer?.())
    if (settlement === undefined) void cycle.catch(() => undefined)
    return settlement
  }

  private waitForCycleOrAbort(
    cycle: Promise<void>,
    signal: AbortSignal,
  ): Promise<CycleRaceResult> {
    if (signal.aborted) return Promise.resolve({ type: 'aborted' })
    return new Promise<CycleRaceResult>((resolve) => {
      const onAbort = (): void => done({ type: 'aborted' })
      const done = (result: CycleRaceResult): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void cycle.then(
        () => done({ type: 'succeeded' }),
        (error: unknown) => done({ type: 'failed', error }),
      )
    })
  }

  private waitForDelay(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let cancelTimer = (): void => undefined
      const onAbort = (): void => done(false)
      const done = (completed: boolean): void => {
        cancelTimer()
        signal.removeEventListener('abort', onAbort)
        resolve(completed)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      cancelTimer = startBoundedTimer(this.delayMs, () => done(true))
    })
  }

  private emit(event: PeriodicMaintenanceEvent): void {
    if (this.observer === undefined) return
    try {
      const result: unknown = this.observer(event)
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Telemetry must not change the task or shutdown outcome.
    }
  }
}

function assertTimerDelay(
  name: 'delayMs' | 'shutdownGraceMs',
  value: number,
  minimum: number,
): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} is outside the supported timer range`)
  }
}

function startBoundedTimer(
  durationMs: number,
  onElapsed: () => void,
): () => void {
  let remainingMs = durationMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleNextChunk = (): void => {
    const chunkMs = Math.min(remainingMs, maximumTimerDelayMs)
    timer = setTimeout(() => {
      remainingMs -= chunkMs
      if (remainingMs <= 0) onElapsed()
      else scheduleNextChunk()
    }, chunkMs)
  }
  scheduleNextChunk()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function elapsedMilliseconds(startedAt: number): number {
  const elapsed = performance.now() - startedAt
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
}
