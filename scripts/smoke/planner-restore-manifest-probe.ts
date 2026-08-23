import assert from 'node:assert/strict'

import { compareSafeArrays } from './planner-restore-assertions'

const marker = 'O02_MARKER_SECRET_RAW_TELEGRAM_ID_4503599627370491'

function main(): void {
  let message = ''
  try {
    compareSafeArrays(
      'probe.manifest',
      [{ id: marker, payload: 'marker text' }],
      [{ id: marker, payload: 'changed marker text' }],
    )
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : ''
  }
  assert.notEqual(message, '')
  assert.equal(message.includes(marker), false)
  assert.equal(message.includes('marker text'), false)
  console.log(
    'manifest mismatch probe: no marker leakage; safe mismatch reported',
  )
  console.log('manifest mismatch probe: PASS')
}

try {
  main()
} catch {
  console.error('manifest mismatch probe: FAILED')
  process.exitCode = 1
}
