import { Inject, Injectable } from '@nestjs/common'

import {
  LocalUserProvisioningUnavailableError,
  type LocalUserProvisioningPort,
  LOCAL_USER_PROVISIONING_PORT,
} from '@/modules/auth'
import {
  DATABASE_TRANSACTION_PORT,
  type DatabaseTransactionPort,
} from '@/shared/application/database-transaction.port'

import {
  PAIR_WORKSPACE_PORT,
  type PairProvisioningInput,
  type PairProvisioningMemberInput,
  type PairProvisioningResult,
  type PairWorkspacePort,
  type PairWorkspaceSnapshot,
} from './pair-workspace.port'
import {
  PairProvisioningConflictError,
  PairProvisioningInputError,
  WorkspaceDependencyUnavailableError,
} from './workspace-errors'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const maxSignedBigInt = 9_223_372_036_854_775_807n

function validMember(value: unknown): value is PairProvisioningMemberInput {
  if (typeof value !== 'object' || value === null) return false
  const member = value as Partial<PairProvisioningMemberInput>
  return (
    typeof member.userId === 'string' &&
    uuidPattern.test(member.userId) &&
    typeof member.telegramId === 'bigint' &&
    member.telegramId > 0n &&
    member.telegramId <= maxSignedBigInt
  )
}

function validateInput(
  input: unknown,
): readonly [PairProvisioningMemberInput, PairProvisioningMemberInput] {
  if (typeof input !== 'object' || input === null)
    throw new PairProvisioningInputError()
  const members: unknown = Reflect.get(input, 'members')
  if (
    !Array.isArray(members) ||
    members.length !== 2 ||
    !validMember(members[0]) ||
    !validMember(members[1]) ||
    members[0].userId === members[1].userId ||
    members[0].telegramId === members[1].telegramId
  )
    throw new PairProvisioningInputError()
  return [members[0], members[1]]
}

function ordered(
  members: readonly PairProvisioningMemberInput[],
): readonly PairProvisioningMemberInput[] {
  return [...members].sort((left, right) =>
    left.userId.localeCompare(right.userId),
  )
}

function replayMatches(
  snapshot: PairWorkspaceSnapshot,
  requested: readonly PairProvisioningMemberInput[],
): boolean {
  if (
    snapshot.spaces.length !== 1 ||
    snapshot.members.length !== 2 ||
    snapshot.allowlist.length !== 2
  )
    return false
  const space = snapshot.spaces[0]
  if (space === undefined) return false
  const actualMembers = [...snapshot.members].sort((left, right) =>
    left.userId.localeCompare(right.userId),
  )
  const actualAllowlist = ordered(snapshot.allowlist)
  return requested.every((member, index) => {
    const actualMember = actualMembers[index]
    const actualAccess = actualAllowlist[index]
    return (
      actualMember?.userId === member.userId &&
      actualAccess?.userId === member.userId &&
      actualAccess.telegramId === member.telegramId
    )
  })
}

@Injectable()
export class ProvisionPairUseCase {
  public constructor(
    @Inject(DATABASE_TRANSACTION_PORT)
    private readonly transaction: DatabaseTransactionPort,
    @Inject(LOCAL_USER_PROVISIONING_PORT)
    private readonly users: LocalUserProvisioningPort,
    @Inject(PAIR_WORKSPACE_PORT)
    private readonly workspace: PairWorkspacePort,
  ) {}

  public execute(
    input: PairProvisioningInput,
  ): Promise<PairProvisioningResult> {
    let members: readonly PairProvisioningMemberInput[]
    try {
      members = ordered(validateInput(input))
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new PairProvisioningInputError(),
      )
    }
    return this.transaction.run(async () => {
      await this.workspace.acquireProvisioningLock()
      const snapshot = await this.workspace.findSnapshot()
      if (
        snapshot.spaces.length === 0 &&
        snapshot.members.length === 0 &&
        snapshot.allowlist.length === 0
      ) {
        try {
          await this.users.ensureUsers(members.map((member) => member.userId))
        } catch (error: unknown) {
          if (error instanceof LocalUserProvisioningUnavailableError) {
            throw new WorkspaceDependencyUnavailableError({ cause: error })
          }
          throw error
        }
        const created = await this.workspace.create(members)
        return { status: 'created', ...created }
      }
      if (!replayMatches(snapshot, members)) {
        throw new PairProvisioningConflictError()
      }
      const space = snapshot.spaces[0]
      if (space === undefined) throw new PairProvisioningConflictError()
      return {
        status: 'existing',
        spaceId: space.spaceId,
        members: [...snapshot.members].sort((left, right) =>
          left.userId.localeCompare(right.userId),
        ),
      }
    })
  }
}
