import { startObservability } from '@/bootstrap/observability/start-observability'
import type { PlannerWorkerRuntimeConfig } from '@/platform/config/planner-worker-runtime-config'

import {
  PlannerWorkerStartupCleanupError,
  configurePlannerWorker,
} from './configure-planner-worker'
import {
  runWorkerApplication,
  waitForWorkerTermination,
} from './run-worker-application'

export interface PlannerWorkerBootstrapDependencies {
  readonly startObservability: typeof startObservability
  readonly configure: typeof configurePlannerWorker
  readonly onReady: () => void
  readonly forceExit: (code: number) => void
  readonly waitForTermination: typeof waitForWorkerTermination
}

const defaultDependencies: PlannerWorkerBootstrapDependencies = {
  startObservability,
  configure: configurePlannerWorker,
  onReady: () => {
    process.stdout.write(
      `${JSON.stringify({ event: 'planner_worker_ready', module: 'bootstrap' })}\n`,
    )
  },
  forceExit: (code) => process.exit(code),
  waitForTermination: waitForWorkerTermination,
}

export async function runPlannerWorker(
  config: PlannerWorkerRuntimeConfig,
  dependencies: PlannerWorkerBootstrapDependencies = defaultDependencies,
): Promise<void> {
  const startupController = new AbortController()
  const listenerController = new AbortController()
  let runtimeClose: (() => Promise<void>) | undefined
  let signalAccepted = false
  let startupComplete = false
  let startupWatchdog: ReturnType<typeof setTimeout> | undefined
  let shutdownForced = false
  const forceShutdown = (): void => {
    if (shutdownForced) return
    shutdownForced = true
    dependencies.forceExit(1)
  }
  const clearStartupWatchdog = (): void => {
    if (startupWatchdog === undefined) return
    clearTimeout(startupWatchdog)
    startupWatchdog = undefined
  }
  const termination = dependencies.waitForTermination(async () => {
    signalAccepted = true
    if (!startupComplete && startupWatchdog === undefined) {
      startupWatchdog = setTimeout(forceShutdown, config.shutdownGraceMs)
    }
    startupController.abort(new Error('Planner worker termination requested'))
    await runtimeClose?.()
  }, listenerController.signal)
  const observability = dependencies.startObservability(config)
  let configured
  try {
    configured = await dependencies.configure(
      config,
      observability,
      startupController.signal,
    )
  } catch (error: unknown) {
    listenerController.abort()
    await termination
    if (signalAccepted) {
      if (error instanceof PlannerWorkerStartupCleanupError) {
        forceShutdown()
        throw error
      }
      clearStartupWatchdog()
      return
    }
    throw error
  }
  startupComplete = true
  clearStartupWatchdog()
  try {
    if (signalAccepted || startupController.signal.aborted) {
      await configured.application.close()
      return
    }
    await runWorkerApplication({
      application: configured.application,
      shutdownGraceMs: config.shutdownGraceMs,
      onStarted: dependencies.onReady,
      forceExit: dependencies.forceExit,
      waitForTermination: async (close) => {
        runtimeClose = close
        if (signalAccepted || startupController.signal.aborted) {
          await close()
          return
        }
        await Promise.race([termination, configured.failure])
      },
    })
  } finally {
    listenerController.abort()
    await termination
  }
}
