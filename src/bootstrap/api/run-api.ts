import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'

import { ApiRuntime } from './api-runtime'
import { configureApi } from './configure-api'
import { GracefulShutdownCoordinator } from './graceful-shutdown'
import { installProcessSignalHandlers } from './process-signals'
import type { ObservabilityRuntime } from '@/platform/observability/observability.runtime'

export async function runApi(
  config: ApplicationRuntimeConfig,
  observability: ObservabilityRuntime,
): Promise<void> {
  const runtime = new ApiRuntime(() => configureApi(config))
  const coordinator = new GracefulShutdownCoordinator(
    runtime,
    undefined,
    observability,
  )
  const uninstall = installProcessSignalHandlers(
    coordinator,
    config.http.shutdownGraceMs,
  )
  try {
    await runtime.start()
  } catch (error: unknown) {
    uninstall()
    await observability
      .close(AbortSignal.timeout(config.http.shutdownGraceMs))
      .catch(() => undefined)
    throw error
  }
}
