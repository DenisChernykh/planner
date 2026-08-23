import { stat as fsStat } from 'node:fs/promises'

type StatFunction = (path: string) => Promise<unknown>

export async function assertOwnedVolumeGone(
  volumeName: string,
  listMatchingVolumeNames: () => Promise<readonly string[]>,
): Promise<void> {
  const listedNames = await listMatchingVolumeNames()
  if (listedNames.some((listedName) => listedName === volumeName)) {
    throw new Error('cleanup proof found an owned volume')
  }
}

export async function assertTempRootGone(
  tempRoot: string,
  statFunction: StatFunction = fsStat,
): Promise<void> {
  try {
    await statFunction(tempRoot)
  } catch (error: unknown) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error as { readonly code?: unknown }).code
        : undefined
    if (code === 'ENOENT') return
    throw new Error('cleanup proof temporary path verification failed', {
      cause: error,
    })
  }
  throw new Error('cleanup proof found temporary artifact')
}
