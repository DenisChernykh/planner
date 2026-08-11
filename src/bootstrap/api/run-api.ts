import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'

import { ApiRuntime } from './api-runtime'
import { configureApi } from './configure-api'
import { GracefulShutdownCoordinator } from './graceful-shutdown'
import { installProcessSignalHandlers } from './process-signals'

export async function runApi(config: ApplicationRuntimeConfig): Promise<void> {
  const runtime = new ApiRuntime(() => configureApi(config))
  const coordinator = new GracefulShutdownCoordinator(runtime)
  const uninstall = installProcessSignalHandlers(
    coordinator,
    config.http.shutdownGraceMs,
  )
  try {
    await runtime.start()
  } catch (error: unknown) {
    uninstall()
    throw error
  }
}
