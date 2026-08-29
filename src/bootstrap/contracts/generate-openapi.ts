import { readFile } from 'node:fs/promises'

import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { ApiModule } from '@/bootstrap/api/api.module'
import { PLANNING_OPENAPI_CONTRIBUTION } from '@/modules/planning/composition'
import { REMINDERS_OPENAPI_CONTRIBUTION } from '@/modules/reminders/composition'
import { REPORTING_OPENAPI_CONTRIBUTION } from '@/modules/reporting/composition'
import { TRACKING_OPENAPI_CONTRIBUTION } from '@/modules/tracking/composition'
import { TELEGRAM_OPENAPI_CONTRIBUTION } from '@/modules/telegram-bot/composition'
import { WORKSPACE_OPENAPI_CONTRIBUTION } from '@/modules/workspace/composition'
import { createOpenApiDocument } from '@/platform/http/docs/openapi-document'
import { canonicalizeJson } from '@/platform/http/docs/openapi-normalizer'
import { HttpProblemRegistry } from '@/platform/http/errors/http-problem.registry'

import { createOpenApiRuntimeConfig } from './openapi-runtime-config'

export async function generateOpenApiArtifact(): Promise<string> {
  const config = createOpenApiRuntimeConfig()
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.forRoot(config),
    { abortOnError: false, bodyParser: false, logger: false, preview: true },
  )
  try {
    return canonicalizeJson(
      createOpenApiDocument(
        app,
        config,
        app.get(HttpProblemRegistry).definitions,
        [
          PLANNING_OPENAPI_CONTRIBUTION,
          TRACKING_OPENAPI_CONTRIBUTION,
          REMINDERS_OPENAPI_CONTRIBUTION,
          REPORTING_OPENAPI_CONTRIBUTION,
          WORKSPACE_OPENAPI_CONTRIBUTION,
          TELEGRAM_OPENAPI_CONTRIBUTION,
        ],
      ),
    )
  } finally {
    await app.close()
  }
}

export async function checkOpenApiDrift(
  artifactPath = 'docs/api/openapi.json',
): Promise<void> {
  const [committed, generated] = await Promise.all([
    readFile(artifactPath, 'utf8'),
    generateOpenApiArtifact(),
  ])
  if (committed !== generated) {
    throw new Error('OpenAPI artifact drift detected; regenerate the contract')
  }
}
