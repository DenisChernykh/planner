import { createPairProvisioningRuntime } from '@/modules/workspace/composition/pair-provisioning.runtime'
import { createProvisionPairRuntimeConfig } from '@/platform/config/provision-pair-runtime-config'

import {
  readBoundedProvisioningInput,
  runProvisionPairCli,
} from './provision-pair.cli'

async function main(): Promise<number> {
  let runtime: ReturnType<typeof createPairProvisioningRuntime>
  try {
    runtime = createPairProvisioningRuntime(createProvisionPairRuntimeConfig())
  } catch {
    process.stderr.write('Provisioning configuration invalid\n')
    return 1
  }
  try {
    await runtime.start(AbortSignal.timeout(5_000))
    return await runProvisionPairCli({
      readInput: () => readBoundedProvisioningInput(process.stdin),
      provision: (input) => runtime.provision(input),
      writeStdout: (value) => process.stdout.write(value),
      writeStderr: (value) => process.stderr.write(value),
    })
  } catch {
    process.stderr.write('Provisioning dependency unavailable\n')
    return 1
  } finally {
    await runtime.close(AbortSignal.timeout(5_000)).catch(() => undefined)
  }
}

void main().then((exitCode) => {
  process.exitCode = exitCode
})
