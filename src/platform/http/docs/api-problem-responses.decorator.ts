import { applyDecorators } from '@nestjs/common'
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger'

import {
  getProblemDefinition,
  type CoreProblemCode,
} from '@/platform/http/errors/problem-registry'
import type { RegisteredProblemDefinition } from '@/platform/http/errors/problem.contracts'

import {
  ProblemFieldErrorResponseDto,
  ProblemResponseDto,
  ValidationProblemResponseDto,
} from './problem-response.dto'

const problemContentType = 'application/problem+json'

export function ApiProblemResponses(
  ...problems: readonly (CoreProblemCode | RegisteredProblemDefinition)[]
): ClassDecorator & MethodDecorator {
  const definitionsByStatus = new Map<number, RegisteredProblemDefinition[]>()
  for (const problem of problems) {
    const definition =
      typeof problem === 'string' ? getProblemDefinition(problem) : problem
    const definitions = definitionsByStatus.get(definition.status) ?? []
    definitions.push(definition)
    definitionsByStatus.set(definition.status, definitions)
  }
  const responses = [...definitionsByStatus].map(([status, definitions]) => {
    const responseTypes = [
      ...new Set(
        definitions.map(({ code }) =>
          code === 'VALIDATION_FAILED'
            ? ValidationProblemResponseDto
            : ProblemResponseDto,
        ),
      ),
    ]
    const schemas = responseTypes.map((responseType) => ({
      $ref: getSchemaPath(responseType),
    }))
    const examples = Object.fromEntries(
      definitions.map((definition) => [
        definition.code,
        {
          summary: definition.title,
          value: problemExample(definition),
        },
      ]),
    )
    return ApiResponse({
      status,
      description: definitions.map(({ title }) => title).join('; '),
      content: {
        [problemContentType]: {
          schema: schemas.length === 1 ? schemas[0]! : { oneOf: schemas },
          examples,
        },
      },
    })
  })
  return applyDecorators(
    ApiExtraModels(
      ProblemFieldErrorResponseDto,
      ProblemResponseDto,
      ValidationProblemResponseDto,
    ),
    ...responses,
  )
}

function problemExample(definition: RegisteredProblemDefinition): object {
  return {
    type: definition.type,
    title: definition.title,
    status: definition.status,
    detail: definition.detail,
    instance: 'urn:request:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    code: definition.code,
    requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ...(definition.code === 'VALIDATION_FAILED'
      ? {
          errors: [
            {
              pointer: '/profile/name~1with~0reserved',
              code: 'invalid_type',
              detail: 'Field has an invalid type.',
            },
          ],
        }
      : {}),
  }
}
