import assert from 'node:assert/strict'

import {
  assertOwnedVolumeGone,
  assertTempRootGone,
} from './planner-restore-cleanup'

async function main(): Promise<void> {
  await assert.rejects(
    assertOwnedVolumeGone('planner-o02-owned-volume', () =>
      Promise.resolve(['planner-o02-owned-volume']),
    ),
    /owned volume/,
  )
  await assert.doesNotReject(
    assertOwnedVolumeGone('planner-o02-owned-volume', () =>
      Promise.resolve(['planner-o02-owned-volume-suffix']),
    ),
  )
  await assert.rejects(
    assertOwnedVolumeGone('planner-o02-owned-volume', () =>
      Promise.reject(new Error('read-only listing failed')),
    ),
    /read-only listing failed/,
  )
  const permissionError = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
  })
  await assert.rejects(
    assertTempRootGone('/private/tmp/planner-o02-owned-root', () =>
      Promise.reject(permissionError),
    ),
    /temporary path verification failed/,
  )
  await assert.doesNotReject(
    assertTempRootGone('/private/tmp/planner-o02-owned-root', () =>
      Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    ),
  )
  console.log(
    'cleanup proof probe: query/stat verification failures fail closed',
  )
  console.log('cleanup proof probe: PASS')
}

void main().catch(() => {
  console.error('cleanup proof probe: FAILED')
  process.exitCode = 1
})
