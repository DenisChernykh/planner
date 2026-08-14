import { runWorkerApplication } from '@/bootstrap/planner-worker/run-worker-application'
import { runPlannerWorker } from '@/bootstrap/planner-worker/run-planner-worker'
import { PlannerWorkerStartupCleanupError } from '@/bootstrap/planner-worker/configure-planner-worker'
import { buildPlannerWorkerRuntimeConfig } from '@/platform/config/planner-worker-runtime-config'
import { PeriodicMaintenanceRunner } from '@/platform/maintenance/periodic-maintenance-runner'
import { RuntimeConfigurationError } from '@/platform/config/runtime-config.types'
import type { ObservabilityRuntime } from '@/platform/observability/observability.runtime'

describe('T10 planner-worker lifecycle', () => {
  afterEach(() => jest.useRealTimers())

  it('defaults to a 30 second interval and enforces the 15-60 second range', () => {
    const base = { DATABASE_URL: 'postgresql://planner:test@db/planner' }
    expect(buildPlannerWorkerRuntimeConfig(base).intervalMs).toBe(30_000)
    expect(
      buildPlannerWorkerRuntimeConfig({
        ...base,
        PLANNER_WORKER_INTERVAL_MS: 15_000,
      }).intervalMs,
    ).toBe(15_000)
    expect(() =>
      buildPlannerWorkerRuntimeConfig({
        ...base,
        PLANNER_WORKER_INTERVAL_MS: 60_001,
      }),
    ).toThrow(RuntimeConfigurationError)
  })

  it('never overlaps cycles and aborts an idle delay', async () => {
    jest.useFakeTimers()
    const events: string[] = []
    let release: (() => void) | undefined
    const runner = new PeriodicMaintenanceRunner(
      () =>
        new Promise<void>((resolve) => {
          events.push('start')
          release = () => {
            events.push('finish')
            resolve()
          }
        }),
      { delayMs: 30_000, shutdownGraceMs: 5_000 },
    )
    const controller = new AbortController()
    const running = runner.run(controller.signal)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual(['start'])
    release?.()
    await Promise.resolve()
    controller.abort()
    await expect(running).resolves.toBeUndefined()
    expect(events).toEqual(['start', 'finish'])
  })

  it('preserves a cycle failure so the process can restart', async () => {
    const error = new Error('due scan failed')
    const runner = new PeriodicMaintenanceRunner(() => Promise.reject(error), {
      delayMs: 30_000,
      shutdownGraceMs: 5_000,
    })
    await expect(runner.run(new AbortController().signal)).rejects.toBe(error)

    const controllers = [new AbortController(), new AbortController()]
    const scans = jest.fn((signal: AbortSignal) => {
      controllers.find((controller) => controller.signal === signal)?.abort()
      return Promise.resolve()
    })
    for (const controller of controllers) {
      await new PeriodicMaintenanceRunner(scans, {
        delayMs: 30_000,
        shutdownGraceMs: 5_000,
      }).run(controller.signal)
    }
    expect(scans).toHaveBeenCalledTimes(2)
  })

  it('announces readiness once and latches bounded close', async () => {
    const events: string[] = []
    const close = jest.fn(() => {
      events.push('close')
      return Promise.resolve()
    })
    await runWorkerApplication({
      application: { close },
      shutdownGraceMs: 100,
      onStarted: () => events.push('ready'),
      forceExit: jest.fn(),
      waitForTermination: async (closeOnce) => {
        events.push('wait')
        const first = closeOnce()
        expect(closeOnce()).toBe(first)
        await first
      },
    })
    expect(events).toEqual(['ready', 'wait', 'close'])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('forces a non-zero exit when the outer shutdown deadline expires', async () => {
    jest.useFakeTimers()
    const forceExit = jest.fn()
    const running = runWorkerApplication({
      application: { close: () => new Promise<void>(() => undefined) },
      shutdownGraceMs: 100,
      onStarted: jest.fn(),
      forceExit,
      waitForTermination: (closeOnce) => closeOnce(),
    })
    const rejected = expect(running).rejects.toThrow(
      'Worker application close exceeded shutdown grace',
    )
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(99)
    expect(forceExit).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await rejected
    expect(forceExit).toHaveBeenCalledWith(1)
  })

  it('admits termination before a blocked initial scan and skips readiness', async () => {
    const config = buildPlannerWorkerRuntimeConfig({
      DATABASE_URL: 'postgresql://planner:test@db/planner',
    })
    const databaseClosed = jest.fn()
    const observabilityClosed = jest.fn(() => Promise.resolve())
    const observability = {
      close: observabilityClosed,
    } as unknown as ObservabilityRuntime
    let scanStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      scanStarted = resolve
    })
    let acceptTermination: (() => Promise<void>) | undefined
    const onReady = jest.fn()
    const running = runPlannerWorker(config, {
      startObservability: () => observability,
      configure: (_config, _observability, signal): Promise<never> => {
        scanStarted?.()
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            databaseClosed()
            void observability.close(AbortSignal.timeout(100))
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('startup aborted'),
            )
          }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      },
      onReady,
      forceExit: jest.fn(),
      waitForTermination: (close, stopListening) =>
        new Promise<void>((resolve, reject) => {
          acceptTermination = () => close().then(resolve, reject)
          stopListening?.addEventListener('abort', () => resolve(), {
            once: true,
          })
        }),
    })
    await started
    await acceptTermination?.()
    await expect(running).resolves.toBeUndefined()
    expect(databaseClosed).toHaveBeenCalledTimes(1)
    expect(observabilityClosed).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('forces exit when startup cleanup exceeds the hard deadline', async () => {
    jest.useFakeTimers()
    const config = buildPlannerWorkerRuntimeConfig({
      DATABASE_URL: 'postgresql://planner:test@db/planner',
    })
    const observability = {
      close: () => Promise.resolve(),
    } as unknown as ObservabilityRuntime
    let scanStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      scanStarted = resolve
    })
    let failCleanup: ((error: Error) => void) | undefined
    let acceptTermination: (() => Promise<void>) | undefined
    const forceExit = jest.fn()
    const onReady = jest.fn()
    const running = runPlannerWorker(config, {
      startObservability: () => observability,
      configure: (): Promise<never> => {
        scanStarted?.()
        return new Promise<never>((_resolve, reject) => {
          failCleanup = reject
        })
      },
      onReady,
      forceExit,
      waitForTermination: (close, stopListening) =>
        new Promise<void>((resolve, reject) => {
          acceptTermination = () => close().then(resolve, reject)
          stopListening?.addEventListener('abort', () => resolve(), {
            once: true,
          })
        }),
    })
    await started
    await acceptTermination?.()
    await jest.advanceTimersByTimeAsync(config.shutdownGraceMs - 1)
    expect(forceExit).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(forceExit).toHaveBeenCalledWith(1)

    const cleanupError = new PlannerWorkerStartupCleanupError(
      new Error('initial scan aborted'),
      [new Error('database close deadline')],
    )
    const rejected = expect(running).rejects.toBe(cleanupError)
    failCleanup?.(cleanupError)
    await rejected
    expect(forceExit).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })
})
