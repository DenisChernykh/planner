import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { IsEmail, IsInt, IsString, Min } from 'class-validator'
import OpenAPIResponseValidator from 'openapi-response-validator'
import request from 'supertest'

import {
  checkOpenApiDrift,
  generateOpenApiArtifact,
} from '@/bootstrap/contracts/generate-openapi'
import { createOpenApiRuntimeConfig } from '@/bootstrap/contracts/openapi-runtime-config'
import { configureHttpApplication } from '@/platform/http/bootstrap/configure-http-application'
import { ActiveRequestTracker } from '@/platform/http/bootstrap/active-request-tracker'
import { RequestContext } from '@/platform/http/context/request-context'
import { ApiProblemResponses } from '@/platform/http/docs/api-problem-responses.decorator'
import { createOpenApiDocument } from '@/platform/http/docs/openapi-document'
import { HttpErrorsModule } from '@/platform/http/errors/http-errors.module'
import { HttpProblemRegistry } from '@/platform/http/errors/http-problem.registry'
import { CORE_HTTP_PROBLEM_CONTRIBUTION } from '@/platform/http/errors/http-problem.mapper'
import {
  STRUCTURED_LOGGER,
  type StructuredLogRecord,
  type StructuredLogger,
} from '@/platform/logging/logging.contracts'
import { ApplicationLifecycleState } from '@/platform/lifecycle/application-lifecycle.state'

interface OpenApiResponse {
  readonly content?: Record<
    string,
    {
      readonly schema?: unknown
      readonly examples?: Record<string, unknown>
    }
  >
}

class ContractRequestDto {
  @IsEmail()
  public readonly email!: string

  @IsInt()
  @Min(1)
  public readonly count!: number

  @IsString()
  public readonly label!: string
}

@Controller('contract')
class ContractController {
  @Post('validate')
  @ApiProblemResponses('VALIDATION_FAILED')
  public validate(@Body() body: ContractRequestDto): ContractRequestDto {
    return body
  }

  @Get('unexpected')
  public unexpected(): never {
    throw new Error('authorization=Bearer top-secret email=person@example.test')
  }

  @Get('items/:itemId')
  public item(@Param('itemId') itemId: string): { readonly found: boolean } {
    void itemId
    return { found: true }
  }
}

@Module({
  imports: [HttpErrorsModule.forRoot([CORE_HTTP_PROBLEM_CONTRIBUTION])],
  controllers: [ContractController],
})
class ContractTestModule {}

