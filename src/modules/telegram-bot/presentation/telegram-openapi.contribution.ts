import type { OpenApiDocumentContribution } from '@/platform/http/docs/openapi-document'

export const TELEGRAM_OPENAPI_CONTRIBUTION: OpenApiDocumentContribution = {
  tags: [
    {
      name: 'telegram',
      description: 'Safe authenticated navigation to the configured bot.',
    },
  ],
  install: () => undefined,
}
