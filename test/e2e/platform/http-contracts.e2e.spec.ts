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
  readonly format?: string
  readonly minLength?: number
  readonly maxLength?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly maxItems?: number
  readonly nullable?: boolean
  readonly enum?: readonly (string | null)[]
  readonly example?: unknown
  readonly additionalProperties?: boolean
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
  readonly oneOf?: readonly OpenApiSchema[]
  readonly allOf?: readonly OpenApiSchema[]
  readonly items?: OpenApiSchema
  readonly discriminator?: {
    readonly propertyName?: string
    readonly mapping?: Record<string, string>
  }
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

  it('keeps platform OpenAPI composition vocabulary-free and installs planning schemas only through its module contribution', async () => {
    const [platformSource, planningSource] = await Promise.all([
      readFile('src/platform/http/docs/openapi-document.ts', 'utf8'),
      readFile(
        'src/modules/planning/presentation/planning-openapi.contribution.ts',
        'utf8',
      ),
    ])
    expect(platformSource).not.toMatch(
      /DraftGoalConfigV1|StoredDraftGoalConfigV1|Versioned goal catalog|GoalDefinitionConflict|DraftConflict/u,
    )
    expect(platformSource).toContain('OpenApiDocumentContribution')
    expect(planningSource).toContain('AddDraftGoalConfigV1')
    expect(planningSource).toContain('StoredDraftGoalConfigV1')

    const generic = createOpenApiDocument(
      app,
      createOpenApiRuntimeConfig(),
      app.get(HttpProblemRegistry).definitions,
    )
    expect(generic.tags?.map((tag) => tag.name)).not.toContain('planning')
    expect(
      generic.components?.schemas?.['AddDraftGoalConfigV1'],
    ).toBeUndefined()
    expect(
      generic.components?.schemas?.['StoredDraftGoalConfigV1'],
    ).toBeUndefined()

    const composed = JSON.parse(await generateOpenApiArtifact()) as {
      readonly tags?: readonly { readonly name?: string }[]
      readonly components?: { readonly schemas?: Record<string, unknown> }
    }
    expect(composed.tags?.map((tag) => tag.name)).toContain('planning')
    expect(composed.components?.schemas).toEqual(
      expect.objectContaining({
        AddDraftGoalConfigV1: expect.any(Object) as unknown,
        UpdateDraftGoalConfigV1: expect.any(Object) as unknown,
        StoredDraftGoalConfigV1: expect.any(Object) as unknown,
      }),
    )
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
      '/planning/drafts',
      '/planning/drafts/empty',
      '/planning/drafts/from-publication',
      '/planning/drafts/from-seed',
      '/planning/drafts/publication-preview',
      '/planning/drafts/{planMonthId}/focus',
      '/planning/drafts/{planMonthId}/goals',
      '/planning/drafts/{planMonthId}/goals/reorder',
      '/planning/drafts/{planMonthId}/goals/{planGoalId}/remove',
      '/planning/drafts/{planMonthId}/goals/{planGoalId}/update',
      '/planning/drafts/{planMonthId}/publish',
      '/planning/months',
      '/planning/months/active',
      '/planning/months/{planMonthId}/reclose',
      '/planning/months/{planMonthId}/reopen',
      '/planning/publications/{publicationId}',
      '/reminders/delivery-status',
      '/reminders/settings',
      '/reporting/months/{targetMonth}',
      '/tracking/facts',
      '/tracking/facts/checklist-item',
      '/tracking/facts/checkpoint',
      '/tracking/facts/composite-occurrence',
      '/tracking/facts/or-variant',
      '/tracking/facts/rating',
      '/tracking/facts/text',
      '/tracking/facts/time',
      '/tracking/facts/{factRecordId}/correct',
      '/tracking/facts/{factRecordId}/delete',
      '/tracking/facts/{factRecordId}/undo',
      '/tracking/months/{targetMonth}',
      '/tracking/publications/{publicationId}/days/{localDate}/close',
      '/tracking/publications/{publicationId}/days/{localDate}/close-preview',
      '/tracking/publications/{publicationId}/weekly-tasks/{flexiblePeriodId}/result',
      '/tracking/today',
      '/workspace/current',
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
        'ExistingPlanMonthConflictResponseDto',
        'PlanMonthAlreadyExistsConflictResponseDto',
        'PlanMonthAlreadyExistsProblemResponseDto',
        'ProblemFieldErrorResponseDto',
        'ProblemResponseDto',
        'ValidationProblemResponseDto',
      ]),
    )
    const exactBaseProblemCodes = [
      'ACTIVE_PLAN_MONTH_NOT_FOUND',
      'AUTHENTICATION_REQUIRED',
      'AUTHORIZATION_DENIED',
      'COMMAND_FINGERPRINT_CONFLICT',
      'CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'DRAFT_GOAL_NOT_FOUND',
      'GOAL_DEFINITION_NOT_FOUND',
      'GOAL_DEFINITION_VERSION_NOT_FOUND',
      'INTERNAL_ERROR',
      'MALFORMED_REQUEST',
      'NOT_FOUND',
      'OIDC_ACCESS_DENIED',
      'OIDC_LOGIN_REJECTED',
      'PAYLOAD_TOO_LARGE',
      'PLANNING_AUTHORIZATION_DENIED',
      'PLAN_DRAFT_NOT_EDITABLE',
      'PLAN_DRAFT_NOT_FOUND',
      'PLAN_MONTH_NOT_FOUND',
      'PLAN_MONTH_RECLOSE_CONFLICT',
      'PLAN_MONTH_REOPEN_CONFLICT',
      'PLAN_MONTH_REVISION_CONFLICT',
      'PLAN_PUBLICATION_NOT_FOUND',
      'PLAN_SEED_ALREADY_CONSUMED',
      'RATE_LIMIT_EXCEEDED',
      'REMINDER_AUTHORIZATION_DENIED',
      'REPORTING_AUTHORIZATION_DENIED',
      'REPORTING_NOT_FOUND',
      'REPORTING_QUERY_INVALID',
      'REPORTING_SOURCE_CHANGED',
      'TRACKING_AUTHORIZATION_DENIED',
      'TRACKING_CLOSE_DAY_TARGET_NOT_FOUND',
      'TRACKING_FACT_TARGET_NOT_FOUND',
      'TRACKING_FACT_VALUE_INVALID',
      'TRACKING_QUERY_INVALID',
      'TRACKING_WEEKLY_TASK_TARGET_NOT_FOUND',
      'UNSUPPORTED_MEDIA_TYPE',
      'WORKSPACE_AUTHORIZATION_DENIED',
      'WORKSPACE_STATE_CONFLICT',
    ]
    expect(
      document.components?.schemas?.['ProblemResponseDto']?.properties?.['code']
        ?.enum,
    ).toEqual(exactBaseProblemCodes)
    expect(
      document.components?.schemas?.['ValidationProblemResponseDto']
        ?.properties?.['code']?.enum,
    ).toEqual(['VALIDATION_FAILED'])
    expect(
      document.components?.schemas?.['ValidationProblemResponseDto']
        ?.properties?.['conflict'],
    ).toBeUndefined()
    expect(
      document.components?.schemas?.['ProblemResponseDto']?.properties?.[
        'conflict'
      ],
    ).toBeUndefined()
    const existingMonthProblem =
      document.components?.schemas?.['PlanMonthAlreadyExistsProblemResponseDto']
    expect(existingMonthProblem).toMatchObject({
      properties: {
        code: {
          enum: ['PLAN_MONTH_ALREADY_EXISTS'],
          example: 'PLAN_MONTH_ALREADY_EXISTS',
        },
        conflict: {
          $ref: '#/components/schemas/PlanMonthAlreadyExistsConflictResponseDto',
        },
      },
    })
    expect(existingMonthProblem?.required).toEqual(
      expect.arrayContaining([
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'code',
        'requestId',
        'conflict',
      ]),
    )
    expect(
      document.components?.schemas?.[
        'PlanMonthAlreadyExistsConflictResponseDto'
      ],
    ).toMatchObject({
      properties: {
        existingRef: {
          $ref: '#/components/schemas/ExistingPlanMonthConflictResponseDto',
        },
        nextAction: { enum: ['open-existing-month'] },
      },
      required: ['existingRef', 'nextAction'],
    })
    expect(
      document.components?.schemas?.['ExistingPlanMonthConflictResponseDto'],
    ).toMatchObject({
      properties: {
        kind: { enum: ['planning.plan-draft.v1'] },
        aggregateId: { format: 'uuid', type: 'string' },
        aggregateRevision: { pattern: '^[1-9][0-9]*$', type: 'string' },
      },
      required: ['kind', 'aggregateId', 'aggregateRevision'],
    })
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

    const drafts = document.paths['/planning/drafts']
    const emptyDraft = document.paths['/planning/drafts/empty']
    const copyDraft = document.paths['/planning/drafts/from-publication']
    const publicationPreview =
      document.paths['/planning/drafts/publication-preview']
    const draftAdd = document.paths['/planning/drafts/{planMonthId}/goals']
    const draftUpdate =
      document.paths['/planning/drafts/{planMonthId}/goals/{planGoalId}/update']
    const draftRemove =
      document.paths['/planning/drafts/{planMonthId}/goals/{planGoalId}/remove']
    const draftReorder =
      document.paths['/planning/drafts/{planMonthId}/goals/reorder']
    expect(Object.keys(drafts ?? {})).toEqual(['get'])
    expect(Object.keys(emptyDraft ?? {})).toEqual(['post'])
    expect(Object.keys(copyDraft ?? {})).toEqual(['post'])
    expect(Object.keys(publicationPreview ?? {})).toEqual(['get'])
    for (const operation of [
      draftAdd,
      draftUpdate,
      draftRemove,
      draftReorder,
    ]) {
      expect(Object.keys(operation ?? {})).toEqual(['post'])
    }
    expect(drafts?.get?.security).toEqual([{ sessionCookie: [] }])
    expect(emptyDraft?.post?.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(copyDraft?.post?.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ])
    expect(publicationPreview?.get?.security).toEqual([{ sessionCookie: [] }])
    expect(emptyDraft?.post?.requestBody).toEqual({
      content: {
        'application/json': {
          schema: {
            additionalProperties: false,
            properties: {
              commandId: uuidSchema,
              targetMonth: {
                pattern:
                  '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
                type: 'string',
              },
              focus: {
                maxLength: 500,
                minLength: 1,
                pattern: '^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$',
                type: 'string',
              },
            },
            required: ['commandId', 'targetMonth', 'focus'],
            type: 'object',
          },
        },
      },
      required: true,
    })
    expect(emptyDraft?.post?.responses?.['201']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/DraftMutationResponseV1' },
        },
      },
    })
    expect(emptyDraft?.post?.responses?.['409']).toMatchObject({
      content: {
        'application/problem+json': {
          schema: {
            oneOf: [
              baseProblemRef,
              {
                $ref: '#/components/schemas/PlanMonthAlreadyExistsProblemResponseDto',
              },
            ],
          },
        },
      },
    })
    for (const operation of [
      draftAdd?.post,
      draftUpdate?.post,
      draftRemove?.post,
      draftReorder?.post,
    ]) {
      expect(operation?.security).toEqual([
        { sessionCookie: [], csrfToken: [] },
      ])
    }
    expect(Object.keys(drafts?.get?.responses ?? {}).sort()).toEqual([
      '200',
      '401',
      '403',
      '404',
      '409',
      '422',
      '503',
    ])
    expect(
      Object.keys(publicationPreview?.get?.responses ?? {}).sort(),
    ).toEqual(['200', '401', '403', '404', '409', '422', '503'])
    for (const [operation, success] of [
      [copyDraft?.post, '201'],
      [draftAdd?.post, '201'],
      [draftUpdate?.post, '200'],
      [draftRemove?.post, '200'],
      [draftReorder?.post, '200'],
    ] as const) {
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
        [
          success,
          '400',
          '401',
          '403',
          '404',
          '409',
          '413',
          '415',
          '422',
          '503',
        ].sort(),
      )
    }
    expect(drafts?.get?.parameters).toEqual([
      {
        in: 'query',
        name: 'targetMonth',
        required: true,
        schema: {
          pattern:
            '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
          type: 'string',
        },
      },
    ])
    expect(publicationPreview?.get?.parameters).toEqual([
      {
        in: 'query',
        name: 'targetMonth',
        required: true,
        schema: {
          pattern:
            '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
          type: 'string',
        },
      },
    ])
    const parameter = (
      operation: OpenApiOperation | undefined,
      name: string,
    ): OpenApiParameter | undefined =>
      operation?.parameters?.find((candidate) => candidate.name === name)
    for (const operation of [
      draftAdd?.post,
      draftUpdate?.post,
      draftRemove?.post,
      draftReorder?.post,
    ]) {
      expect(parameter(operation, 'planMonthId')).toEqual({
        in: 'path',
        name: 'planMonthId',
        required: true,
        schema: uuidSchema,
      })
    }
    for (const operation of [draftUpdate?.post, draftRemove?.post]) {
      expect(parameter(operation, 'planGoalId')).toEqual({
        in: 'path',
        name: 'planGoalId',
        required: true,
        schema: uuidSchema,
      })
    }
    const addConfigRef = {
      $ref: '#/components/schemas/AddDraftGoalConfigV1',
    }
    const updateConfigRef = {
      $ref: '#/components/schemas/UpdateDraftGoalConfigV1',
    }
    const provenanceRef = {
      allOf: [{ $ref: '#/components/schemas/SourceProvenanceV1' }],
      nullable: true,
      type: 'object',
    }
    const commandProperties = {
      commandId: uuidSchema,
      expectedRevision: revisionSchema,
    }
    const exactRequestBody = (schema: OpenApiSchema): object => ({
      content: { 'application/json': { schema } },
      required: true,
    })
    expect(copyDraft?.post?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: {
          commandId: uuidSchema,
          sourcePublicationId: uuidSchema,
          targetMonth: {
            pattern:
              '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
            type: 'string',
          },
        },
        required: ['commandId', 'sourcePublicationId', 'targetMonth'],
        type: 'object',
      }),
    )
    expect(copyDraft?.post?.responses?.['201']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/DraftMutationResponseV1' },
        },
      },
    })
    expect(
      copyDraft?.post?.responses?.['404']?.content?.['application/problem+json']
        ?.examples,
    ).toHaveProperty('PLAN_PUBLICATION_NOT_FOUND')
    expect(copyDraft?.post?.responses?.['409']).toMatchObject({
      content: {
        'application/problem+json': {
          schema: {
            oneOf: [
              baseProblemRef,
              {
                $ref: '#/components/schemas/PlanMonthAlreadyExistsProblemResponseDto',
              },
            ],
          },
        },
      },
    })
    expect(draftAdd?.post?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: {
          ...commandProperties,
          goalDefinitionId: uuidSchema,
          config: addConfigRef,
          sourceProvenance: provenanceRef,
        },
        required: [
          'commandId',
          'expectedRevision',
          'goalDefinitionId',
          'config',
          'sourceProvenance',
        ],
        type: 'object',
      }),
    )
    expect(draftUpdate?.post?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: {
          ...commandProperties,
          goalDefinitionVersionId: uuidSchema,
          config: updateConfigRef,
          sourceProvenance: provenanceRef,
        },
        required: [
          'commandId',
          'expectedRevision',
          'goalDefinitionVersionId',
          'config',
          'sourceProvenance',
        ],
        type: 'object',
      }),
    )
    expect(draftRemove?.post?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: commandProperties,
        required: ['commandId', 'expectedRevision'],
        type: 'object',
      }),
    )
    expect(draftReorder?.post?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: {
          ...commandProperties,
          orderedPlanGoalIds: {
            items: uuidSchema,
            maxItems: 200,
            type: 'array',
          },
        },
        required: ['commandId', 'expectedRevision', 'orderedPlanGoalIds'],
        type: 'object',
      }),
    )
    expect(
      drafts?.get?.responses?.['200']?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/DraftEditorResponseV1' })
    expect(
      publicationPreview?.get?.responses?.['200']?.content?.['application/json']
        ?.schema,
    ).toEqual({ $ref: '#/components/schemas/PublicationPreviewResponseV1' })
    for (const [operation, success] of [
      [draftAdd?.post, '201'],
      [draftUpdate?.post, '200'],
      [draftRemove?.post, '200'],
      [draftReorder?.post, '200'],
    ] as const) {
      expect(
        operation?.responses?.[success]?.content?.['application/json']?.schema,
      ).toEqual({ $ref: '#/components/schemas/DraftMutationResponseV1' })
    }
    expect(schemas['DraftMutationResponseV1']).toEqual({
      additionalProperties: false,
      properties: {
        kind: { enum: ['planning.plan-draft.v1'], type: 'string' },
        aggregateId: uuidSchema,
        aggregateRevision: revisionSchema,
      },
      required: ['kind', 'aggregateId', 'aggregateRevision'],
      type: 'object',
    })
    expect(schemas['DraftEditorResponseV1']).toEqual({
      additionalProperties: false,
      properties: {
        planMonthId: uuidSchema,
        spaceId: uuidSchema,
        targetMonth: {
          pattern:
            '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
          type: 'string',
        },
        status: { enum: ['draft'], type: 'string' },
        focus: {
          maxLength: 500,
          minLength: 1,
          pattern: '\\S',
          type: 'string',
        },
        planMonthRevision: revisionSchema,
        draftRevision: revisionSchema,
        goals: {
          items: { $ref: '#/components/schemas/DraftGoalViewV1' },
          maxItems: 200,
          type: 'array',
        },
        blockers: {
          items: { $ref: '#/components/schemas/PublishBlockerV1' },
          type: 'array',
        },
      },
      required: [
        'planMonthId',
        'spaceId',
        'targetMonth',
        'status',
        'focus',
        'planMonthRevision',
        'draftRevision',
        'goals',
        'blockers',
      ],
      type: 'object',
    })
    expect(schemas['DraftGoalViewV1']).toMatchObject({
      additionalProperties: false,
      properties: {
        planGoalId: uuidSchema,
        goalDefinitionId: uuidSchema,
        goalDefinitionVersionId: uuidSchema,
        goalSeriesId: uuidSchema,
        displayOrder: { maximum: 199, minimum: 0, type: 'integer' },
        configRevision: revisionSchema,
        config: { $ref: '#/components/schemas/StoredDraftGoalConfigV1' },
        blockers: {
          items: { $ref: '#/components/schemas/PublishBlockerV1' },
          type: 'array',
        },
      },
      required: [
        'planGoalId',
        'goalDefinitionId',
        'goalDefinitionVersionId',
        'goalSeriesId',
        'title',
        'why',
        'category',
        'displayOrder',
        'configRevision',
        'config',
        'sourceProvenance',
        'blockers',
      ],
      type: 'object',
    })
    expect(schemas['PublishBlockerV1']).toEqual({
      additionalProperties: false,
      properties: {
        planGoalId: uuidSchema,
        pointer: {
          pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
          type: 'string',
        },
        code: {
          enum: ['required', 'empty_collection', 'incompatible'],
          type: 'string',
        },
        detail: {
          enum: [
            'Required value is missing.',
            'At least one item is required.',
            'Values are incompatible.',
          ],
          type: 'string',
        },
      },
      required: ['planGoalId', 'pointer', 'code', 'detail'],
      type: 'object',
    })

    const dateSchema = { format: 'date', type: 'string' }
    const targetMonthSchema = {
      pattern:
        '^(?:[1-9][0-9]{3}|0[1-9][0-9]{2}|00[1-9][0-9]|000[1-9])-(?:0[1-9]|1[0-2])$',
      type: 'string',
    }
    const calendarContextProperties = {
      targetMonth: targetMonthSchema,
      activeLocalDate: dateSchema,
      timeZone: { enum: ['Asia/Yekaterinburg'], type: 'string' },
    }
    const quotaPeriodProperties = {
      ordinal: { maximum: 6, minimum: 1, type: 'integer' },
      periodStart: dateSchema,
      periodEnd: dateSchema,
      activeDates: { items: dateSchema, maxItems: 31, type: 'array' },
      eligibleDates: { items: dateSchema, maxItems: 31, type: 'array' },
      periodTarget: { maximum: 31, minimum: 0, type: 'integer' },
    }
    const quotaPeriodRequired = [
      'cadence',
      'ordinal',
      'periodStart',
      'periodEnd',
      'periodDays',
      'activeDates',
      'eligibleDates',
      'periodTarget',
    ]
    const quotaCalendarRequired = [
      'targetMonth',
      'activeLocalDate',
      'timeZone',
      'kind',
      'cadence',
      'periods',
    ]
    expect(schemas['PublicationPreviewGoalBlockerV1']).toEqual({
      additionalProperties: false,
      properties: {
        planGoalId: uuidSchema,
        pointer: {
          pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
          type: 'string',
        },
        code: {
          enum: ['required', 'empty_collection', 'incompatible'],
          type: 'string',
        },
        detail: {
          enum: [
            'Required value is missing.',
            'At least one item is required.',
            'Values are incompatible.',
            'due date is outside target month',
            'week ordinal is not present in target month',
          ],
          type: 'string',
        },
      },
      required: ['planGoalId', 'pointer', 'code', 'detail'],
      type: 'object',
    })
    expect(schemas['PublicationPreviewBlockerV1']).toEqual({
      additionalProperties: false,
      properties: {
        planGoalId: { ...uuidSchema, nullable: true },
        pointer: {
          pattern: '^(?:/(?:[^~/]|~0|~1)*)+$',
          type: 'string',
        },
        code: {
          enum: ['required', 'empty_collection', 'incompatible'],
          type: 'string',
        },
        detail: {
          enum: [
            'Required value is missing.',
            'At least one item is required.',
            'Values are incompatible.',
            'due date is outside target month',
            'week ordinal is not present in target month',
            'Target month is not current or next.',
            'Publication materialization exceeds 10000 rows.',
          ],
          type: 'string',
        },
      },
      required: ['planGoalId', 'pointer', 'code', 'detail'],
      type: 'object',
    })
    expect(schemas['PublicationPreviewActivationV1']).toEqual({
      additionalProperties: false,
      properties: {
        mode: {
          enum: ['immediate', 'scheduled', 'blocked'],
          type: 'string',
        },
        activeLocalDate: {
          format: 'date',
          pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$',
          type: 'string',
        },
        latePublication: { type: 'boolean' },
      },
      required: ['mode', 'activeLocalDate', 'latePublication'],
      type: 'object',
    })
    expect(schemas['FixedEligibleCalendarV1']).toEqual({
      additionalProperties: false,
      properties: {
        ...calendarContextProperties,
        kind: { enum: ['fixed'], type: 'string' },
        expectationDates: {
          items: dateSchema,
          maxItems: 31,
          type: 'array',
        },
      },
      required: [
        'targetMonth',
        'activeLocalDate',
        'timeZone',
        'kind',
        'expectationDates',
      ],
      type: 'object',
    })
    expect(schemas['WeeklyQuotaCalendarPeriodV1']).toEqual({
      additionalProperties: false,
      properties: {
        cadence: { enum: ['weekly'], type: 'string' },
        ...quotaPeriodProperties,
        periodDays: { enum: [7], type: 'integer' },
      },
      required: quotaPeriodRequired,
      type: 'object',
    })
    expect(schemas['MonthlyQuotaCalendarPeriodV1']).toEqual({
      additionalProperties: false,
      properties: {
        cadence: { enum: ['monthly'], type: 'string' },
        ...quotaPeriodProperties,
        ordinal: { enum: [1], type: 'integer' },
        periodDays: { maximum: 31, minimum: 28, type: 'integer' },
      },
      required: quotaPeriodRequired,
      type: 'object',
    })
    expect(schemas['WeeklyQuotaEligibleCalendarV1']).toEqual({
      additionalProperties: false,
      properties: {
        ...calendarContextProperties,
        kind: { enum: ['quota'], type: 'string' },
        cadence: { enum: ['weekly'], type: 'string' },
        periods: {
          items: {
            $ref: '#/components/schemas/WeeklyQuotaCalendarPeriodV1',
          },
          maxItems: 6,
          minItems: 4,
          type: 'array',
        },
      },
      required: quotaCalendarRequired,
      type: 'object',
    })
    expect(schemas['MonthlyQuotaEligibleCalendarV1']).toEqual({
      additionalProperties: false,
      properties: {
        ...calendarContextProperties,
        kind: { enum: ['quota'], type: 'string' },
        cadence: { enum: ['monthly'], type: 'string' },
        periods: {
          items: {
            $ref: '#/components/schemas/MonthlyQuotaCalendarPeriodV1',
          },
          maxItems: 1,
          minItems: 1,
          type: 'array',
        },
      },
      required: quotaCalendarRequired,
      type: 'object',
    })
    expect(schemas['QuotaEligibleCalendarV1']).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/WeeklyQuotaEligibleCalendarV1' },
        { $ref: '#/components/schemas/MonthlyQuotaEligibleCalendarV1' },
      ],
    })
    expect(schemas['WeeklyPlannedTaskPeriodV1']).toEqual({
      additionalProperties: false,
      properties: {
        cadence: { enum: ['weekly'], type: 'string' },
        ordinal: { maximum: 5, minimum: 1, type: 'integer' },
        periodStart: dateSchema,
        periodEnd: dateSchema,
        periodTarget: { enum: [1], type: 'integer' },
      },
      required: [
        'cadence',
        'ordinal',
        'periodStart',
        'periodEnd',
        'periodTarget',
      ],
      type: 'object',
    })
    expect(schemas['WeeklyPlannedTaskEligibleCalendarV1']).toEqual({
      additionalProperties: false,
      properties: {
        ...calendarContextProperties,
        kind: { enum: ['weekly_planned_task'], type: 'string' },
        periods: {
          items: {
            $ref: '#/components/schemas/WeeklyPlannedTaskPeriodV1',
          },
          maxItems: 1,
          type: 'array',
        },
      },
      required: [
        'targetMonth',
        'activeLocalDate',
        'timeZone',
        'kind',
        'periods',
      ],
      type: 'object',
    })
    expect(schemas['EligibleCalendarV1']).toEqual({
      discriminator: {
        mapping: {
          fixed: '#/components/schemas/FixedEligibleCalendarV1',
          quota: '#/components/schemas/QuotaEligibleCalendarV1',
          weekly_planned_task:
            '#/components/schemas/WeeklyPlannedTaskEligibleCalendarV1',
        },
        propertyName: 'kind',
      },
      oneOf: [
        { $ref: '#/components/schemas/FixedEligibleCalendarV1' },
        { $ref: '#/components/schemas/QuotaEligibleCalendarV1' },
        {
          $ref: '#/components/schemas/WeeklyPlannedTaskEligibleCalendarV1',
        },
      ],
    })
    expect(schemas['PublicationCalculatedTargetV1']).toEqual({
      additionalProperties: false,
      properties: {
        planGoalId: uuidSchema,
        formulaVersion: {
          enum: ['planner.calendar-targets.v1'],
          type: 'string',
        },
        calendar: { $ref: '#/components/schemas/EligibleCalendarV1' },
      },
      required: ['planGoalId', 'formulaVersion', 'calendar'],
      type: 'object',
    })
    expect(schemas['PublicationPreviewFormulaVersionsV1']).toEqual({
      additionalProperties: false,
      properties: {
        calendarTargets: {
          enum: ['planner.calendar-targets.v1'],
          type: 'string',
        },
        goalEvaluation: {
          enum: ['planner.goal-evaluation.v1'],
          type: 'string',
        },
        scoreCoverage: {
          enum: ['planner.score-coverage.v1'],
          type: 'string',
        },
      },
      required: ['calendarTargets', 'goalEvaluation', 'scoreCoverage'],
      type: 'object',
    })
    expect(schemas['PublicationPreviewGoalV1']).toEqual({
      additionalProperties: false,
      properties: {
        planGoalId: uuidSchema,
        goalDefinitionId: uuidSchema,
        goalDefinitionVersionId: uuidSchema,
        goalSeriesId: uuidSchema,
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
        category: {
          maxLength: 100,
          minLength: 1,
          pattern: '\\S',
          type: 'string',
        },
        displayOrder: { maximum: 199, minimum: 0, type: 'integer' },
        configRevision: revisionSchema,
        config: { $ref: '#/components/schemas/StoredDraftGoalConfigV1' },
        sourceProvenance: {
          allOf: [{ $ref: '#/components/schemas/SourceProvenanceV1' }],
          nullable: true,
          type: 'object',
        },
        blockers: {
          items: {
            $ref: '#/components/schemas/PublicationPreviewGoalBlockerV1',
          },
          type: 'array',
        },
      },
      required: [
        'planGoalId',
        'goalDefinitionId',
        'goalDefinitionVersionId',
        'goalSeriesId',
        'title',
        'why',
        'category',
        'displayOrder',
        'configRevision',
        'config',
        'sourceProvenance',
        'blockers',
      ],
      type: 'object',
    })
    expect(schemas['PublicationPreviewResponseV1']).toEqual({
      additionalProperties: false,
      properties: {
        schemaVersion: {
          enum: ['planner.publication-preview.v1'],
          type: 'string',
        },
        planMonthId: uuidSchema,
        spaceId: uuidSchema,
        targetMonth: targetMonthSchema,
        status: { enum: ['draft'], type: 'string' },
        planMonthRevision: revisionSchema,
        draftRevision: revisionSchema,
        previewHashVersion: {
          enum: ['planner.publication-preview-hash.v1'],
          type: 'string',
        },
        previewHash: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        activation: {
          $ref: '#/components/schemas/PublicationPreviewActivationV1',
        },
        focus: {
          maxLength: 500,
          minLength: 1,
          pattern: '\\S',
          type: 'string',
        },
        goals: {
          items: { $ref: '#/components/schemas/PublicationPreviewGoalV1' },
          maxItems: 200,
          type: 'array',
        },
        calculatedTargets: {
          items: { $ref: '#/components/schemas/PublicationCalculatedTargetV1' },
          maxItems: 200,
          type: 'array',
        },
        blockers: {
          items: { $ref: '#/components/schemas/PublicationPreviewBlockerV1' },
          type: 'array',
        },
        formulaVersions: {
          $ref: '#/components/schemas/PublicationPreviewFormulaVersionsV1',
        },
      },
      required: [
        'schemaVersion',
        'planMonthId',
        'spaceId',
        'targetMonth',
        'status',
        'planMonthRevision',
        'draftRevision',
        'previewHashVersion',
        'previewHash',
        'activation',
        'focus',
        'goals',
        'calculatedTargets',
        'blockers',
        'formulaVersions',
      ],
      type: 'object',
    })

    const exactDiscriminator = (
      schemaName: string,
      branches: readonly string[],
      mapping: Readonly<Record<string, string>>,
    ): void => {
      expect(schemas[schemaName]).toEqual({
        discriminator: { mapping, propertyName: 'kind' },
        oneOf: branches.map((name) => ({
          $ref: `#/components/schemas/${name}`,
        })),
      })
    }
    exactDiscriminator(
      'DraftGoalScopeV1',
      ['PersonalGoalScopeV1', 'SharedGoalScopeV1'],
      {
        personal: '#/components/schemas/PersonalGoalScopeV1',
        shared: '#/components/schemas/SharedGoalScopeV1',
      },
    )
    exactDiscriminator(
      'DraftGoalRepetitionV1',
      [
        'DailyRepetitionV1',
        'WeekdaysRepetitionV1',
        'WeeklyRepetitionV1',
        'MonthlyRepetitionV1',
        'OneOffRepetitionV1',
        'WeeklyPlannedTaskRepetitionV1',
      ],
      {
        daily: '#/components/schemas/DailyRepetitionV1',
        weekdays: '#/components/schemas/WeekdaysRepetitionV1',
        weekly: '#/components/schemas/WeeklyRepetitionV1',
        monthly: '#/components/schemas/MonthlyRepetitionV1',
        one_off: '#/components/schemas/OneOffRepetitionV1',
        weekly_planned_task:
          '#/components/schemas/WeeklyPlannedTaskRepetitionV1',
      },
    )
    const baseMeasurementBranches = [
      'BooleanMeasurementV1',
      'QuantityMeasurementV1',
      'ActualTimeMeasurementV1',
      'RatingMeasurementV1',
      'TextMeasurementV1',
    ] as const
    for (const prefix of ['Add', 'Update', 'Stored'] as const) {
      exactDiscriminator(
        `${prefix}DraftGoalMeasurementV1`,
        [
          ...baseMeasurementBranches,
          `${prefix}ChecklistMeasurementV1`,
          `${prefix}AnyOfMeasurementV1`,
        ],
        {
          boolean: '#/components/schemas/BooleanMeasurementV1',
          quantity: '#/components/schemas/QuantityMeasurementV1',
          actual_time: '#/components/schemas/ActualTimeMeasurementV1',
          rating: '#/components/schemas/RatingMeasurementV1',
          text: '#/components/schemas/TextMeasurementV1',
          checklist: `#/components/schemas/${prefix}ChecklistMeasurementV1`,
          any_of: `#/components/schemas/${prefix}AnyOfMeasurementV1`,
        },
      )
    }
    const satisfactionBranches = [
      'BooleanCheckpointSatisfactionV1',
      'QuantityCheckpointSatisfactionV1',
      'ActualTimeCheckpointSatisfactionV1',
      'RatingCheckpointSatisfactionV1',
      'TextCheckpointSatisfactionV1',
      'ChecklistCheckpointSatisfactionV1',
      'AnyOfCheckpointSatisfactionV1',
    ] as const
    exactDiscriminator(
      'DraftGoalCheckpointSatisfactionV1',
      satisfactionBranches,
      {
        boolean: '#/components/schemas/BooleanCheckpointSatisfactionV1',
        quantity: '#/components/schemas/QuantityCheckpointSatisfactionV1',
        actual_time: '#/components/schemas/ActualTimeCheckpointSatisfactionV1',
        rating: '#/components/schemas/RatingCheckpointSatisfactionV1',
        text: '#/components/schemas/TextCheckpointSatisfactionV1',
        checklist: '#/components/schemas/ChecklistCheckpointSatisfactionV1',
        any_of: '#/components/schemas/AnyOfCheckpointSatisfactionV1',
      },
    )
    const exactRequired: Readonly<Record<string, readonly string[]>> = {
      PersonalGoalScopeV1: ['kind', 'ownerMemberId'],
      SharedGoalScopeV1: ['kind'],
      DailyRepetitionV1: ['kind'],
      WeekdaysRepetitionV1: ['kind', 'weekdays'],
      WeeklyRepetitionV1: ['kind', 'n'],
      MonthlyRepetitionV1: ['kind', 'n'],
      OneOffRepetitionV1: ['kind', 'dueDate'],
      WeeklyPlannedTaskRepetitionV1: ['kind', 'weekOrdinal', 'taskText'],
      BooleanMeasurementV1: ['kind'],
      QuantityMeasurementV1: [
        'kind',
        'mode',
        'unit',
        'precision',
        'aggregation',
        'target',
      ],
      ActualTimeMeasurementV1: ['kind', 'start', 'end'],
      RatingMeasurementV1: ['kind', 'minimum', 'maximum'],
      TextMeasurementV1: ['kind'],
      AddChecklistMeasurementV1: ['kind', 'items'],
      AddAnyOfMeasurementV1: ['kind', 'variants'],
      UpdateChecklistMeasurementV1: ['kind', 'items'],
      UpdateAnyOfMeasurementV1: ['kind', 'variants'],
      BooleanCheckpointSatisfactionV1: ['kind'],
      QuantityCheckpointSatisfactionV1: ['kind', 'target'],
      ActualTimeCheckpointSatisfactionV1: ['kind', 'start', 'end'],
      RatingCheckpointSatisfactionV1: ['kind'],
      TextCheckpointSatisfactionV1: ['kind'],
      ChecklistCheckpointSatisfactionV1: ['kind'],
      AnyOfCheckpointSatisfactionV1: ['kind'],
      AddChecklistItemV1: ['label'],
      AddAnyOfVariantV1: ['label', 'unit', 'precision', 'target'],
      UpdateChecklistItemV1: ['label'],
      UpdateAnyOfVariantV1: ['label', 'unit', 'precision', 'target'],
      AddDraftGoalCheckpointV1: ['name', 'deadline', 'satisfaction'],
      AddDraftGoalCheckpointsV1: ['aggregation', 'items'],
      AddDraftGoalConfigV1: [
        'schemaVersion',
        'scope',
        'repetition',
        'measurement',
        'checkpoints',
      ],
      UpdateDraftGoalCheckpointV1: ['name', 'deadline', 'satisfaction'],
      UpdateDraftGoalCheckpointsV1: ['aggregation', 'items'],
      UpdateDraftGoalConfigV1: [
        'schemaVersion',
        'scope',
        'repetition',
        'measurement',
        'checkpoints',
      ],
      StoredChecklistItemV1: ['itemId', 'label'],
      StoredAnyOfVariantV1: [
        'variantId',
        'label',
        'unit',
        'precision',
        'target',
      ],
      StoredChecklistMeasurementV1: ['kind', 'items'],
      StoredAnyOfMeasurementV1: ['kind', 'variants'],
      StoredDraftGoalCheckpointV1: [
        'checkpointId',
        'name',
        'deadline',
        'satisfaction',
      ],
      StoredDraftGoalCheckpointsV1: ['aggregation', 'items'],
      StoredDraftGoalConfigV1: [
        'schemaVersion',
        'scope',
        'repetition',
        'measurement',
        'checkpoints',
      ],
      SourceProvenanceV1: [
        'schemaVersion',
        'sourceDocument',
        'sourcePage',
        'rawValue',
        'rawDenominator',
        'resolution',
      ],
    }
    for (const [name, required] of Object.entries(exactRequired)) {
      expect(schemas[name]).toMatchObject({
        additionalProperties: false,
        required,
        type: 'object',
      })
    }
    expect(schemas['AddChecklistItemV1']?.properties?.['itemId']).toEqual({
      enum: [null],
    })
    expect(schemas['AddAnyOfVariantV1']?.properties?.['variantId']).toEqual({
      enum: [null],
    })
    expect(
      schemas['AddDraftGoalCheckpointV1']?.properties?.['checkpointId'],
    ).toEqual({ enum: [null] })
    for (const [schemaName, propertyName] of [
      ['UpdateChecklistItemV1', 'itemId'],
      ['UpdateAnyOfVariantV1', 'variantId'],
      ['UpdateDraftGoalCheckpointV1', 'checkpointId'],
    ] as const) {
      expect(schemas[schemaName]?.properties?.[propertyName]).toEqual({
        ...uuidSchema,
        nullable: true,
      })
    }
    for (const [schemaName, propertyName] of [
      ['StoredChecklistItemV1', 'itemId'],
      ['StoredAnyOfVariantV1', 'variantId'],
      ['StoredDraftGoalCheckpointV1', 'checkpointId'],
    ] as const) {
      expect(schemas[schemaName]?.properties?.[propertyName]).toEqual(
        uuidSchema,
      )
      expect(schemas[schemaName]?.required).toContain(propertyName)
    }
    for (const [schemaName, propertyName] of [
      ['AddChecklistItemV1', 'itemId'],
      ['AddAnyOfVariantV1', 'variantId'],
      ['AddDraftGoalCheckpointV1', 'checkpointId'],
      ['UpdateChecklistItemV1', 'itemId'],
      ['UpdateAnyOfVariantV1', 'variantId'],
      ['UpdateDraftGoalCheckpointV1', 'checkpointId'],
    ] as const) {
      expect(schemas[schemaName]?.required).not.toContain(propertyName)
    }

    const baseDraftProblemRef = {
      $ref: '#/components/schemas/ProblemResponseDto',
    }
    const draftConflictRef = {
      $ref: '#/components/schemas/DraftConflictProblemResponseDto',
    }
    for (const operation of [
      draftAdd?.post,
      draftUpdate?.post,
      draftRemove?.post,
      draftReorder?.post,
    ]) {
      expect(
        operation?.responses?.['409']?.content?.['application/problem+json']
          ?.schema,
      ).toEqual({ oneOf: [baseDraftProblemRef, draftConflictRef] })
      expect(
        Object.keys(
          operation?.responses?.['409']?.content?.['application/problem+json']
            ?.examples ?? {},
        ).sort(),
      ).toEqual([
        'COMMAND_FINGERPRINT_CONFLICT',
        'DRAFT_REVISION_CONFLICT',
        'PLAN_DRAFT_NOT_EDITABLE',
      ])
    }
    const exact404 = (
      operation: OpenApiOperation | undefined,
      codes: readonly string[],
    ): void => {
      expect(
        Object.keys(
          operation?.responses?.['404']?.content?.['application/problem+json']
            ?.examples ?? {},
        ).sort(),
      ).toEqual([...codes].sort())
    }
    exact404(draftAdd?.post, [
      'PLAN_DRAFT_NOT_FOUND',
      'GOAL_DEFINITION_VERSION_NOT_FOUND',
    ])
    exact404(draftUpdate?.post, [
      'PLAN_DRAFT_NOT_FOUND',
      'DRAFT_GOAL_NOT_FOUND',
      'GOAL_DEFINITION_VERSION_NOT_FOUND',
    ])
    exact404(draftRemove?.post, [
      'PLAN_DRAFT_NOT_FOUND',
      'DRAFT_GOAL_NOT_FOUND',
    ])
    exact404(draftReorder?.post, [
      'PLAN_DRAFT_NOT_FOUND',
      'DRAFT_GOAL_NOT_FOUND',
    ])
    expect(schemas['DraftConflictProblemResponseDto']).toMatchObject({
      properties: {
        code: {
          enum: ['DRAFT_REVISION_CONFLICT'],
          example: 'DRAFT_REVISION_CONFLICT',
        },
        conflict: {
          $ref: '#/components/schemas/DraftProblemConflictResponseDto',
        },
      },
    })
    expect(schemas['DraftProblemConflictResponseDto']).toMatchObject({
      required: ['expectedRevision', 'currentRevision', 'nextAction'],
      properties: {
        nextAction: { enum: ['reload-draft-and-retry'] },
      },
    })

    const publish =
      document.paths['/planning/drafts/{planMonthId}/publish']?.post
    const published =
      document.paths['/planning/publications/{publicationId}']?.get
    const monthIndex = document.paths['/planning/months']?.get
    const active = document.paths['/planning/months/active']?.get
    expect(
      (monthIndex as (OpenApiOperation & { operationId?: string }) | undefined)
        ?.operationId,
    ).toBe('PlanningMonthController_list')
    expect(monthIndex?.security).toEqual([{ sessionCookie: [] }])
    expect(publish?.security).toEqual([{ sessionCookie: [], csrfToken: [] }])
    expect(published?.security).toEqual([{ sessionCookie: [] }])
    expect(active?.security).toEqual([{ sessionCookie: [] }])
    expect(Object.keys(publish?.responses ?? {}).sort()).toEqual([
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
    for (const operation of [monthIndex, published, active]) {
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
        '200',
        '401',
        '403',
        ...(operation === monthIndex ? [] : ['404']),
        '422',
        '503',
      ])
    }
    expect(parameter(monthIndex, 'limit')).toEqual({
      in: 'query',
      name: 'limit',
      required: false,
      schema: { default: 20, maximum: 50, minimum: 1, type: 'integer' },
    })
    expect(parameter(monthIndex, 'cursor')).toEqual({
      in: 'query',
      name: 'cursor',
      required: false,
      schema: {
        maxLength: 300,
        pattern: '^v1\\.[A-Za-z0-9_-]+$',
        type: 'string',
      },
    })
    expect(
      monthIndex?.responses?.['200']?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/PlanningMonthIndexResponseV1' })
    expect(schemas['PlanningMonthIndexResponseV1']).toMatchObject({
      additionalProperties: false,
      required: ['schemaVersion', 'queryLocalDate', 'items', 'nextCursor'],
    })
    expect(parameter(publish, 'planMonthId')).toEqual({
      in: 'path',
      name: 'planMonthId',
      required: true,
      schema: uuidSchema,
    })
    expect(parameter(published, 'publicationId')).toEqual({
      in: 'path',
      name: 'publicationId',
      required: true,
      schema: uuidSchema,
    })
    expect(publish?.requestBody).toEqual(
      exactRequestBody({
        additionalProperties: false,
        properties: {
          commandId: uuidSchema,
          expectedRevision: revisionSchema,
          previewSchemaVersion: {
            pattern: '^[a-z0-9][a-z0-9.-]{0,99}$',
            type: 'string',
          },
          previewHashVersion: {
            pattern: '^[a-z0-9][a-z0-9.-]{0,99}$',
            type: 'string',
          },
          previewHash: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        },
        required: [
          'commandId',
          'expectedRevision',
          'previewSchemaVersion',
          'previewHashVersion',
          'previewHash',
        ],
        type: 'object',
      }),
    )
    expect(
      Object.keys(
        publish?.responses?.['409']?.content?.['application/problem+json']
          ?.examples ?? {},
      ).sort(),
    ).toEqual([
      'COMMAND_FINGERPRINT_CONFLICT',
      'PLAN_DRAFT_NOT_EDITABLE',
      'PLAN_MONTH_ALREADY_PUBLISHED',
      'PLAN_PUBLICATION_BLOCKED',
      'PUBLICATION_PREVIEW_CONFLICT',
    ])
    expect(
      publish?.responses?.['409']?.content?.['application/problem+json']
        ?.examples?.['DRAFT_REVISION_CONFLICT'],
    ).toBeUndefined()
    exact404(publish, ['PLAN_DRAFT_NOT_FOUND'])
    exact404(published, ['PLAN_PUBLICATION_NOT_FOUND'])
    exact404(active, ['ACTIVE_PLAN_MONTH_NOT_FOUND'])
    expect(
      publish?.responses?.['201']?.content?.['application/json']?.schema,
    ).toEqual({
      $ref: '#/components/schemas/PlanPublicationResultResponseV1',
    })
    for (const operation of [published, active]) {
      expect(
        operation?.responses?.['200']?.content?.['application/json']?.schema,
      ).toEqual({
        $ref: '#/components/schemas/PublishedSnapshotResponseV1',
      })
    }
    expect(schemas['PublishedSnapshotResponseV1']).toMatchObject({
      additionalProperties: false,
      properties: {
        schemaVersion: {
          enum: ['planner.published-snapshot.v1'],
          type: 'string',
        },
        sourcePreviewSchemaVersion: {
          enum: ['planner.publication-preview.v1'],
          type: 'string',
        },
        publicationSnapshotHashVersion: {
          enum: ['planner.publication-preview-hash.v1'],
          type: 'string',
        },
        activation: {
          $ref: '#/components/schemas/PublishedActivationV1',
        },
      },
    })
    expect(schemas['PublishedActivationV1']).toMatchObject({
      additionalProperties: false,
      properties: { mode: { enum: ['immediate', 'scheduled'] } },
      required: ['mode', 'activeLocalDate', 'latePublication'],
    })
    expect(schemas['PublishedGoalSnapshotV1']?.properties?.['config']).toEqual({
      $ref: '#/components/schemas/PublishedGoalConfigV1',
    })
    const publicationBlockerDetail = schemas['PublicationBlockerResponseDto']
      ?.properties?.['detail'] as { enum?: unknown }
    expect(publicationBlockerDetail.enum).toEqual(
      expect.arrayContaining([
        'Publication materialization exceeds 10000 rows.',
        'Target month is not current or next.',
      ]),
    )
  })

  it('validates representative fixed, quota, weekly-task and blocked publication previews against OpenAPI', async () => {
    const document = JSON.parse(
      await readFile('docs/api/openapi.json', 'utf8'),
    ) as {
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >
          }
        }
      >
      components?: unknown
    }
    const schema =
      document.paths['/planning/drafts/publication-preview']?.get?.responses?.[
        '200'
      ]?.content?.['application/json']?.schema
    const validator = new OpenAPIResponseValidator({
      responses: { '200': { schema: schema as never } },
      components: document.components as never,
      customFormats: { date: () => true },
    })
    const planGoalId = '44444444-4444-4444-8444-444444444444'
    const base = {
      schemaVersion: 'planner.publication-preview.v1',
      planMonthId: '11111111-1111-4111-8111-111111111111',
      spaceId: '22222222-2222-4222-8222-222222222222',
      targetMonth: '2026-08',
      status: 'draft',
      planMonthRevision: '2',
      draftRevision: '7',
      previewHashVersion: 'planner.publication-preview-hash.v1',
      previewHash: 'a'.repeat(64),
      activation: {
        mode: 'immediate',
        activeLocalDate: '2026-08-01',
        latePublication: false,
      },
      focus: 'Exact preview',
      goals: [
        {
          planGoalId,
          goalDefinitionId: '55555555-5555-4555-8555-555555555555',
          goalDefinitionVersionId: '66666666-6666-4666-8666-666666666666',
          goalSeriesId: '77777777-7777-4777-8777-777777777777',
          title: 'Exact preview goal',
          why: 'Validate the exact public response schema.',
          category: 'Contract',
          displayOrder: 0,
          configRevision: '3',
          config: {
            schemaVersion: 1,
            scope: { kind: 'shared' },
            repetition: { kind: 'daily' },
            measurement: { kind: 'boolean' },
            checkpoints: { aggregation: null, items: [] },
          },
          sourceProvenance: {
            schemaVersion: 1,
            sourceDocument: 'contract-fixture',
            sourcePage: 1,
            rawValue: '1',
            rawDenominator: '1',
            resolution: 'Representative OpenAPI response fixture.',
          },
          blockers: [],
        },
      ],
      blockers: [],
      formulaVersions: {
        calendarTargets: 'planner.calendar-targets.v1',
        goalEvaluation: 'planner.goal-evaluation.v1',
        scoreCoverage: 'planner.score-coverage.v1',
      },
    }
    const target = (calendar: object): object => ({
      planGoalId,
      formulaVersion: 'planner.calendar-targets.v1',
      calendar,
    })
    const context = {
      targetMonth: '2026-08',
      activeLocalDate: '2026-08-01',
      timeZone: 'Asia/Yekaterinburg',
    }
    const augustDates = (startDay: number, endDay: number): string[] =>
      Array.from(
        { length: endDay - startDay + 1 },
        (_, offset) => `2026-08-${String(startDay + offset).padStart(2, '0')}`,
      )
    const weeklyQuotaPeriods = [
      [1, 1, 2],
      [2, 3, 9],
      [3, 10, 16],
      [4, 17, 23],
      [5, 24, 30],
      [6, 31, 31],
    ].map(([ordinal, startDay, endDay]) => {
      const periodDates = augustDates(startDay!, endDay!)
      return {
        cadence: 'weekly',
        ordinal,
        periodStart: periodDates[0],
        periodEnd: periodDates.at(-1),
        periodDays: 7,
        activeDates: periodDates,
        eligibleDates: periodDates,
        periodTarget: 1,
      }
    })
    const payloads = [
      {
        ...base,
        calculatedTargets: [
          target({
            ...context,
            kind: 'fixed',
            expectationDates: ['2026-08-01'],
          }),
        ],
      },
      {
        ...base,
        calculatedTargets: [
          target({
            ...context,
            kind: 'quota',
            cadence: 'weekly',
            periods: weeklyQuotaPeriods,
          }),
        ],
      },
      {
        ...base,
        calculatedTargets: [
          target({
            ...context,
            kind: 'weekly_planned_task',
            periods: [
              {
                cadence: 'weekly',
                ordinal: 1,
                periodStart: '2026-08-01',
                periodEnd: '2026-08-02',
                periodTarget: 1,
              },
            ],
          }),
        ],
      },
      {
        ...base,
        activation: {
          mode: 'blocked',
          activeLocalDate: '2026-08-01',
          latePublication: false,
        },
        calculatedTargets: [],
        blockers: [
          {
            planGoalId: null,
            pointer: '/targetMonth',
            code: 'incompatible',
            detail: 'Target month is not current or next.',
          },
        ],
      },
    ]
    for (const payload of payloads) {
      expect(validator.validateResponse('200', payload)).toBeUndefined()
    }
    for (const blocker of [
      {
        planGoalId: null,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
      {
        planGoalId,
        pointer: '/targetMonth',
        code: 'incompatible',
        detail: 'Target month is not current or next.',
      },
    ]) {
      const invalid = {
        ...payloads[0],
        goals: base.goals.map((goal) => ({ ...goal, blockers: [blocker] })),
      }
      expect(validator.validateResponse('200', invalid)).toMatchObject({
        message: 'The response was not valid.',
      })
    }
  })

  it('validates the finite published response and rejects preview-only or nullable draft states', async () => {
    const document = JSON.parse(
      await readFile('docs/api/openapi.json', 'utf8'),
    ) as {
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >
          }
        }
      >
      components?: unknown
    }
    const schema =
      document.paths['/planning/publications/{publicationId}']?.get
        ?.responses?.['200']?.content?.['application/json']?.schema
    const validator = new OpenAPIResponseValidator({
      responses: { '200': { schema: schema as never } },
      components: document.components as never,
      customFormats: { date: () => true },
    })
    const planGoalSnapshotId = '44444444-4444-4444-8444-444444444444'
    const sourcePlanGoalId = '55555555-5555-4555-8555-555555555555'
    const published = {
      schemaVersion: 'planner.published-snapshot.v1',
      publicationId: '11111111-1111-4111-8111-111111111111',
      publicationRevision: '1',
      planMonthId: '22222222-2222-4222-8222-222222222222',
      spaceId: '33333333-3333-4333-8333-333333333333',
      targetMonth: '2026-08',
      sourcePlanMonthRevision: '1',
      sourceDraftRevision: '2',
      sourcePreviewSchemaVersion: 'planner.publication-preview.v1',
      publicationSnapshotHashVersion: 'planner.publication-preview-hash.v1',
      publicationSnapshotHash: 'a'.repeat(64),
      activation: {
        mode: 'immediate',
        activeLocalDate: '2026-08-01',
        latePublication: false,
      },
      focus: 'Finite published response',
      goalSnapshots: [
        {
          planGoalSnapshotId,
          sourcePlanGoalId,
          sourceGoalDefinitionId: '66666666-6666-4666-8666-666666666666',
          sourceGoalDefinitionVersionId: '77777777-7777-4777-8777-777777777777',
          sourceGoalSeriesId: '88888888-8888-4888-8888-888888888888',
          title: 'Published goal',
          why: 'Exact response validation',
          category: 'Contract',
          displayOrder: 0,
          configRevision: '1',
          config: {
            schemaVersion: 1,
            scope: { kind: 'shared' },
            repetition: { kind: 'daily' },
            measurement: { kind: 'boolean' },
            checkpoints: null,
          },
          sourceProvenance: null,
        },
      ],
      calculatedTargets: [
        {
          planGoalSnapshotId,
          sourcePlanGoalId,
          formulaVersion: 'planner.calendar-targets.v1',
          calendar: {
            targetMonth: '2026-08',
            activeLocalDate: '2026-08-01',
            timeZone: 'Asia/Yekaterinburg',
            kind: 'fixed',
            expectationDates: ['2026-08-01'],
          },
        },
      ],
      formulaVersions: {
        calendarTargets: 'planner.calendar-targets.v1',
        goalEvaluation: 'planner.goal-evaluation.v1',
        scoreCoverage: 'planner.score-coverage.v1',
      },
    }
    const withConfig = (config: object): object => ({
      ...published,
      goalSnapshots: published.goalSnapshots.map((goal) => ({
        ...goal,
        config,
      })),
    })
    const targetedQuantity = (target: string): object =>
      withConfig({
        ...published.goalSnapshots[0]!.config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'times',
          precision: 3,
          aggregation: 'add',
          target,
        },
      })
    const anyOfTarget = (target: string): object =>
      withConfig({
        ...published.goalSnapshots[0]!.config,
        measurement: {
          kind: 'any_of',
          variants: [
            {
              variantId: '99999999-9999-4999-8999-999999999999',
              label: 'Exact target variant',
              unit: 'times',
              precision: 3,
              target,
            },
          ],
        },
      })
    const checkpointTarget = (target: string): object =>
      withConfig({
        ...published.goalSnapshots[0]!.config,
        measurement: {
          kind: 'quantity',
          mode: 'targeted',
          unit: 'times',
          precision: 3,
          aggregation: 'add',
          target: '1',
        },
        checkpoints: {
          aggregation: 'all',
          items: [
            {
              checkpointId: '99999999-9999-4999-8999-999999999999',
              name: 'Exact checkpoint target',
              deadline: '12:00',
              satisfaction: { kind: 'quantity', target },
            },
          ],
        },
      })

    const publishedSchemas = (
      document.components as {
        schemas: Record<
          string,
          { properties?: Record<string, Record<string, unknown>> }
        >
      }
    ).schemas
    const positiveDecimalPattern =
      '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$'
    for (const schemaName of [
      'PublishedTargetedQuantityMeasurementV1',
      'PublishedAnyOfVariantV1',
      'PublishedQuantityCheckpointSatisfactionV1',
    ]) {
      expect(publishedSchemas[schemaName]?.properties?.['target']).toEqual({
        type: 'string',
        pattern: positiveDecimalPattern,
      })
    }
    expect(validator.validateResponse('200', published)).toBeUndefined()
    for (const positive of [
      targetedQuantity('0.01'),
      anyOfTarget('0.01'),
      checkpointTarget('0.01'),
    ]) {
      expect(validator.validateResponse('200', positive)).toBeUndefined()
    }

    const invalidPayloads: readonly object[] = [
      { ...published, extra: true },
      Object.fromEntries(
        Object.entries(published).filter(
          ([key]) => key !== 'sourcePreviewSchemaVersion',
        ),
      ),
      {
        ...published,
        activation: { ...published.activation, mode: 'blocked' },
      },
      { ...published, sourcePreviewSchemaVersion: 'planner.preview.future.v9' },
      {
        ...published,
        publicationSnapshotHashVersion: 'planner.hash.future.v9',
      },
      {
        ...published,
        goalSnapshots: published.goalSnapshots.map((goal) => ({
          ...goal,
          config: {
            ...goal.config,
            repetition: { kind: 'weekly', n: null },
          },
        })),
      },
      ...['0', '0.000'].flatMap((target) => [
        targetedQuantity(target),
        anyOfTarget(target),
        checkpointTarget(target),
      ]),
      {
        ...published,
        calculatedTargets: published.calculatedTargets.map((target) => ({
          ...target,
          calendar: {
            targetMonth: '2026-08',
            activeLocalDate: '2026-08-01',
            timeZone: 'Asia/Yekaterinburg',
            kind: 'quota',
            cadence: 'monthly',
            periods: [
              {
                cadence: 'weekly',
                ordinal: 1,
                periodStart: '2026-08-01',
                periodEnd: '2026-08-31',
                periodDays: 31,
                activeDates: ['2026-08-01'],
                eligibleDates: ['2026-08-01'],
                periodTarget: 1,
              },
            ],
          },
        })),
      },
    ]
    for (const invalid of invalidPayloads) {
      expect(validator.validateResponse('200', invalid)).toMatchObject({
        message: 'The response was not valid.',
      })
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
