import type { WorkspaceMemberResolver } from '@/modules/workspace/application/workspace-member-resolver.port'
import {
  WorkspaceDependencyUnavailableError,
  WorkspaceMemberNotFoundError,
} from '@/modules/workspace/application/workspace-errors'
import type { DatabaseTransactionPort } from '@/shared/application/database-transaction.port'
import { CommandValidationError } from '@/shared/application/application-command'
import type { ProductClock } from '@/shared/application/product-clock'

import {
  isCanonicalCalendarMonth,
  isCanonicalPlanningUuid,
} from '../domain/planning-values'
import type {
  ListPlanMonthsReadPort,
  PlanMonthReadRecord,
} from './list-plan-months.read.port'
import {
  PlanningAuthorizationDeniedError,
  PlanningDependencyUnavailableError,
} from './planning-errors'

const TIME_ZONE = 'Asia/Yekaterinburg' as const
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const CURSOR_VERSION = 1
const CURSOR_PREFIX = 'v1.'

export interface PlanMonthIndexDraft {
  readonly revision: string
}

export interface PlanMonthIndexPublication {
  readonly publicationId: string
  readonly revision: string
  readonly activeLocalDate: string
  readonly isActive: boolean
}

export interface PlanMonthIndexReport {
  readonly reportRevisionId: string
  readonly revision: string
  readonly status: 'original' | 'revised'
}

export type PlanMonthIndexPhase =
  'draft' | 'future' | 'active' | 'grace' | 'closed'

export interface PlanMonthIndexItem {
  readonly targetMonth: string
  readonly phase: PlanMonthIndexPhase
  readonly lifecycle: {
    readonly planMonthId: string
    readonly status: PlanMonthReadRecord['status']
    readonly mode: PlanMonthReadRecord['mode']
    readonly revision: string
  }
  readonly draft: PlanMonthIndexDraft
  readonly publication: PlanMonthIndexPublication | null
  readonly report: PlanMonthIndexReport | null
  readonly allowedActions: {
    readonly openDraft: boolean
    readonly openPublication: boolean
    readonly copySource: boolean
    readonly cancel: boolean
    readonly reopen: boolean
    readonly reclose: boolean
  }
}

export interface PlanMonthIndex {
  readonly schemaVersion: 'planning.month-index.v1'
  readonly queryLocalDate: string
  readonly items: readonly PlanMonthIndexItem[]
  readonly nextCursor: string | null
}

export interface ListPlanMonthsQueryInput {
  readonly trustedUserId: string
  readonly limit?: number
  readonly cursor?: string
}

interface DecodedCursor {
  readonly targetMonth: string
  readonly planMonthId: string
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    return Object.freeze(value)
  }
  return value
}

function isPositiveDecimal(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value)
}

function isNonNegativeDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value)
}

function encodeCursor(value: DecodedCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    targetMonth: value.targetMonth,
    planMonthId: value.planMonthId,
  })
  return `${CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`
}

function decodeCursor(value: string | undefined): DecodedCursor | null {
  if (value === undefined) return null
  if (
    value.length > 300 ||
    !value.startsWith(CURSOR_PREFIX) ||
    !/^v1\.[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new CommandValidationError()
  }

  const encoded = value.slice(CURSOR_PREFIX.length)
  let decoded: unknown
  try {
    if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
      throw new Error('Invalid cursor encoding')
    }
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new CommandValidationError()
  }
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    throw new CommandValidationError()
  }
  const payload = decoded as Record<string, unknown>
  const keys = Object.keys(payload).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== 'planMonthId' ||
    keys[1] !== 'targetMonth' ||
    keys[2] !== 'v' ||
    payload.v !== CURSOR_VERSION ||
    !isCanonicalCalendarMonth(payload.targetMonth) ||
    !isCanonicalPlanningUuid(payload.planMonthId)
  ) {
    throw new CommandValidationError()
  }
  return {
    targetMonth: payload.targetMonth,
    planMonthId: payload.planMonthId,
  }
}

