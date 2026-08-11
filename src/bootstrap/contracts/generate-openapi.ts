import { readFile } from 'node:fs/promises'

import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { ApiModule } from '@/bootstrap/api/api.module'
import { createOpenApiDocument } from '@/platform/http/docs/openapi-document'
import { canonicalizeJson } from '@/platform/http/docs/openapi-normalizer'

import { createOpenApiRuntimeConfig } from './openapi-runtime-config'

export async function generateOpenApiArtifact(): Promise<string> {
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.forRoot(createOpenApiRuntimeConfig()),
    { abortOnError: false, bodyParser: false, logger: false, preview: true },
  )
  try {
    return canonicalizeJson(createOpenApiDocument(app))
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
