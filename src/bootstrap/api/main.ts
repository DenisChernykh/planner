import 'dotenv/config'

import { bootstrapApi } from './bootstrap-api'
import { createApiRuntimeConfig } from '@/platform/config/runtime-environment'

void bootstrapApi(createApiRuntimeConfig()).catch(() => {
  process.exitCode = 1
})