function validateRecord(record: PlanMonthReadRecord): void {
  if (
    !isCanonicalPlanningUuid(record.planMonthId) ||
    !isCanonicalCalendarMonth(record.targetMonth) ||
    record.monthStart !== `${record.targetMonth}-01` ||
    !['draft', 'published', 'grace', 'closed'].includes(record.status) ||
    !['ordinary', 'reopened'].includes(record.mode) ||
    !isPositiveDecimal(record.revision) ||
    !isNonNegativeDecimal(record.factsRevision)
  ) {
    throw new PlanningDependencyUnavailableError()
  }
  if (
    record.draftRevision === null ||
    !isPositiveDecimal(record.draftRevision)
  ) {
    throw new PlanningDependencyUnavailableError()
  }
  if (record.latestPublication !== null) {
    if (
      !isCanonicalPlanningUuid(record.latestPublication.publicationId) ||
      !isPositiveDecimal(record.latestPublication.revision) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(record.latestPublication.activeLocalDate)
    ) {
      throw new PlanningDependencyUnavailableError()
    }
  }
  if (record.latestReport !== null) {
    if (
      !isCanonicalPlanningUuid(record.latestReport.reportRevisionId) ||
      !isPositiveDecimal(record.latestReport.revision) ||
      !['original', 'revised'].includes(record.latestReport.status)
    ) {
      throw new PlanningDependencyUnavailableError()
    }
  }
  const hasActivePublication = record.latestPublication?.isActive === true
  if (record.latestReport !== null && record.latestPublication === null) {
    throw new PlanningDependencyUnavailableError()
  }
  switch (record.status) {
    case 'draft':
      if (
        record.mode !== 'ordinary' ||
        hasActivePublication ||
        record.latestReport !== null
      ) {
        throw new PlanningDependencyUnavailableError()
      }
      return
    case 'published':
      if (
        record.mode !== 'ordinary' ||
        !hasActivePublication ||
        record.latestReport !== null
      ) {
        throw new PlanningDependencyUnavailableError()
      }
      return
    case 'grace':
      if (
        !hasActivePublication ||
        (record.mode === 'ordinary' && record.latestReport !== null) ||
        (record.mode === 'reopened' && record.latestReport === null)
      ) {
        throw new PlanningDependencyUnavailableError()
      }
      return
    case 'closed':
      if (
        !hasActivePublication ||
        record.latestReport === null ||
        (record.mode === 'ordinary' &&
          record.latestReport.status !== 'original') ||
        (record.mode === 'reopened' && record.latestReport.status !== 'revised')
      ) {
        throw new PlanningDependencyUnavailableError()
      }
      return
  }
}

function phaseFor(
  record: PlanMonthReadRecord,
  queryLocalDate: string,
): PlanMonthIndexPhase {
  if (record.status === 'draft') return 'draft'
  if (record.status === 'grace') return 'grace'
  if (record.status === 'closed') return 'closed'
  return record.monthStart > queryLocalDate ? 'future' : 'active'
}

function mapRecord(
  record: PlanMonthReadRecord,
  queryLocalDate: string,
): PlanMonthIndexItem {
  validateRecord(record)
  const phase = phaseFor(record, queryLocalDate)
  const hasPublication = record.latestPublication !== null
  const isActivePublication = record.latestPublication?.isActive === true
  return {
    targetMonth: record.targetMonth,
    phase,
    lifecycle: {
      planMonthId: record.planMonthId,
      status: record.status,
      mode: record.mode,
      revision: record.revision,
    },
    draft: { revision: record.draftRevision! },
    publication: record.latestPublication,
    report: record.latestReport,
    allowedActions: {
      openDraft: record.status === 'draft',
      openPublication: hasPublication,
      copySource: hasPublication,
      cancel:
        record.status === 'published' &&
        phase === 'future' &&
        isActivePublication &&
        record.factsRevision === '0',
      reopen: record.status === 'closed' && isActivePublication,
      reclose:
        record.status === 'grace' &&
        record.mode === 'reopened' &&
        isActivePublication,
    },
  }
}

export class ListPlanMonthsQuery {
  public constructor(
    private readonly workspaceMembers: WorkspaceMemberResolver,
    private readonly months: ListPlanMonthsReadPort,
    private readonly transaction: DatabaseTransactionPort,
    private readonly clock: ProductClock,
  ) {}

  public async execute(
    input: ListPlanMonthsQueryInput,
  ): Promise<PlanMonthIndex> {
    const limit = input.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new CommandValidationError()
    }
    const cursor = decodeCursor(input.cursor)
    try {
      const queryLocalDate = this.clock.today(TIME_ZONE)
      return await this.transaction.run(
        async () => {
          let member
          try {
            member = await this.workspaceMembers.resolveUser(
              input.trustedUserId,
            )
          } catch (error: unknown) {
            if (error instanceof WorkspaceMemberNotFoundError) {
              throw new PlanningAuthorizationDeniedError()
            }
            if (error instanceof WorkspaceDependencyUnavailableError) {
              throw new PlanningDependencyUnavailableError({ cause: error })
            }
            throw new PlanningDependencyUnavailableError({ cause: error })
          }
          const rows = await this.months.read({
            spaceId: member.spaceId,
            limit: limit + 1,
            cursor,
          })
          const hasNext = rows.length > limit
          const page = hasNext ? rows.slice(0, limit) : rows
          const items = page.map((row) => mapRecord(row, queryLocalDate))
          const last = page.at(-1)
          return freeze({
            schemaVersion: 'planning.month-index.v1' as const,
            queryLocalDate,
            items,
            nextCursor:
              hasNext && last !== undefined
                ? encodeCursor({
                    targetMonth: last.targetMonth,
                    planMonthId: last.planMonthId,
                  })
                : null,
          })
        },
        { mode: 'repeatable_read_only' },
      )
    } catch (error: unknown) {
      if (
        error instanceof CommandValidationError ||
        error instanceof PlanningAuthorizationDeniedError ||
        error instanceof PlanningDependencyUnavailableError
      ) {
        throw error
      }
      throw new PlanningDependencyUnavailableError({ cause: error })
    }
  }
}