describe('S03 HTTP contracts', () => {
  let app: NestExpressApplication
  let accessNow: () => number
  let logRecords: StructuredLogRecord[]

  async function createContractApp(logger: StructuredLogger): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [ContractTestModule],
    })
      .overrideProvider(STRUCTURED_LOGGER)
      .useValue(logger)
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    })
    const context = app.get(RequestContext)
    const lifecycle = new ApplicationLifecycleState()
    lifecycle.markReady()
    configureHttpApplication(
      app,
      lifecycle,
      new ActiveRequestTracker(),
      context,
      logger,
      { accessLogNow: () => accessNow() },
    )
    await app.init()
  }

  beforeEach(async () => {
    accessNow = () => performance.now()
    logRecords = []
    await createContractApp({ write: (record) => logRecords.push(record) })
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns deterministic value-free validation Problem Details and echoes a trusted request ID', async () => {
    // Disabling whitelist/forbid, implicit conversion, problem mapping or correlation must fail.
    const requestId = '123e4567-e89b-42d3-a456-426614174000'
    const response = await request(app.getHttpServer())
      .post('/contract/validate')
      .set('X-Request-ID', requestId)
      .send({ email: 'not-an-email', count: '2', label: 4, extra: 'forbidden' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(422)

    expect(response.headers['x-request-id']).toBe(requestId)
    expect(response.body).toEqual({
      type: 'https://planner.invalid/problems/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'One or more request fields are invalid.',
      instance: `urn:request:${requestId}`,
      code: 'VALIDATION_FAILED',
      requestId,
      errors: [
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
          pointer: '/email',
          code: 'invalid_format',
          detail: 'Field has an invalid format.',
        },
        {
          pointer: '/extra',
          code: 'unknown_field',
          detail: 'Field is not allowed.',
        },
        {
          pointer: '/label',
          code: 'invalid_type',
          detail: 'Field has an invalid type.',
        },
      ],
    })
    expect(JSON.stringify(response.body)).not.toContain('not-an-email')
  })

  it('replaces malformed, lowercase and multi-value correlation headers', async () => {
    // Trusting lowercase ULIDs or comma-joined header values must fail this test.
    for (const invalid of [
      '01arz3ndektsv4rrffq69g5fav',
      '123e4567-e89b-42d3-a456-426614174000,123e4567-e89b-42d3-a456-426614174000',
    ]) {
      const response = await request(app.getHttpServer())
        .get('/missing')
        .set('X-Request-ID', invalid)
        .expect(404)
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(response.headers['x-request-id']).not.toBe(invalid)
    }
  })

  it('maps malformed and oversized bodies to documented safe Problems', async () => {
    // Removing parser error mapping or the byte limit must fail these assertions.
    const malformedId = randomUUID()
    const malformed = await request(app.getHttpServer())
      .post('/contract/validate')
      .set('X-Request-ID', malformedId)
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400)
    expect(malformed.body).toMatchObject({
      code: 'MALFORMED_REQUEST',
      requestId: malformedId,
      instance: `urn:request:${malformedId}`,
    })

    const oversizedId = randomUUID()
    const oversized = await request(app.getHttpServer())
      .post('/contract/validate')
      .set('X-Request-ID', oversizedId)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ label: 'x'.repeat(1_048_577) }))
      .expect(413)
    expect(oversized.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      requestId: oversizedId,
      instance: `urn:request:${oversizedId}`,
    })
  })

  it('collapses unknown errors and loses logger failures without leaking PII', async () => {
    // Returning Error.message/cause/stack or allowing logging failure to alter the response must fail.
    await app.close()
    const attemptedEvents: string[] = []
    await createContractApp({
      write: (record) => {
        attemptedEvents.push(record.event)
        throw new Error('logger unavailable')
      },
    })
    const response = await request(app.getHttpServer())
      .get('/contract/unexpected')
      .set('X-Request-ID', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
      .expect(500)
    expect(response.body).toEqual({
      type: 'https://planner.invalid/problems/internal-error',
      title: 'Internal server error',
      status: 500,
      detail: 'The server could not complete the request.',
      instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      code: 'INTERNAL_ERROR',
      requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(JSON.stringify(response.body)).not.toMatch(
      /top-secret|person@example\.test|authorization/u,
    )
    expect(attemptedEvents).toEqual([
      'http_unhandled_error',
      'http_request_completed',
    ])
  })

  it('captures one exact safe access record from the real middleware', async () => {
    // Logging raw path/query/body/headers or losing route/correlation must fail.
    const moments = [100, 125]
    accessNow = () => moments.shift() ?? 125
    const requestId = '123e4567-e89b-42d3-a456-426614174000'
    await request(app.getHttpServer())
      .get('/contract/items/raw-person-id?email=person@example.test')
      .set('X-Request-ID', requestId)
      .set('Authorization', 'Bearer top-secret')
      .set('Cookie', 'session=secret-cookie')
      .expect(200)

    expect(logRecords).toEqual([
      {
        level: 'info',
        event: 'http_request_completed',
        module: 'HttpAccess',
        correlation: { requestId },
        attributes: {
          route: '/contract/items/:itemId',
          method: 'GET',
          status: 200,
          durationMs: 25,
        },
      },
    ])
    expect(JSON.stringify(logRecords)).not.toMatch(
      /raw-person-id|person@example\.test|top-secret|secret-cookie|authorization|cookie|query|body|rawUrl/u,
    )
  })

  it('sets the exact bounded HTTP server limits without changing S02 shutdown bounds', () => {
    // Changing any S03 value or S02 drain/watchdog bound must fail this assertion.
    const server = app.getHttpServer() as {
      requestTimeout: number
      headersTimeout: number
      keepAliveTimeout: number
    }
    expect(server).toMatchObject({
      requestTimeout: 30_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    })
  })

  it('returns the registered dependency Problem while traffic is not ready', async () => {
    // Returning an ad-hoc JSON 503 instead of the exception registry must fail.
    await app.close()
    const moduleRef = await Test.createTestingModule({
      imports: [ContractTestModule],
    })
      .overrideProvider(STRUCTURED_LOGGER)
      .useValue({
        write: (record: StructuredLogRecord) => logRecords.push(record),
      })
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    })
    configureHttpApplication(
      app,
      new ApplicationLifecycleState(),
      new ActiveRequestTracker(),
      app.get(RequestContext),
      app.get(STRUCTURED_LOGGER),
    )
    await app.init()
    const response = await request(app.getHttpServer())
      .get('/contract/unexpected')
      .expect(503)
    const body: unknown = response.body as unknown
    expect(body).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      type: 'https://planner.invalid/problems/dependency-unavailable',
    })
    expect(typeof (body as { requestId?: unknown }).requestId).toBe('string')
  })

  it('generates the exact production health and auth graph with the complete Problem catalog', async () => {
    // Stale health-only paths, arbitrary problem codes, or manual auth responses must fail.
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<string, OpenApiResponse>
            security?: readonly Record<string, readonly unknown[]>[]
          }
          post?: {
            responses?: Record<string, OpenApiResponse>
            security?: readonly Record<string, readonly unknown[]>[]
          }
        }
      >
      components?: {
        schemas?: Record<
          string,
          { properties?: Record<string, { enum?: readonly string[] }> }
        >
        securitySchemes?: Record<string, unknown>
      }
    }
    expect(Object.keys(document.paths).sort()).toEqual([
      '/auth/csrf',
      '/auth/logout',
      '/auth/me',
      '/auth/telegram/start',
      '/health/live',
      '/health/ready',
      '/health/startup',
    ])
    expect(document.paths['/auth/issue']).toBeUndefined()
    expect(Object.keys(document.paths['/auth/me'] ?? {})).toEqual(['get'])
    expect(Object.keys(document.paths['/auth/csrf'] ?? {})).toEqual(['get'])
    expect(Object.keys(document.paths['/auth/logout'] ?? {})).toEqual(['post'])
    expect(Object.keys(document.paths['/auth/telegram/start'] ?? {})).toEqual([
      'get',
    ])
    expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(
      expect.arrayContaining([
        'ProblemFieldErrorResponseDto',
        'ProblemResponseDto',
        'ValidationProblemResponseDto',
      ]),
    )
    const exactProblemCodes = [
      'AUTHENTICATION_REQUIRED',
      'AUTHORIZATION_DENIED',
      'CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'MALFORMED_REQUEST',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'RATE_LIMIT_EXCEEDED',
      'UNSUPPORTED_MEDIA_TYPE',
      'VALIDATION_FAILED',
    ]
    expect(
      document.components?.schemas?.['ProblemResponseDto']?.properties?.['code']
        ?.enum,
    ).toEqual(exactProblemCodes)
    expect(document.components?.securitySchemes?.['sessionCookie']).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: '__Host-planner-session',
      description: 'Opaque HttpOnly browser session cookie.',
    })

    for (const healthPath of [
      '/health/live',
      '/health/ready',
      '/health/startup',
    ]) {
      const operation = document.paths[healthPath]?.get
      expect(operation?.security).toEqual([])
      expect(operation?.responses?.['500']).toMatchObject({
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ProblemResponseDto' },
          },
        },
      })
    }

    const authenticationProblem = {
      type: 'https://planner.invalid/problems/authentication-required',
      title: 'Authentication required',
      status: 401,
      detail: 'A valid browser session is required.',
      instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      code: 'AUTHENTICATION_REQUIRED',
      requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }
    for (const operation of [
      document.paths['/auth/me']?.get,
      document.paths['/auth/csrf']?.get,
      document.paths['/auth/logout']?.post,
    ]) {
      expect(
        operation?.responses?.['401']?.content?.['application/problem+json']
          ?.examples,
      ).toEqual({
        AUTHENTICATION_REQUIRED: {
          summary: 'Authentication required',
          value: authenticationProblem,
        },
      })
    }
    expect(
      document.paths['/auth/logout']?.post?.responses?.['403']?.content?.[
        'application/problem+json'
      ]?.examples,
    ).toEqual({
      AUTHORIZATION_DENIED: {
        summary: 'Authorization denied',
        value: {
          type: 'https://planner.invalid/problems/authorization-denied',
          title: 'Authorization denied',
          status: 403,
          detail: 'The request did not satisfy browser authorization controls.',
          instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          code: 'AUTHORIZATION_DENIED',
          requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
      },
    })
    expect(document.paths['/auth/logout']?.post?.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
  })

  it('publishes an RFC 6901 pointer schema for nested escaped segments', async () => {
    // A single-segment pattern or acceptance of malformed tilde escapes must fail.
    const document = JSON.parse(await generateOpenApiArtifact()) as {
      components?: {
        schemas?: Record<
          string,
          { properties?: Record<string, { pattern?: string }> }
        >
      }
    }
    const pattern =
      document.components?.schemas?.['ProblemFieldErrorResponseDto']
        ?.properties?.['pointer']?.pattern
    expect(pattern).toBeDefined()
    const pointer = new RegExp(pattern!)
    expect(pointer.test('/profile/name~1with~0reserved')).toBe(true)
    expect(pointer.test('/profile/name~2invalid')).toBe(false)
    expect(pointer.test('/profile/trailing~')).toBe(false)
  })

  it('generates a validation Problem example that validates against its selected schema', () => {
    // Selecting ValidationProblemResponseDto while omitting required errors must fail.
    const document = createOpenApiDocument(
      app,
      createOpenApiRuntimeConfig(),
      app.get(HttpProblemRegistry).definitions,
    )
    const operation = document.paths['/contract/validate']?.post as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: unknown
                  examples?: Record<string, { value?: unknown }>
                }
              >
            }
          >
        }
      | undefined
    const media =
      operation?.responses?.['422']?.content?.['application/problem+json']
    const example = media?.examples?.['VALIDATION_FAILED']?.value
    expect(example).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        {
          pointer: '/profile/name~1with~0reserved',
          code: 'invalid_type',
          detail: 'Field has an invalid type.',
        },
      ],
    })
    const validator = new OpenAPIResponseValidator({
      responses: { '422': { schema: media?.schema as never } },
      components: document.components as never,
      customFormats: {
        uri: () => true,
        'uri-reference': () => true,
      },
    })
    expect(validator.validateResponse('422', example)).toBeUndefined()
  })

  it('checks OpenAPI byte drift without writing either current or stale artifacts', async () => {
    // A drift command that rewrites either a matching or stale artifact must fail.
    const directory = await mkdtemp(join(tmpdir(), 'planner-openapi-drift-'))
    const artifactPath = join(directory, 'openapi.json')
    try {
      const generated = await generateOpenApiArtifact()
      await writeFile(artifactPath, generated, 'utf8')
      const fixedTime = new Date('2000-01-01T00:00:00.000Z')
      await utimes(artifactPath, fixedTime, fixedTime)
      const currentBefore = await stat(artifactPath)
      await expect(checkOpenApiDrift(artifactPath)).resolves.toBeUndefined()
      const currentAfter = await stat(artifactPath)
      expect(currentAfter.mtimeMs).toBe(currentBefore.mtimeMs)
      expect(await readFile(artifactPath, 'utf8')).toBe(generated)

      await writeFile(artifactPath, '{}\n', 'utf8')
      await utimes(artifactPath, fixedTime, fixedTime)
      const staleBefore = await stat(artifactPath)
      await expect(checkOpenApiDrift(artifactPath)).rejects.toThrow(
        'OpenAPI artifact drift detected',
      )
      const staleAfter = await stat(artifactPath)
      expect(staleAfter.mtimeMs).toBe(staleBefore.mtimeMs)
      expect(await readFile(artifactPath, 'utf8')).toBe('{}\n')
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
