import { diag, DiagLogLevel } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import type { ApplicationRuntimeConfig } from '@/platform/config/runtime-config.types'
import { ObservabilityRuntime } from '@/platform/observability/observability.runtime'
import { SanitizingSpanExporter } from '@/platform/observability/sanitizing-span.exporter'

interface TracerProviderLifecycle {
  register(): void
  shutdown(): Promise<void>
}

export interface ObservabilityBootstrapDependencies {
  readonly createProvider: (
    config: ApplicationRuntimeConfig,
  ) => TracerProviderLifecycle
  readonly registerInstrumentations: () => () => void
}

const defaultDependencies: ObservabilityBootstrapDependencies = {
  createProvider: (config) => {
    const exporter = new SanitizingSpanExporter(
      new OTLPTraceExporter({
        ...traceEndpoint(config),
        timeoutMillis: config.observability.exporterTimeoutMs,
      }),
    )
    return new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'planner' }),
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          scheduledDelayMillis: config.observability.batchSpanScheduleDelayMs,
          exportTimeoutMillis: config.observability.batchSpanExportTimeoutMs,
        }),
      ],
    })
  },
  registerInstrumentations: () =>
    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation(),
        new PgInstrumentation({ enhancedDatabaseReporting: false }),
      ],
    }),
}

export function startObservability(
  config: ApplicationRuntimeConfig,
  dependencies: ObservabilityBootstrapDependencies = defaultDependencies,
): ObservabilityRuntime {
  if (config.observability.disabled) return new ObservabilityRuntime()
  let provider: TracerProviderLifecycle | undefined
  try {
    diag.setLogger(
      { error() {}, warn() {}, info() {}, debug() {}, verbose() {} },
      DiagLogLevel.WARN,
    )
    provider = dependencies.createProvider(config)
    provider.register()
    const activeProvider = provider
    const unregister = dependencies.registerInstrumentations()
    return new ObservabilityRuntime({
      shutdown: async () => {
        unregister()
        await activeProvider.shutdown()
      },
    })
  } catch {
    const partiallyStartedProvider = provider
    return partiallyStartedProvider === undefined
      ? new ObservabilityRuntime()
      : new ObservabilityRuntime({
          shutdown: () => partiallyStartedProvider.shutdown(),
        })
  }
}

function traceEndpoint(config: ApplicationRuntimeConfig): {
  readonly url?: string
} {
  const endpoint = config.observability.endpoint
  if (endpoint === undefined) return {}
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`
  return { url: new URL('v1/traces', base).toString() }
}
