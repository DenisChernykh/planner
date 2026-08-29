export type MonthHistoryActorRecord =
  | { readonly kind: 'member'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string }

export type MonthHistoryStatus = 'draft' | 'published' | 'grace' | 'closed'
export type MonthHistoryMode = 'ordinary' | 'reopened'

export interface MonthHistoryLifecycleRecord {
  readonly status: MonthHistoryStatus
  readonly mode: MonthHistoryMode
  readonly revision: string
}

export interface MonthHistoryEventRecord {
  readonly id: string
  readonly kind:
    | 'published'
    | 'publication_cancelled'
    | 'grace_started'
    | 'closed'
    | 'reopened'
    | 'reclosed'
  readonly actor: MonthHistoryActorRecord
  readonly occurredAt: string
  readonly reason: string | null
  readonly before: MonthHistoryLifecycleRecord
  readonly after: MonthHistoryLifecycleRecord
  readonly publication: {
    readonly publicationId: string
    readonly revision: string
  } | null
  readonly report: {
    readonly reportRevisionId: string
    readonly revision: string
  } | null
}

export interface MonthHistoryHeaderRecord {
  readonly planMonthId: string
  readonly targetMonth: string
  readonly current: MonthHistoryLifecycleRecord
}

export interface MonthHistoryReadPort {
  readHeader(input: {
    readonly spaceId: string
    readonly planMonthId: string
  }): Promise<MonthHistoryHeaderRecord | null>
  readEvents(input: {
    readonly spaceId: string
    readonly planMonthId: string
    readonly limit: number
    readonly cursor: bigint | null
  }): Promise<readonly MonthHistoryEventRecord[]>
}
