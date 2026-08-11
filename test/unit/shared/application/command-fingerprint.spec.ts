import type {
  ApplicationCommand,
  CanonicalJsonObject,
  CommandDefinition,
} from '@/shared/application/application-command'
import {
  canonicalJsonStringify,
  commandFingerprint,
  commandFingerprintPreimage,
} from '@/shared/application/command-fingerprint'
import { CommandValidationError } from '@/shared/application/application-command'

type UpdateFocusPayload = {
  readonly planMonthId: string
  readonly focus: string
}

const definition: CommandDefinition<
  UpdateFocusPayload,
  'planning.plan-draft.v1'
> = {
  commandType: 'planning.update-month-focus.v1',
  resultKind: 'planning.plan-draft.v1',
  toCanonicalPayload(payload): CanonicalJsonObject {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      Object.keys(payload).sort().join(',') !== 'focus,planMonthId' ||
      typeof payload.planMonthId !== 'string' ||
      typeof payload.focus !== 'string'
    ) {
      throw new CommandValidationError()
    }
    return { planMonthId: payload.planMonthId, focus: payload.focus }
  },
}

function command(
  overrides: Partial<ApplicationCommand<UpdateFocusPayload>> = {},
): ApplicationCommand<UpdateFocusPayload> {
  return {
    commandId: '11111111-1111-4111-8111-111111111111',
    trustedActor: {
      kind: 'member',
      id: '22222222-2222-4222-8222-222222222222',
    },
    expectedRevision: 7n,
    payload: {
      focus: 'Прожить апрель',
      planMonthId: '018f0000-0000-7000-8000-000000000001',
    },
    ...overrides,
  }
}

describe('canonical command fingerprint v1', () => {
  it('matches the locked UTF-8 SHA-256 vector and exact preimage', () => {
    expect(commandFingerprintPreimage(definition, command())).toBe(
      '{"commandType":"planning.update-month-focus.v1","expectedRevision":"7","payload":{"focus":"Прожить апрель","planMonthId":"018f0000-0000-7000-8000-000000000001"}}',
    )
    expect(commandFingerprint(definition, command())).toBe(
      'd2a4181c1d2a1f3ce552e90e927be25f2ff2cc7f6f431ec39de2f8580c72f5de',
    )
  })

  it('sorts recursive object keys by UTF-16 code units while preserving arrays and exact strings', () => {
    expect(
      canonicalJsonStringify({
        z: [{ b: 2, a: 1 }, ' e\u0301 ', 'é'],
        a: { '\uffff': true, A: false },
      }),
    ).toBe('{"a":{"A":false,"￿":true},"z":[{"a":1,"b":2}," é ","é"]}')
  })

  it('preserves finite decimals while rejecting only unsafe integer numbers', () => {
    expect(canonicalJsonStringify({ value: 1.25 })).toBe('{"value":1.25}')
  })

  it('excludes actor and command ID but includes absent/present expected revision and exact payload bytes', () => {
    const baseline = commandFingerprint(definition, command())
    expect(
      commandFingerprint(
        definition,
        command({
          commandId: '33333333-3333-4333-8333-333333333333',
          trustedActor: { kind: 'system', id: 'planner-worker' },
        }),
      ),
    ).toBe(baseline)
    expect(
      commandFingerprint(definition, command({ expectedRevision: 8n })),
    ).not.toBe(baseline)
    expect(
      commandFingerprint(
        definition,
        command({
          payload: {
            ...command().payload,
            focus: ' Прожить апрель ',
          },
        }),
      ),
    ).not.toBe(baseline)
    const withoutRevision: ApplicationCommand<UpdateFocusPayload> = {
      commandId: command().commandId,
      trustedActor: command().trustedActor,
      payload: command().payload,
    }
    expect(commandFingerprintPreimage(definition, withoutRevision)).toContain(
      '"expectedRevision":null',
    )
  })

  it('rejects extra payload fields before hashing', () => {
    expect(() =>
      commandFingerprint(
        definition,
        command({
          payload: {
            ...command().payload,
            spaceId: '33333333-3333-4333-8333-333333333333',
          } as unknown as UpdateFocusPayload,
        }),
      ),
    ).toThrow(CommandValidationError)
  })

  it.each([
    ['undefined', { value: undefined }],
    ['payload bigint', { value: 1n }],
    ['unsafe number', { value: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN', { value: Number.NaN }],
    ['infinity', { value: Number.POSITIVE_INFINITY }],
    ['Date', { value: new Date('2026-04-01T00:00:00.000Z') }],
    ['class instance', { value: new (class Payload {})() }],
    ['unpaired high surrogate', { value: '\ud800' }],
    ['unpaired low surrogate', { value: '\udc00' }],
  ])('fails closed for %s', (_label, value) => {
    expect(() =>
      canonicalJsonStringify(value as unknown as CanonicalJsonObject),
    ).toThrow(CommandValidationError)
  })

  it('fails closed for cyclic objects', () => {
    const value: Record<string, unknown> = {}
    value['self'] = value
    expect(() => canonicalJsonStringify(value as CanonicalJsonObject)).toThrow(
      CommandValidationError,
    )
  })

  it('rejects sparse arrays instead of colliding with an empty array', () => {
    expect(canonicalJsonStringify([])).toBe('[]')
    expect(() =>
      canonicalJsonStringify(Array(1) as unknown as CanonicalJsonObject),
    ).toThrow(CommandValidationError)
  })

  it('rejects Array subclasses', () => {
    class PayloadArray extends Array<string> {}
    expect(() =>
      canonicalJsonStringify(
        new PayloadArray('value') as unknown as CanonicalJsonObject,
      ),
    ).toThrow(CommandValidationError)
  })
})
