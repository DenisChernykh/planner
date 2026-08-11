import { checkOpenApiDrift } from '@/bootstrap/contracts/generate-openapi'

async function main(): Promise<void> {
  await checkOpenApiDrift()
  process.stdout.write('OpenAPI artifact: current\n')
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'OpenAPI failed'}\n`,
  )
  process.exitCode = 1
})
