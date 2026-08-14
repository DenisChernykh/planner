import 'dotenv/config'

import { createPlannerWorkerRuntimeConfig } from '@/platform/config/planner-worker-runtime-config'

import { runPlannerWorker } from './run-planner-worker'

void runPlannerWorker(createPlannerWorkerRuntimeConfig()).catch(() => {
  process.exitCode = 1
})
