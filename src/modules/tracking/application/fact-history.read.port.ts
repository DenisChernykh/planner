export type FactHistoryActorRecord =
  | { readonly kind: 'member'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string }

export interface FactHistoryRevisionRecord {
  readonly id: string
  readonly revision: string
  readonly kind: 'recorded' | 'tombstoned'
  readonly actor: FactHistoryActorRecord
  readonly occurredAt: string
}

export interface FactHistoryEventRecord {
  readonly id: string
  readonly kind: 'recorded' | 'corrected' | 'tombstoned' | 'undone'
  readonly actor: FactHistoryActorRecord
  readonly occurredAt: string
  readonly reason: string | null
  readonly beforeRevision: FactHistoryRevisionRecord | null
  readonly afterRevision: FactHistoryRevisionRecord
  readonly compensation: {
    readonly undoneEventId: string
    readonly restoredFromRevision: FactHistoryRevisionRecord | null
  } | null
}

export interface FactHistoryHeaderRecord {
  readonly factRecordId: string
  readonly originalActor: FactHistoryActorRecord
  readonly createdAt: string
  readonly currentRevision: FactHistoryRevisionRecord
}

export interface FactHistoryReadPort {
  readHeader(input: {
    readonly spaceId: string
    readonly factRecordId: string
  }): Promise<FactHistoryHeaderRecord | null>
  readEvents(input: {
    readonly spaceId: string
    readonly factRecordId: string
    readonly limit: number
    readonly cursor: bigint | null
  }): Promise<readonly FactHistoryEventRecord[]>
}
