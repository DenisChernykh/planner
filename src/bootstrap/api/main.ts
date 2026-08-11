import 'dotenv/config'

import { createApiRuntimeConfig } from '@/platform/config/runtime-environment'

import { runApi } from './run-api'

void runApi(createApiRuntimeConfig()).catch(() => {
  process.exitCode = 1
})
