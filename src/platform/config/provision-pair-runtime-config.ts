import { runtimeDefaults } from './runtime-defaults'
import {
  RuntimeConfigurationError,
  type DatabaseRuntimeConfig,
} from './runtime-config.types'

export interface ProvisionPairRuntimeConfig {
  readonly database: DatabaseRuntimeConfig
}

function databaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() !== value || value === '')
    return undefined
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function poolMax(value: unknown): number | undefined {
  if (value === undefined) return 10
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined
}

export function buildProvisionPairRuntimeConfig(
  input: Record<string, unknown>,
): ProvisionPairRuntimeConfig {
  const url = databaseUrl(input['DATABASE_URL'])
  const max = poolMax(input['DATABASE_POOL_MAX'])
  const issues = []
  if (url === undefined)
    issues.push({ path: 'DATABASE_URL', rule: 'any.invalid' })
  if (max === undefined)
    issues.push({ path: 'DATABASE_POOL_MAX', rule: 'number.base' })
  if (issues.length > 0) throw new RuntimeConfigurationError(issues)
  return Object.freeze({
    database: Object.freeze({
      url: url as string,
      poolMax: max as number,
      ...runtimeDefaults.database,
    }),
  })
}

export function createProvisionPairRuntimeConfig(): ProvisionPairRuntimeConfig {
  return buildProvisionPairRuntimeConfig(process.env)
}
