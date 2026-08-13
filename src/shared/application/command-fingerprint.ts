import { createHash } from 'node:crypto'

import type {
  ApplicationCommand,
  CanonicalJsonValue,
  CommandDefinition,
} from './application-command'
import { CommandValidationError } from './application-command'

function assertValidString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CommandValidationError()
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CommandValidationError()
    }
  }
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    assertValidString(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new CommandValidationError()
    }
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new CommandValidationError()
  if (ancestors.has(value)) throw new CommandValidationError()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new CommandValidationError()
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new CommandValidationError()
        }
      }
      return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new CommandValidationError()
    }
    const object = value as Record<string, unknown>
    const entries = Object.keys(object)
      .sort()
      .map((key) => {
        assertValidString(key)
        return `${JSON.stringify(key)}:${serialize(object[key], ancestors)}`
      })
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJsonStringify(value: CanonicalJsonValue): string {
  return serialize(value, new Set())
}

export function commandFingerprintPreimage<TPayload, K extends string>(
  definition: CommandDefinition<TPayload, K>,
  command: ApplicationCommand<TPayload>,
): string {
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(
    command,
    'expectedRevision',
  )
  if (
    (hasExpectedRevision && typeof command.expectedRevision !== 'bigint') ||
    (!hasExpectedRevision && command.expectedRevision !== undefined) ||
    (typeof command.expectedRevision === 'bigint' &&
      command.expectedRevision < 0n)
  ) {
    throw new CommandValidationError()
  }
  const payload = definition.toCanonicalPayload(command.payload)
  return canonicalJsonStringify({
    commandType: definition.commandType,
    expectedRevision:
      command.expectedRevision === undefined
        ? null
        : command.expectedRevision.toString(10),
    payload,
  })
}

export function commandFingerprint<TPayload, K extends string>(
  definition: CommandDefinition<TPayload, K>,
  command: ApplicationCommand<TPayload>,
): string {
  return createHash('sha256')
    .update(commandFingerprintPreimage(definition, command), 'utf8')
    .digest('hex')
}
