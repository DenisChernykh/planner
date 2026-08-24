import type { OpenAPIObject } from '@nestjs/swagger'

import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

function installWorkspaceSchemas(document: OpenAPIObject): void {
  const schemas = ((document.components ??= {}).schemas ??= {}) as Record<
    string,
    Record<string, unknown>
  >
  const uuid = {
    type: 'string',
    pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  }
  const object = (
    properties: Record<string, unknown>,
    required: readonly string[],
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  })

  schemas['WorkspaceMemberPresentationV1'] = object(
    {
      memberId: uuid,
      relation: { type: 'string', enum: ['current', 'partner'] },
      displayName: {
        type: 'string',
        enum: ['Вы', 'Партнёр', 'Участник А', 'Участник Б'],
      },
      persona: {
        type: 'string',
        enum: ['memberA', 'memberB'],
        nullable: true,
      },
    },
    ['memberId', 'relation', 'displayName', 'persona'],
  )
  schemas['WorkspaceCurrentResponseV1'] = object(
    {
      spaceId: uuid,
      timeZone: { type: 'string', enum: ['Asia/Yekaterinburg'] },
      currentMemberId: uuid,
      personaMappingState: {
        type: 'string',
        enum: ['unbound', 'bound'],
      },
      members: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { $ref: '#/components/schemas/WorkspaceMemberPresentationV1' },
      },
    },
    [
      'spaceId',
      'timeZone',
      'currentMemberId',
      'personaMappingState',
      'members',
    ],
  )
}

export const WORKSPACE_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'workspace',
      description:
        'Current pair workspace and safe member presentation context.',
    },
  ],
  problemCodeComponents: [],
  install: installWorkspaceSchemas,
}
