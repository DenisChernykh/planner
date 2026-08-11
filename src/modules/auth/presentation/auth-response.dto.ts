import { ApiProperty } from '@nestjs/swagger'

export class AuthenticatedPrincipalResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  public readonly userId!: string

  @ApiProperty({ type: String, pattern: '^[A-Za-z0-9_-]{22}$' })
  public readonly sessionId!: string
}

export class CsrfTokenResponseDto {
  @ApiProperty({ type: String, pattern: '^[A-Za-z0-9_-]{43}$' })
  public readonly csrfToken!: string
}
