import type { ValidationError } from 'class-validator'

import type { ProblemFieldError } from './problem.contracts'

const codes = Object.freeze({
  isDefined: 'required',
  isNotEmpty: 'required',
  whitelistValidation: 'unknown_field',
  isString: 'invalid_type',
  isArray: 'invalid_type',
  isObject: 'invalid_type',
  isBoolean: 'invalid_type',
  isNumber: 'invalid_type',
  isInt: 'invalid_type',
  isEmail: 'invalid_format',
  isDateString: 'invalid_format',
  isUUID: 'invalid_format',
  matches: 'invalid_format',
  isEnum: 'invalid_value',
  minLength: 'too_short',
  maxLength: 'too_long',
  arrayMinSize: 'too_few_items',
  arrayMaxSize: 'too_many_items',
} as const)

const details: Readonly<
  Record<(typeof codes)[keyof typeof codes] | 'invalid_value', string>
> = Object.freeze({
  required: 'Required field is missing.',
  unknown_field: 'Field is not allowed.',
  invalid_type: 'Field has an invalid type.',
  invalid_format: 'Field has an invalid format.',
  invalid_value: 'Field has an invalid value.',
  too_short: 'Field is shorter than allowed.',
  too_long: 'Field is longer than allowed.',
  too_few_items: 'Field has fewer items than allowed.',
  too_many_items: 'Field has more items than allowed.',
})

export function mapValidationErrors(
  errors: readonly ValidationError[],
): readonly ProblemFieldError[] {
  const result: ProblemFieldError[] = []
  for (const error of errors) collect(error, '', result)
  const deduplicated = new Map(
    result.map((issue) => [`${issue.pointer}\u0000${issue.code}`, issue]),
  )
  return Object.freeze(
    [...deduplicated.values()]
      .sort(
        (left, right) =>
          compareCodeUnits(left.pointer, right.pointer) ||
          compareCodeUnits(left.code, right.code),
      )
      .map((issue) => Object.freeze(issue)),
  )
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function collect(
  error: ValidationError,
  parent: string,
  output: ProblemFieldError[],
): void {
  const pointer =
    typeof error.property === 'string' && error.property.length > 0
      ? `${parent}/${error.property.replaceAll('~', '~0').replaceAll('/', '~1')}`
      : parent
  for (const constraint of Object.keys(error.constraints ?? {}).sort()) {
    const code = codes[constraint as keyof typeof codes] ?? 'invalid_value'
    output.push({ pointer, code, detail: details[code] })
  }
  for (const child of error.children ?? []) collect(child, pointer, output)
}
