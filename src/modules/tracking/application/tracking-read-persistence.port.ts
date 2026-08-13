import type { TrackingMonthStateV1 } from './tracking-read.types'

export type GetTrackingReadPersistenceInput = {
  readonly spaceId: string
  readonly memberId: string
  readonly targetMonth: string
  readonly queryLocalDate: string
  readonly selectedLocalDate: string | null
}

export interface TrackingReadPersistencePort {
  getMonth(
    input: GetTrackingReadPersistenceInput,
  ): Promise<TrackingMonthStateV1>
}
