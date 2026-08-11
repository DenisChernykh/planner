import type { INestApplication } from '@nestjs/common'
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger'

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Planner API')
      .setDescription('Closed monthly planner backend contract.')
      .setVersion('0.1.0-alpha.0')
      .setLicense('UNLICENSED', 'https://planner.invalid/license')
      .setOpenAPIVersion('3.0.3')
      .addServer('/', 'Current API origin.')
      .addTag('health', 'Process lifecycle and dependency health probes.')
      .build(),
    { autoTagControllers: true, deepScanRoutes: true },
  )
}
