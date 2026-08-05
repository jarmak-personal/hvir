import { describe, expect, it, vi } from 'vitest'

import {
  configureApplicationRuntime,
  SSH_ACCEPTANCE_USER_DATA_DIRECTORY,
} from '../src/main/application-runtime-policy'

describe('application runtime build channel', () => {
  it.each(['release', 'development', 'smoke'] as const)(
    'preserves the existing user-data authority for %s builds',
    (buildChannel) => {
      const setPath = vi.fn()
      const runtime = configureApplicationRuntime(
        {
          getPath: (name) => (name === 'userData' ? '/existing/hvir' : '/apps'),
          setPath,
        },
        buildChannel,
      )

      expect(runtime).toEqual({ buildChannel, userDataRoot: '/existing/hvir' })
      expect(setPath).not.toHaveBeenCalled()
    },
  )

  it('selects an explicit hvir-owned SSH acceptance root before storage wiring', () => {
    const setPath = vi.fn()
    const runtime = configureApplicationRuntime(
      {
        getPath: (name) => (name === 'appData' ? '/application-data' : '/release'),
        setPath,
      },
      'ssh-acceptance',
    )

    const expected = `/application-data/${SSH_ACCEPTANCE_USER_DATA_DIRECTORY}`
    expect(runtime).toEqual({
      buildChannel: 'ssh-acceptance',
      userDataRoot: expected,
    })
    expect(setPath).toHaveBeenCalledOnce()
    expect(setPath).toHaveBeenCalledWith('userData', expected)
  })
})
