import { format } from 'node:util'

import { beforeEach, vi } from 'vitest'

if ('document' in globalThis) {
  // React uses this renderer-environment signal to validate act() coverage.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
}

export function unexpectedConsoleOutput(
  method: 'error' | 'warn',
  values: readonly unknown[],
): Error {
  return new Error(
    [
      `Unexpected console.${method} reached the test runner.`,
      'Capture and assert intentional warning/error paths in the owning test.',
      format(...values),
    ].join('\n'),
  )
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation((...values: unknown[]) => {
    throw unexpectedConsoleOutput('warn', values)
  })
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    throw unexpectedConsoleOutput('error', values)
  })
})
