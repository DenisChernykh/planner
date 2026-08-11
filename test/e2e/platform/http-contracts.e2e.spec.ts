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
  readonly headers?: Record<string, unknown>
  readonly content?: Record<
    string,
    {
      readonly schema?: unknown
      readonly examples?: Record<string, unknown>
    }
  >
}

interface OpenApiParameter {
  readonly name?: string
  readonly in?: string
  readonly required?: boolean
  readonly description?: string
  readonly schema?: {
    readonly type?: string
    readonly pattern?: string
    readonly minLength?: number
    readonly maxLength?: number
    readonly enum?: readonly string[]
  }
}

interface OpenApiSchema {
  readonly $ref?: string
  readonly type?: string
  readonly pattern?: string
  readonly minLength?: number
  readonly maxLength?: number
  readonly enum?: readonly string[]
  readonly example?: unknown
  readonly additionalProperties?: boolean
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
  readonly oneOf?: readonly OpenApiSchema[]
}

interface OpenApiOperation {
  readonly responses?: Record<string, OpenApiResponse>
  readonly security?: readonly Record<string, readonly unknown[]>[]
  readonly parameters?: readonly OpenApiParameter[]
  readonly requestBody?: {
    readonly required?: boolean
    readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
  }
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

  it('publishes the exact committed production HTTP graph, request schemas and finite Problem union', async () => {
    // In-process metadata that is absent from the committed tsx artifact must fail.
    const document = JSON.parse(
      await readFile('docs/api/openapi.json', 'utf8'),
    ) as {
      paths: Record<
        string,
        {
          get?: OpenApiOperation
          post?: OpenApiOperation
        }
      >
      components?: {
        schemas?: Record<string, OpenApiSchema>
        securitySchemes?: Record<string, unknown>
      }
    }
    expect(Object.keys(document.paths).sort()).toEqual([
      '/auth/csrf',
      '/auth/logout',
      '/auth/me',
      '/auth/telegram/callback',
      '/auth/telegram/start',
      '/health/live',
      '/health/ready',
      '/health/startup',
      '/planning/catalog/goal-definitions',
      '/planning/catalog/goal-definitions/{goalDefinitionId}',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/archive',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/copy',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/restore',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/versions',
    ])
    expect(document.paths['/auth/issue']).toBeUndefined()
    expect(Object.keys(document.paths['/auth/me'] ?? {})).toEqual(['get'])
    expect(Object.keys(document.paths['/auth/csrf'] ?? {})).toEqual(['get'])
    expect(Object.keys(document.paths['/auth/logout'] ?? {})).toEqual(['post'])
    expect(
      Object.keys(document.paths['/auth/telegram/callback'] ?? {}),
    ).toEqual(['get'])
    expect(Object.keys(document.paths['/auth/telegram/start'] ?? {})).toEqual([
      'get',
    ])
    expect(
      Object.keys(
        document.paths['/auth/telegram/callback']?.get?.responses ?? {},
      ).sort(),
    ).toEqual(['303', '400', '401', '403', '413', '422', '503'])
    expect(document.paths['/auth/telegram/callback']?.get?.security).toEqual([])
    const callbackParameters =
      document.paths['/auth/telegram/callback']?.get?.parameters ?? []
    expect(callbackParameters.map(({ name }) => name).sort()).toEqual([
      'code',
      'error',
      'error_description',
      'error_uri',
      'state',
    ])
    expect(
      Object.fromEntries(
        callbackParameters.map(({ name, ...parameter }) => [name, parameter]),
      ),
    ).toEqual({
      state: {
        in: 'query',
        required: true,
        description:
          'Canonical OIDC state. Required for both success and OAuth error callbacks.',
        schema: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{43}$',
          minLength: 43,
          maxLength: 43,
        },
      },
      code: {
        in: 'query',
        required: false,
        description: 'Authorization code. Supply exactly one of code or error.',
        schema: {
          type: 'string',
          pattern: '^[\\x21-\\x7E]+$',
          minLength: 1,
          maxLength: 4_096,
        },
      },
      error: {
        in: 'query',
        required: false,
        description: 'OAuth error. Supply exactly one of error or code.',
        schema: {
          type: 'string',
          pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]+$',
          minLength: 1,
          maxLength: 128,
        },
      },
      error_description: {
        in: 'query',
        required: false,
        description:
          'Optional OAuth error description; allowed only with error and ignored by Planner.',
        schema: {
          type: 'string',
          pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]*$',
          minLength: 0,
          maxLength: 1_024,
        },
      },
      error_uri: {
        in: 'query',
        required: false,
        description:
          'Optional OAuth error URI; allowed only with error and ignored by Planner.',
        schema: {
          type: 'string',
          pattern: '^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]*$',
          minLength: 0,
          maxLength: 2_048,
        },
      },
    })
    expect(
      document.paths['/auth/telegram/callback']?.get?.responses?.['303']
        ?.headers,
    ).toEqual({
      'Cache-Control': { schema: { enum: ['no-store'], type: 'string' } },
      Location: {
        description: 'Fixed relative Planner destination.',
        schema: { enum: ['/'], type: 'string' },
      },
      Pragma: { schema: { enum: ['no-cache'], type: 'string' } },
      'Referrer-Policy': {
        schema: { enum: ['no-referrer'], type: 'string' },
      },
      'Set-Cookie': {
        description: 'Local session cookie and cleared OIDC state cookie.',
        schema: {
          items: { type: 'string' },
          maxItems: 2,
          minItems: 2,
          type: 'array',
        },
      },
      'X-Request-ID': {
        description: 'Trusted request correlation ID.',
        schema: { type: 'string' },
      },
    })
    expect(
      document.paths['/auth/telegram/callback']?.get?.responses?.['422']
        ?.content?.['application/problem+json']?.examples,
    ).toEqual({
      VALIDATION_FAILED: {
        summary: 'Validation failed',
        value: {
          type: 'https://planner.invalid/problems/validation-failed',
          title: 'Validation failed',
          status: 422,
          detail: 'One or more request fields are invalid.',
          instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          code: 'VALIDATION_FAILED',
          requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          errors: [
            {
              pointer: '/query',
              code: 'invalid_value',
              detail: 'OIDC callback query is invalid.',
            },
          ],
        },
      },
    })
    expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(
      expect.arrayContaining([
        'ProblemFieldErrorResponseDto',
        'ProblemResponseDto',
        'ValidationProblemResponseDto',
      ]),
    )
    const exactBaseProblemCodes = [
      'AUTHENTICATION_REQUIRED',
      'AUTHORIZATION_DENIED',
      'COMMAND_FINGERPRINT_CONFLICT',
      'CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'GOAL_DEFINITION_NOT_FOUND',
      'INTERNAL_ERROR',
      'MALFORMED_REQUEST',
      'NOT_FOUND',
      'OIDC_ACCESS_DENIED',
      'OIDC_LOGIN_REJECTED',
      'PAYLOAD_TOO_LARGE',
      'PLANNING_AUTHORIZATION_DENIED',
      'RATE_LIMIT_EXCEEDED',
      'UNSUPPORTED_MEDIA_TYPE',
      'VALIDATION_FAILED',
    ]
    expect(
      document.components?.schemas?.['ProblemResponseDto']?.properties?.['code']
        ?.enum,
    ).toEqual(exactBaseProblemCodes)
    expect(
      document.components?.schemas?.['ValidationProblemResponseDto']
        ?.properties?.['conflict'],
    ).toBeUndefined()
    expect(
      document.components?.schemas?.['ProblemResponseDto']?.properties?.[
        'conflict'
      ],
    ).toBeUndefined()
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

    const catalogCollection =
      document.paths['/planning/catalog/goal-definitions']
    expect(Object.keys(catalogCollection ?? {}).sort()).toEqual(['get', 'post'])
    expect(catalogCollection?.get?.security).toEqual([{ sessionCookie: [] }])
    expect(catalogCollection?.post?.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(Object.keys(catalogCollection?.get?.responses ?? {}).sort()).toEqual(
      ['200', '401', '403', '422', '503'],
    )
    expect(
      Object.keys(catalogCollection?.post?.responses ?? {}).sort(),
    ).toEqual(['201', '400', '401', '403', '409', '413', '415', '422', '503'])
    expect(catalogCollection?.get?.parameters).toEqual([
      {
        in: 'query',
        name: 'state',
        required: false,
        schema: {
          enum: ['active', 'archived', 'all'],
          type: 'string',
        },
      },
    ])
    for (const suffix of ['versions', 'copy']) {
      expect(
        Object.keys(
          document.paths[
            `/planning/catalog/goal-definitions/{goalDefinitionId}/${suffix}`
          ]?.post?.responses ?? {},
        ).sort(),
      ).toEqual([
        '201',
        '400',
        '401',
        '403',
        '404',
        '409',
        '413',
        '415',
        '422',
        '503',
      ])
    }
    for (const suffix of ['archive', 'restore']) {
      expect(
        Object.keys(
          document.paths[
            `/planning/catalog/goal-definitions/{goalDefinitionId}/${suffix}`
          ]?.post?.responses ?? {},
        ).sort(),
      ).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '409',
        '413',
        '415',
        '422',
        '503',
      ])
    }
    const schemas = document.components?.schemas ?? {}
    const uuidPattern =
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    const uuidSchema = { pattern: uuidPattern, type: 'string' }
    const revisionSchema = { pattern: '^[1-9][0-9]*$', type: 'string' }
    const metadataProperties = {
      category: {
        maxLength: 100,
        minLength: 1,
        pattern: '\\S',
        type: 'string',
      },
      title: {
        maxLength: 200,
        minLength: 1,
        pattern: '\\S',
        type: 'string',
      },
      why: {
        maxLength: 2_000,
        minLength: 1,
        pattern: '\\S',
        type: 'string',
      },
    }
    const requestSchemas: ReadonlyArray<{
      readonly path: string
      readonly schema: OpenApiSchema
    }> = [
      {
        path: '/planning/catalog/goal-definitions',
        schema: {
          additionalProperties: false,
          properties: { commandId: uuidSchema, ...metadataProperties },
          required: ['commandId', 'title', 'why', 'category'],
          type: 'object',
        },
      },
      {
        path: '/planning/catalog/goal-definitions/{goalDefinitionId}/versions',
        schema: {
          additionalProperties: false,
          properties: {
            commandId: uuidSchema,
            ...metadataProperties,
            expectedRevision: revisionSchema,
            seriesDecision: {
              enum: ['continue', 'new'],
              type: 'string',
            },
          },
          required: [
            'commandId',
            'title',
            'why',
            'category',
            'expectedRevision',
            'seriesDecision',
          ],
          type: 'object',
        },
      },
      ...['archive', 'restore', 'copy'].map((suffix) => ({
        path: `/planning/catalog/goal-definitions/{goalDefinitionId}/${suffix}`,
        schema: {
          additionalProperties: false,
          properties: {
            commandId: uuidSchema,
            expectedRevision: revisionSchema,
          },
          required: ['commandId', 'expectedRevision'],
          type: 'object',
        },
      })),
    ]
    for (const { path, schema } of requestSchemas) {
      expect(document.paths[path]?.post?.requestBody).toEqual({
        content: { 'application/json': { schema } },
        required: true,
      })
    }
    for (const path of [
      '/planning/catalog/goal-definitions/{goalDefinitionId}',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/archive',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/copy',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/restore',
      '/planning/catalog/goal-definitions/{goalDefinitionId}/versions',
    ]) {
      const operation = path.endsWith('goalDefinitionId}')
        ? document.paths[path]?.get
        : document.paths[path]?.post
      const parameter = operation?.parameters?.find(
        (candidate) => candidate.name === 'goalDefinitionId',
      )
      expect(parameter).toMatchObject({
        in: 'path',
        name: 'goalDefinitionId',
        required: true,
        schema: uuidSchema,
      })
    }
    expect(schemas['GoalDefinitionResultResponseDto']).toMatchObject({
      properties: {
        aggregateRevision: { pattern: '^[1-9][0-9]*$', type: 'string' },
      },
    })
    expect(schemas['ProblemConflictResponseDto']).toMatchObject({
      properties: {
        currentRevision: { pattern: '^[1-9][0-9]*$', type: 'string' },
        currentState: { enum: ['active', 'archived'] },
        nextAction: { enum: ['reload-goal-definition-and-retry'] },
      },
      required: ['currentRevision', 'currentState', 'nextAction'],
    })
    expect(schemas['GoalDefinitionConflictProblemResponseDto']).toMatchObject({
      properties: {
        code: {
          enum: [
            'GOAL_DEFINITION_REVISION_CONFLICT',
            'GOAL_DEFINITION_STATE_CONFLICT',
          ],
          example: 'GOAL_DEFINITION_REVISION_CONFLICT',
        },
        conflict: { $ref: '#/components/schemas/ProblemConflictResponseDto' },
      },
      required: [
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'code',
        'requestId',
        'conflict',
      ],
    })
    const baseProblemRef = { $ref: '#/components/schemas/ProblemResponseDto' }
    const conflictProblemRef = {
      $ref: '#/components/schemas/GoalDefinitionConflictProblemResponseDto',
    }
    expect(
      catalogCollection?.post?.responses?.['409']?.content?.[
        'application/problem+json'
      ]?.schema,
    ).toEqual(baseProblemRef)
    for (const suffix of ['versions', 'archive', 'restore', 'copy']) {
      expect(
        document.paths[
          `/planning/catalog/goal-definitions/{goalDefinitionId}/${suffix}`
        ]?.post?.responses?.['409']?.content?.['application/problem+json']
          ?.schema,
      ).toEqual({ oneOf: [baseProblemRef, conflictProblemRef] })
    }
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
