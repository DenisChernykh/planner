import { IsString, Matches } from 'class-validator'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const POSITIVE = /^[1-9][0-9]*$/u
const VERSION = /^[a-z0-9][a-z0-9.-]{0,99}$/u
const HASH = /^[0-9a-f]{64}$/u

export class PublishMonthRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision!: string

  @IsString()
  @Matches(VERSION)
  public readonly previewSchemaVersion!: string

  @IsString()
  @Matches(VERSION)
  public readonly previewHashVersion!: string

  @IsString()
  @Matches(HASH)
  public readonly previewHash!: string
}

export class PublicationPathDto {
  @IsString()
  @Matches(UUID)
  public readonly publicationId!: string
}

export class CancelPublicationRequestDto {
  @IsString()
  @Matches(UUID)
  public readonly commandId!: string

  @IsString()
  @Matches(UUID)
  public readonly planMonthId!: string

  @IsString()
  @Matches(POSITIVE)
  public readonly expectedRevision!: string
}
