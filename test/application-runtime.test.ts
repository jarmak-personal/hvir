import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { localPath } from '../src/shared'
import {
  configureApplicationRuntime,
  SSH_ACCEPTANCE_USER_DATA_DIRECTORY,
} from '../src/main/application-runtime-policy'
import { LocalHost } from '../src/main/project-host/local-host'

describe('application runtime build channel', () => {
  it.each(['release', 'development', 'smoke'] as const)(
    'preserves the existing user-data authority for %s builds',
    (buildChannel) => {
      const setPath = vi.fn()
      const prepareUserDataRoot = vi.fn()
      const runtime = configureApplicationRuntime(
        {
          getPath: (name) => (name === 'userData' ? '/existing/hvir' : '/apps'),
          setPath,
        },
        buildChannel,
        prepareUserDataRoot,
      )

      expect(runtime).toEqual({ buildChannel, userDataRoot: '/existing/hvir' })
      expect(setPath).not.toHaveBeenCalled()
      expect(prepareUserDataRoot).not.toHaveBeenCalled()
    },
  )

  it('creates the hvir-owned SSH acceptance root before selecting it', () => {
    const applicationData = mkdtempSync(join(tmpdir(), 'hvir-application-data-'))
    const calls: string[] = []
    const setPath = vi.fn((_name: 'userData', path: string) => {
      expect(existsSync(path)).toBe(true)
      calls.push(`set:${path}`)
    })

    try {
      const runtime = configureApplicationRuntime(
        {
          getPath: (name) => (name === 'appData' ? applicationData : '/release'),
          setPath,
        },
        'ssh-acceptance',
        (path) => {
          LocalHost.ensureBootstrapDirectory(localPath(path))
          calls.push(`prepare:${path}`)
        },
      )

      const expected = join(applicationData, SSH_ACCEPTANCE_USER_DATA_DIRECTORY)
      expect(runtime).toEqual({
        buildChannel: 'ssh-acceptance',
        userDataRoot: expected,
      })
      expect(calls).toEqual([`prepare:${expected}`, `set:${expected}`])
      expect(setPath).toHaveBeenCalledOnce()
      expect(setPath).toHaveBeenCalledWith('userData', expected)
    } finally {
      rmSync(applicationData, { recursive: true, force: true })
    }
  })

  it('does not select an SSH acceptance root when directory preparation fails', () => {
    const setPath = vi.fn()
    const failure = new Error('application data unavailable')

    expect(() =>
      configureApplicationRuntime(
        {
          getPath: (name) => (name === 'appData' ? '/application-data' : '/release'),
          setPath,
        },
        'ssh-acceptance',
        () => {
          throw failure
        },
      ),
    ).toThrow(failure)
    expect(setPath).not.toHaveBeenCalled()
  })
})
