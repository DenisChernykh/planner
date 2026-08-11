import { Readable } from 'node:stream'

import {
  formatPairProvisioningOutput,
  InvalidPairProvisioningInputError,
  parsePairProvisioningInput,
  readBoundedProvisioningInput,
  runProvisionPairCli,
} from '@/bootstrap/provision-pair/provision-pair.cli'
import {
  PairProvisioningConflictError,
  WorkspaceDependencyUnavailableError,
} from '@/modules/workspace/application/workspace-errors'
import type { PairProvisioningResult } from '@/modules/workspace/application/pair-workspace.port'
import {
  existingMemberId,
  existingSpaceId,
} from '@/modules/workspace/domain/workspace-ids'
import { buildProvisionPairRuntimeConfig } from '@/platform/config/provision-pair-runtime-config'

const firstUserId = '11111111-1111-4111-8111-111111111111'
const secondUserId = '22222222-2222-4222-8222-222222222222'
const firstTelegramId = '9007199254740993'
const secondTelegramId = '9223372036854775807'

function validInput(): string {
  return JSON.stringify({
    members: [
      { userId: secondUserId, telegramId: secondTelegramId },
      { userId: firstUserId, telegramId: firstTelegramId },
    ],
  })
}

describe('A01 pair provisioning CLI boundary', () => {
  it('parses exact unordered input without losing signed-BIGINT precision', () => {
    expect(parsePairProvisioningInput(validInput())).toEqual({
      members: [
        { userId: firstUserId, telegramId: 9007199254740993n },
        { userId: secondUserId, telegramId: 9223372036854775807n },
      ],
    })
  })

  it.each([
    [
      'JSON number',
      {
        members: [
          { userId: firstUserId, telegramId: 42 },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'leading zero',
      {
        members: [
          { userId: firstUserId, telegramId: '01' },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'zero',
      {
        members: [
          { userId: firstUserId, telegramId: '0' },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'signed text',
      {
        members: [
          { userId: firstUserId, telegramId: '+1' },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'overflow',
      {
        members: [
          { userId: firstUserId, telegramId: '9223372036854775808' },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'uppercase UUID',
      {
        members: [
          {
            userId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
            telegramId: firstTelegramId,
          },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'duplicate user',
      {
        members: [
          { userId: firstUserId, telegramId: firstTelegramId },
          { userId: firstUserId, telegramId: secondTelegramId },
        ],
      },
    ],
    [
      'duplicate Telegram ID',
      {
        members: [
          { userId: firstUserId, telegramId: firstTelegramId },
          { userId: secondUserId, telegramId: firstTelegramId },
        ],
      },
    ],
    [
      'extra root key',
      {
        members: [
          { userId: firstUserId, telegramId: firstTelegramId },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
        repair: true,
      },
    ],
    [
      'extra member key',
      {
        members: [
          { userId: firstUserId, telegramId: firstTelegramId, role: 'owner' },
          { userId: secondUserId, telegramId: secondTelegramId },
        ],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePairProvisioningInput(JSON.stringify(value))).toThrow(
      'Invalid provisioning input',
    )
  })

  it('rejects an oversized stdin document without waiting for EOF', async () => {
    const stream = Readable.from([
      Buffer.alloc(16_384, 0x20),
      Buffer.from('x'),
      Buffer.from(firstTelegramId),
    ])

    await expect(readBoundedProvisioningInput(stream)).rejects.toThrow(
      'Invalid provisioning input',
    )
  })

  it('formats finite canonical JSON sorted by userId without Telegram IDs', () => {
    const result = {
      status: 'created',
      spaceId: existingSpaceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      members: [
        {
          memberId: existingMemberId('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
          userId: secondUserId,
          telegramId: secondTelegramId,
        },
        {
          memberId: existingMemberId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          userId: firstUserId,
          telegramId: firstTelegramId,
        },
      ],
    } as unknown as PairProvisioningResult
    const output = formatPairProvisioningOutput(result)

    expect(output).toBe(
      `${JSON.stringify({
        status: 'created',
        spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        members: [
          {
            memberId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            userId: firstUserId,
          },
          {
            memberId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            userId: secondUserId,
          },
        ],
      })}\n`,
    )
    expect(output).not.toContain(firstTelegramId)
    expect(output).not.toContain(secondTelegramId)
  })

  it.each([
    [
      new InvalidPairProvisioningInputError(),
      2,
      'Invalid provisioning input\n',
    ],
    [new PairProvisioningConflictError(), 3, 'Provisioning state conflict\n'],
    [
      new WorkspaceDependencyUnavailableError(),
      1,
      'Provisioning dependency unavailable\n',
    ],
    [new Error(firstTelegramId), 1, 'Provisioning failed\n'],
  ])(
    'maps failures to safe exit code and stderr',
    async (error, exitCode, stderr) => {
      const stdout: string[] = []
      const errors: string[] = []
      const actual = await runProvisionPairCli({
        readInput: () =>
          error instanceof InvalidPairProvisioningInputError
            ? Promise.reject(error)
            : Promise.resolve(validInput()),
        provision: () => Promise.reject(error),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => errors.push(value),
      })

      expect(actual).toBe(exitCode)
      expect(stdout).toEqual([])
      expect(errors).toEqual([stderr])
      expect(errors.join('')).not.toContain(firstTelegramId)
    },
  )

  it('maps an unexpected stdin failure to exit 1 without leaking its message', async () => {
    const stderr: string[] = []
    const exitCode = await runProvisionPairCli({
      readInput: () => Promise.reject(new Error(firstTelegramId)),
      provision: () => Promise.reject(new Error('must not run')),
      writeStdout: () => undefined,
      writeStderr: (value) => stderr.push(value),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['Provisioning failed\n'])
    expect(stderr.join('')).not.toContain(firstTelegramId)
  })

  it('loads a PostgreSQL-only config projection without auth or Redis variables', () => {
    const config = buildProvisionPairRuntimeConfig({
      DATABASE_URL: 'postgresql://planner:planner@127.0.0.1:5432/planner',
      DATABASE_POOL_MAX: '3',
    })

    expect(config).toMatchObject({
      database: {
        url: 'postgresql://planner:planner@127.0.0.1:5432/planner',
        poolMax: 3,
      },
    })
    expect(config).not.toHaveProperty('redis')
    expect(config).not.toHaveProperty('auth')
  })
})
