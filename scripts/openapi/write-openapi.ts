import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { generateOpenApiArtifact } from '@/bootstrap/contracts/generate-openapi'

async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--output docs/api/openapi.json') {
    throw new Error(
      'OpenAPI output path is required: --output docs/api/openapi.json',
    )
  }
  const output = resolve('docs/api/openapi.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, await generateOpenApiArtifact(), 'utf8')
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'OpenAPI failed'}\n`,
  )
  process.exitCode = 1
})
