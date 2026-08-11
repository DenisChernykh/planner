import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import type { ObservabilityRuntime } from '@/platform/observability/observability.runtime'

import { startObservability } from '../observability/start-observability'

interface ApiRunner {
  runApi(
    config: ApplicationRuntimeConfig,
    observability: ObservabilityRuntime,
  ): Promise<void>
}

export interface ApiBootstrapDependencies {
  readonly startObservability: (
    config: ApplicationRuntimeConfig,
  ) => ObservabilityRuntime
  readonly loadApi: () => Promise<ApiRunner>
}

const defaultDependencies: ApiBootstrapDependencies = {
  startObservability,
  loadApi: () => import('./run-api.js'),
}

export async function bootstrapApi(
  config: ApplicationRuntimeConfig,
  dependencies: ApiBootstrapDependencies = defaultDependencies,
): Promise<void> {
  const observability = dependencies.startObservability(config)
  try {
    const api = await dependencies.loadApi()
    await api.runApi(config, observability)
  } catch (error: unknown) {
    await observability
      .close(AbortSignal.timeout(config.http.shutdownGraceMs))
      .catch(() => undefined)
    throw error
  }
}
