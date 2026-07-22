import { describe, expect, it, vi } from 'vitest'

import { unexpectedConsoleOutput } from './test-console-output-policy'

describe('test console output policy', () => {
  it.each(['warn', 'error'] as const)(
    'reports uncaptured console.%s output with its original detail and remediation',
    (method) => {
      expect(() => {
        throw unexpectedConsoleOutput(method, ['profile failed', new Error('probe')])
      }).toThrow(
        'Capture and assert intentional warning/error paths in the owning test.\n' +
          'profile failed Error: probe',
      )
    },
  )

  it('allows an intentional warning path to capture and assert locally', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    console.warn('expected warning')

    expect(warning).toHaveBeenCalledWith('expected warning')
    warning.mockRestore()
  })
})
