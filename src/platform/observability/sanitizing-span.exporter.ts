import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

const allowed = new Set([
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'network.protocol.version',
  'url.scheme',
  'db.system',
  'db.system.name',
  'db.operation',
  'db.operation.name',
  'db.namespace',
  'planner.request_id',
])

export class SanitizingSpanExporter implements SpanExporter {
  public constructor(private readonly delegate: SpanExporter) {}

  public export(
    spans: ReadableSpan[],
    callback: Parameters<SpanExporter['export']>[1],
  ): void {
    try {
      this.delegate.export(spans.map(sanitize), callback)
    } catch {
      callback({ code: 1 })
    }
  }

  public shutdown(): Promise<void> {
    return this.delegate.shutdown()
  }

  public forceFlush?(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve()
  }
}

function sanitize(span: ReadableSpan): ReadableSpan {
  const clone = Object.create(span) as ReadableSpan
  Object.defineProperties(clone, {
    attributes: {
      value: Object.freeze(
        Object.fromEntries(
          Object.entries(span.attributes).filter(([key]) => allowed.has(key)),
        ),
      ),
      enumerable: true,
    },
    events: { value: Object.freeze([]), enumerable: true },
    links: { value: Object.freeze([]), enumerable: true },
    name: { value: 'planner.span', enumerable: true },
    status: {
      value: Object.freeze({ code: span.status.code }),
      enumerable: true,
    },
  })
  return Object.freeze(clone)
}
