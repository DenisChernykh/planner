import { context, trace, type Span } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { BadRequestException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'

import { bootstrapApi } from '@/bootstrap/api/bootstrap-api'
import { ApiRuntime } from '@/bootstrap/api/api-runtime'
import { GracefulShutdownCoordinator } from '@/bootstrap/api/graceful-shutdown'
import {
  startObservability,
  type ObservabilityBootstrapDependencies,
} from '@/bootstrap/observability/start-observability'
import { buildApiRuntimeConfig } from '@/platform/config/runtime-environment'
import { RuntimeConfigModule } from '@/platform/config/runtime-config.module'
import { RuntimeConfigurationError } from '@/platform/config/runtime-config.types'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { createRequestContextMiddleware } from '@/platform/http/context/request-context.middleware'
import { RequestContext } from '@/platform/http/context/request-context'
import { HttpContextModule } from '@/platform/http/context/http-context.module'
import { resolveRequestId } from '@/platform/http/context/request-id'
import { canonicalizeJson } from '@/platform/http/docs/openapi-normalizer'
import { HttpProblemRegistry } from '@/platform/http/errors/http-problem.registry'
import { CORE_HTTP_PROBLEM_CONTRIBUTION } from '@/platform/http/errors/http-problem.mapper'
import { RequestValidationError } from '@/platform/http/errors/request-validation.error'
import { mapValidationErrors } from '@/platform/http/errors/validation-error.mapper'
import { HealthController } from '@/platform/http/health/health.controller'
import { PUBLIC_ENDPOINT_METADATA } from '@/platform/http/policy/public-endpoint.decorator'
import {
  STRUCTURED_LOGGER,
  type StructuredLogger,
  type StructuredLogRecord,
} from '@/platform/logging/logging.contracts'
import { LoggingModule } from '@/platform/logging/logging.module'
import { PinoLogSink } from '@/platform/logging/pino-log.sink'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'
import { ObservabilityRuntime } from '@/platform/observability/observability.runtime'
import { SanitizingSpanExporter } from '@/platform/observability/sanitizing-span.exporter'
import { SystemProductClock } from '@/platform/time/system-product-clock'
import { FakeProductClock } from '@/platform/time/fake-product-clock'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('S03 HTTP problem contracts', () => {
  const requiredEnvironment = {
    API_HOST: '127.0.0.1',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://contract:contract@127.0.0.1:1/contract',
    REDIS_AUTH_URL: 'redis://default:contract@127.0.0.1:1',
    REDIS_KEY_PREFIX: 'planner',
    AUTH_SESSION_KEY_SECRET: Buffer.alloc(32, 61).toString('base64url'),
    AUTH_CSRF_SECRET: Buffer.alloc(32, 62).toString('base64url'),
    AUTH_CSRF_ORIGINS: 'https://planner.invalid',
  } as const

  it('marks the production health controller as explicitly public', () => {
    // Removing the neutral policy marker or the controller annotation must fail.
    expect(
      new Reflector().get(PUBLIC_ENDPOINT_METADATA, HealthController),
    ).toBe(true)
  })

  it('validates and defaults the typed logging runtime level', () => {
    // Ignoring LOG_LEVEL or accepting an arbitrary Pino level must fail.
    expect(buildApiRuntimeConfig(requiredEnvironment)).toMatchObject({
      logging: { level: 'info' },
    })
    expect(
      buildApiRuntimeConfig({ ...requiredEnvironment, LOG_LEVEL: 'fatal' }),
    ).toMatchObject({ logging: { level: 'fatal' } })
    expect(() =>
      buildApiRuntimeConfig({ ...requiredEnvironment, LOG_LEVEL: 'verbose' }),
    ).toThrow(RuntimeConfigurationError)
  })

  it('injects production environment and configured level into the logging sink', async () => {
    // Reintroducing development/info constants in LoggingModule must fail.
    const writes: string[] = []
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      })
    const moduleRef = await Test.createTestingModule({
      imports: [
        RuntimeConfigModule.forRoot(
          buildApiRuntimeConfig({
            ...requiredEnvironment,
            NODE_ENV: 'production',
            LOG_LEVEL: 'debug',
          }),
        ),
        HttpContextModule,
        LoggingModule,
      ],
    }).compile()
    try {
      moduleRef.get<StructuredLogger>(STRUCTURED_LOGGER).write({
        level: 'debug',
        event: 'otel_diagnostic',
        module: 'OpenTelemetry',
      })
      expect(JSON.parse(writes.join(''))).toMatchObject({
        environment: 'production',
        level: 'debug',
      })
    } finally {
      await moduleRef.close()
      stdout.mockRestore()
    }
  })

  it('rejects duplicate problem definitions before HTTP startup', () => {
    // Removing the registry uniqueness guard must make this test fail.
    expect(
      () =>
        new HttpProblemRegistry([
          CORE_HTTP_PROBLEM_CONTRIBUTION,
          CORE_HTTP_PROBLEM_CONTRIBUTION,
        ]),
    ).toThrow('Duplicate HTTP problem definition: MALFORMED_REQUEST')
  })

  it('maps validation issues to sorted, value-free RFC 6901 pointers', () => {
    // Removing pointer sorting/deduplication or exposing rejected values must fail.
    const errors = mapValidationErrors([
      {
        property: 'profile',
        children: [
          {
            property: 'name/with~reserved',
            constraints: { isString: 'must be a string' },
            children: [],
          },
        ],
        constraints: undefined,
      },
      {
        property: 'count',
        constraints: {
          isInt: 'must be an integer',
          min: 'must not be less than 1',
        },
        children: [],
      },
    ] as never)

    expect(errors).toEqual([
      {
        pointer: '/count',
        code: 'invalid_type',
        detail: 'Field has an invalid type.',
      },
      {
        pointer: '/count',
        code: 'invalid_value',
        detail: 'Field has an invalid value.',
      },
      {
        pointer: '/profile/name~1with~0reserved',
        code: 'invalid_type',
        detail: 'Field has an invalid type.',
      },
    ])
    expect(JSON.stringify(errors)).not.toContain('must be an integer')
  })

  it('sorts Unicode validation pointers by UTF-16 code units', () => {
    // U+007A precedes U+00E4 without relying on the host locale.
    const errors = mapValidationErrors([
      { property: 'ä', constraints: { isString: 'raw' }, children: [] },
      { property: 'z', constraints: { isString: 'raw' }, children: [] },
    ] as never)

    expect(errors.map(({ pointer }) => pointer)).toEqual(['/z', '/ä'])
  })

  it('canonicalizes Unicode object keys by UTF-16 code units', () => {
    // U+007A precedes U+00E4 even when locale collation treats them together.
    expect(canonicalizeJson({ ä: 1, z: 2 })).toBe('{\n  "z": 2,\n  "ä": 1\n}\n')
  })

  it('uses only registered mappings and otherwise returns the constant internal problem', () => {
    // Returning framework exception messages or an unregistered code must fail.
    const registry = new HttpProblemRegistry([CORE_HTTP_PROBLEM_CONTRIBUTION])

    expect(registry.map(new BadRequestException('secret input'))).toMatchObject(
      {
        definition: {
          code: 'MALFORMED_REQUEST',
          type: 'https://planner.invalid/problems/malformed-request',
          status: 400,
        },
        unexpected: false,
      },
    )
    expect(registry.map(new Error('token=leaked'))).toMatchObject({
      definition: {
        code: 'INTERNAL_ERROR',
        type: 'https://planner.invalid/problems/internal-error',
        status: 500,
      },
      unexpected: true,
    })
    expect(
      registry.map(
        new RequestValidationError([
          { pointer: '/email', code: 'invalid_format', detail: 'Invalid.' },
        ]),
      ),
    ).toMatchObject({
      definition: { code: 'VALIDATION_FAILED', status: 422 },
      errors: [
        { pointer: '/email', code: 'invalid_format', detail: 'Invalid.' },
      ],
    })
  })

  it('accepts exactly canonical UUID or uppercase ULID correlation values', () => {
    // Weakening the inbound correlation trust policy must fail this table.
    const generated = '11111111-1111-4111-8111-111111111111'
    const uuid = '123e4567-e89b-42d3-a456-426614174000'
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

    expect(resolveRequestId(uuid, () => generated)).toEqual({
      requestId: uuid,
      accepted: true,
    })
    expect(resolveRequestId(ulid, () => generated)).toEqual({
      requestId: ulid,
      accepted: true,
    })
    for (const invalid of [
      undefined,
      '01arz3ndektsv4rrffq69g5fav',
      `${uuid},${uuid}`,
      'x'.repeat(65),
    ]) {
      expect(resolveRequestId(invalid, () => generated)).toEqual({
        requestId: generated,
        accepted: false,
      })
    }
  })

  it('serializes errors without message or cause and bounds stack frames', () => {
    // Letting arbitrary error text enter the Pino record must make this test fail.
    const writes: string[] = []
    const sink = new PinoLogSink(
      { environment: 'test', logging: { level: 'info' } },
      {
        destination: {
          write: (chunk: string) => {
            writes.push(chunk)
            return true
          },
        },
        now: () => new Date('2026-08-11T00:00:00.000Z'),
      },
    )
    const error = new Error('authorization=Bearer secret-token')
    error.stack = `${error.name}: ${error.message}\n${Array.from(
      { length: 12 },
      (_, index) => `    at frame${index} (postgresql://user:password@db/app)`,
    ).join('\n')}`
    sink.write({
      level: 'error',
      event: 'http_unhandled_error',
      module: 'ProblemExceptionFilter',
      error,
    })

    const record = JSON.parse(writes.join('')) as {
      error: { type: string; stack?: string[] }
    }
    expect(record.error.type).toBe('Error')
    expect(record.error.stack).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain('secret-token')
    expect(JSON.stringify(record)).not.toContain('person@example.test')
    expect(JSON.stringify(record)).not.toContain('postgresql://')
  })

  it('rejects the whole structured record when its event schema or value is unsafe', () => {
    // Accepting arbitrary modules, free text, PII-shaped routes, or malformed values must fail.
    const writes: string[] = []
    const sink = new PinoLogSink(
      { environment: 'test', logging: { level: 'info' } },
      {
        destination: {
          write: (chunk: string) => {
            writes.push(chunk)
            return true
          },
        },
        now: () => new Date('2026-08-11T00:00:00.000Z'),
      },
    )
    const validAccess: StructuredLogRecord = {
      level: 'info',
      event: 'http_request_completed',
      module: 'HttpAccess',
      correlation: { requestId: '123e4567-e89b-42d3-a456-426614174000' },
      attributes: {
        route: '/contract/items/:itemId',
        method: 'GET',
        status: 200,
        durationMs: 25,
      },
    }
    const invalidRecords: readonly StructuredLogRecord[] = [
      { ...validAccess, module: 'ArbitraryModule' },
      { ...validAccess, module: 'ProblemExceptionFilter' },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, route: 'free text message' },
      },
      {
        ...validAccess,
        attributes: {
          ...validAccess.attributes,
          route: '/people/person@example.test',
        },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, route: '/call/+79001234567' },
      },
      {
        ...validAccess,
        attributes: {
          ...validAccess.attributes,
          route: '/contract/items?message=secret',
        },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, method: 'get' },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, method: 'FETCH' },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, status: 99 },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, status: 600 },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, status: 200.5 },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, durationMs: -1 },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, durationMs: Number.NaN },
      },
      {
        ...validAccess,
        attributes: { ...validAccess.attributes, durationMs: 60_001 },
      },
      {
        ...validAccess,
        attributes: {
          ...validAccess.attributes,
          route: `/${'a'.repeat(257)}`,
        },
      },
      {
        ...validAccess,
        correlation: { requestId: 'person@example.test' },
      },
      {
        level: 'error',
        event: 'http_unhandled_error',
        module: 'ProblemExceptionFilter',
        attributes: { message: 'person@example.test +79001234567' },
      },
    ]

    for (const record of invalidRecords) {
      expect(() => sink.write(record)).toThrow('Invalid structured log record')
    }
    expect(writes).toEqual([])

    sink.write(validAccess)
    expect(JSON.parse(writes.join(''))).toMatchObject({
      event: 'http_request_completed',
      module: 'HttpAccess',
      route: '/contract/items/:itemId',
      method: 'GET',
      status: 200,
      durationMs: 25,
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    })
  })

  it('propagates only the selected request ID to the active span and sanitized export', () => {
    // Omitting the span attribute or attaching the untrusted raw header must fail.
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    try {
      const middleware = createRequestContextMiddleware(new RequestContext())
      const invoke = (header: string): Readonly<Record<string, string>> => {
        const attributes: Record<string, string> = {}
        const span = {
          setAttribute: (key: string, value: string) => {
            attributes[key] = value
            return span
          },
        } as unknown as Span
        const responseHeaders: Record<string, string> = {}
        context.with(trace.setSpan(context.active(), span), () => {
          middleware(
            { headers: { 'x-request-id': header } } as never,
            {
              setHeader: (key: string, value: string) => {
                responseHeaders[key] = value
              },
            } as never,
            () => undefined,
          )
        })
        expect(attributes['planner.request_id']).toBe(
          responseHeaders['X-Request-ID'],
        )
        return Object.freeze({ ...attributes })
      }

      const trusted = invoke('123e4567-e89b-42d3-a456-426614174000')
      expect(trusted).toEqual({
        'planner.request_id': '123e4567-e89b-42d3-a456-426614174000',
      })
      const replaced = invoke('01arz3ndektsv4rrffq69g5fav')
      expect(replaced['planner.request_id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(replaced['planner.request_id']).not.toBe(
        '01arz3ndektsv4rrffq69g5fav',
      )

      let exported: ReadableSpan | undefined
      const delegate: SpanExporter = {
        export: (spans, callback) => {
          exported = spans[0]
          callback({ code: 0 })
        },
        shutdown: () => Promise.resolve(),
      }
      const exporter = new SanitizingSpanExporter(delegate)
      exporter.export(
        [
          {
            attributes: {
              'planner.request_id': replaced['planner.request_id']!,
              'url.full':
                'https://planner.invalid/raw?email=person@example.test',
            },
            events: [],
            links: [],
            name: 'GET /raw-person-id',
            status: { code: 0 },
          } as unknown as ReadableSpan,
        ],
        () => undefined,
      )
      expect(exported?.attributes).toEqual({
        'planner.request_id': replaced['planner.request_id'],
      })
    } finally {
      context.disable()
      manager.disable()
    }
  })

  it('formats the immutable product timezone at the UTC date boundary', () => {
    // Reading the host timezone instead of Asia/Yekaterinburg must fail.
    const clock = new SystemProductClock(
      () => new Date('2026-08-10T19:30:00.000Z'),
    )

    expect(clock.now().toISOString()).toBe('2026-08-10T19:30:00.000Z')
    expect(clock.today('Asia/Yekaterinburg')).toBe('2026-08-11')
  })

  it('moves a mutable fake clock across the product date boundary', () => {
    // Replacing the fake with system time or a snapshot must fail.
    const clock = new FakeProductClock(new Date('2026-08-10T18:59:59.000Z'))
    expect(clock.today('Asia/Yekaterinburg')).toBe('2026-08-10')
    clock.set(new Date('2026-08-10T19:00:00.000Z'))
    expect(clock.today('Asia/Yekaterinburg')).toBe('2026-08-11')
  })

  it('starts typed OTel before loading the API and closes it after startup failure', async () => {
    // Loading the API before telemetry or leaking telemetry cleanup failures must fail.
    const config = buildApiRuntimeConfig({
      ...requiredEnvironment,
      NODE_ENV: 'test',
      OTEL_SDK_DISABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318',
    })
    const events: string[] = []
    const observability = new ObservabilityRuntime({
      shutdown: () => {
        events.push('otel:shutdown')
        return Promise.reject(new Error('collector unavailable'))
      },
    })

    await expect(
      bootstrapApi(config, {
        startObservability: () => {
          events.push('otel:start')
          return observability
        },
        loadApi: () => {
          events.push('api:import')
          return Promise.resolve({
            runApi: () => {
              events.push('api:start')
              return Promise.reject(new Error('listen failed'))
            },
          })
        },
      }),
    ).rejects.toThrow('listen failed')
    expect(events).toEqual([
      'otel:start',
      'api:import',
      'api:start',
      'otel:shutdown',
    ])
  })

  it('keeps disabled OTel inert and uses only injected HTTP/PG lifecycle fakes when enabled', async () => {
    // Reading process.env here, constructing a network exporter, or skipping cleanup must fail.
    const disabledConfig = buildApiRuntimeConfig({
      ...requiredEnvironment,
      NODE_ENV: 'test',
      OTEL_SDK_DISABLED: 'true',
    })
    const forbiddenDependencies: ObservabilityBootstrapDependencies = {
      createProvider: () => {
        throw new Error('disabled OTel created a provider')
      },
      registerInstrumentations: () => {
        throw new Error('disabled OTel registered instrumentation')
      },
    }
    await expect(
      startObservability(disabledConfig, forbiddenDependencies).close(
        AbortSignal.timeout(100),
      ),
    ).resolves.toBeUndefined()

    const enabledConfig = buildApiRuntimeConfig({
      ...requiredEnvironment,
      NODE_ENV: 'test',
      OTEL_SDK_DISABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318/root',
    })
    const events: string[] = []
    const dependencies: ObservabilityBootstrapDependencies = {
      createProvider: (config) => {
        expect(config.observability.endpoint).toBe(
          'http://collector.invalid:4318/root',
        )
        events.push('provider:create')
        return {
          register: () => events.push('provider:register'),
          shutdown: () => {
            events.push('provider:shutdown')
            return Promise.resolve()
          },
        }
      },
      registerInstrumentations: () => {
        events.push('instrumentations:http+pg')
        return () => events.push('instrumentations:unregister')
      },
    }
    const runtime = startObservability(enabledConfig, dependencies)
    expect(events).toEqual([
      'provider:create',
      'provider:register',
      'instrumentations:http+pg',
    ])
    await runtime.close(AbortSignal.timeout(100))
    await runtime.close(AbortSignal.timeout(100))
    expect(events).toEqual([
      'provider:create',
      'provider:register',
      'instrumentations:http+pg',
      'instrumentations:unregister',
      'provider:shutdown',
    ])

    const failed = startObservability(enabledConfig, {
      ...dependencies,
      createProvider: () => {
        throw new Error('provider init failed')
      },
    })
    await expect(
      failed.close(AbortSignal.timeout(100)),
    ).resolves.toBeUndefined()

    let partialProviderShutdowns = 0
    const partiallyStarted = startObservability(enabledConfig, {
      createProvider: () => ({
        register: () => undefined,
        shutdown: () => {
          partialProviderShutdowns += 1
          return Promise.resolve()
        },
      }),
      registerInstrumentations: () => {
        throw new Error('instrumentation registration failed')
      },
    })
    await partiallyStarted.close(AbortSignal.timeout(100))
    expect(partialProviderShutdowns).toBe(1)
  })

  it('bounds normal OTel shutdown and treats exporter shutdown failure as telemetry-only', async () => {
    // Omitting OTel from the existing shutdown budget or changing exit status must fail.
    const lifecycle = new ApplicationLifecycleState()
    const requestTracker = new ActiveRequestTracker()
    const runtime = new ApiRuntime(() =>
      Promise.resolve({
        lifecycle,
        requestTracker,
        httpDrainTimeoutMs: 6_000,
        shutdownGraceMs: 10_000,
        database: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        redis: {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        application: {
          listen: () => Promise.resolve(),
          closeListener: () => Promise.resolve(),
          closeIdleConnections: () => undefined,
          closeAllConnections: () => undefined,
          close: () => Promise.resolve(),
          address: () => null,
        },
      }),
    )
    await runtime.start()
    const deadlines: number[] = []
    let telemetryShutdowns = 0
    const coordinator = new GracefulShutdownCoordinator(
      runtime,
      (milliseconds) => {
        deadlines.push(milliseconds)
        return AbortSignal.timeout(milliseconds)
      },
      new ObservabilityRuntime({
        shutdown: () => {
          telemetryShutdowns += 1
          return Promise.reject(new Error('export failed'))
        },
      }),
    )

    await expect(coordinator.shutdown('SIGTERM')).resolves.toEqual({
      exitCode: 0,
      forced: false,
    })
    expect(deadlines).toEqual([6_000, 4_000])
    expect(telemetryShutdowns).toBe(1)
  })

  it.each([
    ['database', 'synchronous'],
    ['database', 'asynchronous'],
    ['redis', 'synchronous'],
    ['redis', 'asynchronous'],
  ] as const)(
    'waits for and closes the late sibling after %s %s startup failure',
    async (failedDependency, failureMode) => {
      const sibling = deferred<void>()
      const asynchronousFailure = deferred<void>()
      const failure = new Error(
        `${failedDependency} ${failureMode} startup failure`,
      )
      const databaseClose = jest.fn().mockResolvedValue(undefined)
      const redisClose = jest.fn().mockResolvedValue(undefined)
      const failingConnect = (): Promise<void> => {
        if (failureMode === 'synchronous') throw failure
        return asynchronousFailure.promise
      }
      const runtime = new ApiRuntime(() =>
        Promise.resolve({
          lifecycle: new ApplicationLifecycleState(),
          requestTracker: new ActiveRequestTracker(),
          httpDrainTimeoutMs: 6_000,
          shutdownGraceMs: 10_000,
          database: {
            connect:
              failedDependency === 'database'
                ? failingConnect
                : () => sibling.promise,
            close: databaseClose,
          },
          redis: {
            connect:
              failedDependency === 'redis'
                ? failingConnect
                : () => sibling.promise,
            close: redisClose,
          },
          application: {
            listen: () => Promise.resolve(),
            closeListener: () => Promise.resolve(),
            closeIdleConnections: () => undefined,
            closeAllConnections: () => undefined,
            close: () => Promise.resolve(),
            address: () => null,
          },
        }),
      )
      let startupSettled = false
      const startup = runtime.start()
      void startup.then(
        () => {
          startupSettled = true
        },
        () => {
          startupSettled = true
        },
      )
      if (failureMode === 'asynchronous') asynchronousFailure.reject(failure)
      await Promise.resolve()
      await Promise.resolve()
      expect(startupSettled).toBe(false)

      sibling.resolve()
      await expect(startup).rejects.toMatchObject({
        message: 'API startup failed',
        cause: failure,
      })
      expect(databaseClose).toHaveBeenCalledTimes(1)
      expect(redisClose).toHaveBeenCalledTimes(1)
    },
  )

  it('closes both dependencies and reports exit 1 when one shutdown rejects', async () => {
    const databaseClose = jest
      .fn()
      .mockRejectedValue(new Error('database close failure'))
    const redisClose = jest.fn().mockResolvedValue(undefined)
    const runtime = new ApiRuntime(() =>
      Promise.resolve({
        lifecycle: new ApplicationLifecycleState(),
        requestTracker: new ActiveRequestTracker(),
        httpDrainTimeoutMs: 6_000,
        shutdownGraceMs: 10_000,
        database: {
          connect: () => Promise.resolve(),
          close: databaseClose,
        },
        redis: {
          connect: () => Promise.resolve(),
          close: redisClose,
        },
        application: {
          listen: () => Promise.resolve(),
          closeListener: () => Promise.resolve(),
          closeIdleConnections: () => undefined,
          closeAllConnections: () => undefined,
          close: () => Promise.resolve(),
          address: () => null,
        },
      }),
    )
    await runtime.start()

    await expect(
      new GracefulShutdownCoordinator(runtime).shutdown('SIGTERM'),
    ).resolves.toEqual({ exitCode: 1, forced: false })
    expect(databaseClose).toHaveBeenCalledTimes(1)
    expect(redisClose).toHaveBeenCalledTimes(1)
  })
})
