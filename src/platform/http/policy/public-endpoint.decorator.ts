import { SetMetadata } from '@nestjs/common'

/** Metadata key for the narrow default-authentication bypass. */
export const PUBLIC_ENDPOINT_METADATA: unique symbol = Symbol(
  'PUBLIC_ENDPOINT_METADATA',
)

/** Marks one controller or handler as explicitly public. */
export const PublicEndpoint = (): ClassDecorator & MethodDecorator =>
  SetMetadata(PUBLIC_ENDPOINT_METADATA, true)
