import Joi from 'joi'

interface ValidatedRuntimeEnvironment {
  readonly NODE_ENV: 'development' | 'test' | 'production'
  readonly API_HOST: string
  readonly API_PORT: number
  readonly DATABASE_URL: string
  readonly DATABASE_POOL_MAX: number
}

function isPostgreSqlUrl(value: string): boolean {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export const runtimeEnvironmentSchema = Joi.object<ValidatedRuntimeEnvironment>(
  {
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'production')
      .default('development'),
    API_HOST: Joi.string().trim().min(1).default('127.0.0.1'),
    API_PORT: Joi.number().integer().min(1).max(65_535).default(3000),
    DATABASE_URL: Joi.string()
      .trim()
      .required()
      .custom((value: string, helpers) =>
        isPostgreSqlUrl(value) ? value : helpers.error('any.invalid'),
      ),
    DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
  },
)

export type { ValidatedRuntimeEnvironment }
