import { applyDecorators } from '@nestjs/common'
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger'

import {
  PROBLEM_CATALOG,
  type CoreProblemCode,
} from '@/platform/http/errors/problem-registry'

import {
  ProblemFieldErrorResponseDto,
  ProblemResponseDto,
  ValidationProblemResponseDto,
} from './problem-response.dto'

export function ApiProblemResponses(
  ...codes: readonly CoreProblemCode[]
): ClassDecorator & MethodDecorator {
  const definitions = codes.map((code) => {
    const definition = PROBLEM_CATALOG.find((entry) => entry.code === code)
    if (definition === undefined) {
      throw new Error(`Unregistered OpenAPI problem: ${code}`)
    }
    return definition
  })
  const responses = definitions.map((definition) =>
    ApiResponse({
      status: definition.status,
      description: definition.title,
      content: {
        'application/problem+json': {
          schema: {
            $ref: getSchemaPath(
              definition.code === 'VALIDATION_FAILED'
                ? ValidationProblemResponseDto
                : ProblemResponseDto,
            ),
          },
          examples: {
            [definition.code]: {
              summary: definition.title,
              value: {
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
              },
            },
          },
        },
      },
    }),
  )
  return applyDecorators(
    ApiExtraModels(
      ProblemFieldErrorResponseDto,
      ProblemResponseDto,
      ValidationProblemResponseDto,
    ),
    ...responses,
  )
}
