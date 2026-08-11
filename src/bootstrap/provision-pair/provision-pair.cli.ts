import type { Readable } from 'node:stream'

import type {
  PairProvisioningInput,
  PairProvisioningResult,
} from '@/modules/workspace'
import {
  PairProvisioningConflictError,
  PairProvisioningInputError,
  WorkspaceDependencyUnavailableError,
} from '@/modules/workspace'

const MAX_INPUT_BYTES = 16_384
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const telegramIdPattern = /^[1-9][0-9]*$/u

export class InvalidPairProvisioningInputError extends Error {
  public constructor() {
    super('Invalid provisioning input')
    this.name = 'InvalidPairProvisioningInputError'
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parsePairProvisioningInput(
  source: string,
): PairProvisioningInput {
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES)
    throw new InvalidPairProvisioningInputError()
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new InvalidPairProvisioningInputError()
  }
  const root = objectValue(parsed)
  if (root === undefined || !exactKeys(root, ['members']))
    throw new InvalidPairProvisioningInputError()
  const members = root['members']
  if (!Array.isArray(members) || members.length !== 2)
    throw new InvalidPairProvisioningInputError()
  const normalized = members.map((candidate) => {
    const member = objectValue(candidate)
    if (member === undefined || !exactKeys(member, ['telegramId', 'userId']))
      throw new InvalidPairProvisioningInputError()
    const userId = member['userId']
    const telegramText = member['telegramId']
    if (
      typeof userId !== 'string' ||
      !uuidPattern.test(userId) ||
      typeof telegramText !== 'string' ||
      !telegramIdPattern.test(telegramText)
    )
      throw new InvalidPairProvisioningInputError()
    const telegramId = BigInt(telegramText)
    if (telegramId > MAX_SIGNED_BIGINT)
      throw new InvalidPairProvisioningInputError()
    return { userId, telegramId }
  })
  if (
    normalized[0]?.userId === normalized[1]?.userId ||
    normalized[0]?.telegramId === normalized[1]?.telegramId
  )
    throw new InvalidPairProvisioningInputError()
  normalized.sort((left, right) => left.userId.localeCompare(right.userId))
  const first = normalized[0]
  const second = normalized[1]
  if (first === undefined || second === undefined)
    throw new InvalidPairProvisioningInputError()
  return { members: [first, second] }
}

export async function readBoundedProvisioningInput(
  stream: Readable,
): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string)
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) {
      stream.destroy()
      throw new InvalidPairProvisioningInputError()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function formatPairProvisioningOutput(
  result: PairProvisioningResult,
): string {
  return `${JSON.stringify({
    status: result.status,
    spaceId: result.spaceId,
    members: [...result.members]
      .sort((left, right) => left.userId.localeCompare(right.userId))
      .map(({ memberId, userId }) => ({ memberId, userId })),
  })}\n`
}

interface ProvisionPairCliDependencies {
  readonly readInput: () => Promise<string>
  readonly provision: (
    input: PairProvisioningInput,
  ) => Promise<PairProvisioningResult>
  readonly writeStdout: (value: string) => void
  readonly writeStderr: (value: string) => void
}

export async function runProvisionPairCli(
  dependencies: ProvisionPairCliDependencies,
): Promise<number> {
  let source: string
  try {
    source = await dependencies.readInput()
  } catch (error: unknown) {
    if (!(error instanceof InvalidPairProvisioningInputError)) {
      dependencies.writeStderr('Provisioning failed\n')
      return 1
    }
    dependencies.writeStderr('Invalid provisioning input\n')
    return 2
  }
  let input: PairProvisioningInput
  try {
    input = parsePairProvisioningInput(source)
  } catch {
    dependencies.writeStderr('Invalid provisioning input\n')
    return 2
  }
  try {
    const result = await dependencies.provision(input)
    dependencies.writeStdout(formatPairProvisioningOutput(result))
    return 0
  } catch (error: unknown) {
    if (error instanceof PairProvisioningInputError) {
      dependencies.writeStderr('Invalid provisioning input\n')
      return 2
    }
    if (error instanceof PairProvisioningConflictError) {
      dependencies.writeStderr('Provisioning state conflict\n')
      return 3
    }
    if (error instanceof WorkspaceDependencyUnavailableError) {
      dependencies.writeStderr('Provisioning dependency unavailable\n')
      return 1
    }
    dependencies.writeStderr('Provisioning failed\n')
    return 1
  }
}
