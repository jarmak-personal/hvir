import { describe, expect, it } from 'vitest'
import {
  parseLibraryInitialization,
  parseLibraryStatus,
} from '../src/main/skillager/skillager-setup-contract'
import {
  setupInitialization,
  setupStatus,
  setupLibrary,
} from './fixtures/skillager-setup-fixture'
import { localPath } from '../src/shared/host-path'

describe('public initialization and status metadata projection', () => {
  it.each([true, false])(
    'preserves actual Git=%s and identity while discarding all other fields',
    (gitHistory) => {
      const payload = {
        ...setupInitialization(gitHistory),
        scanner: { excerpt: 'PRIVATE SCANNER EXCERPT' },
        history: { content: 'PRIVATE BODY' },
      }
      const value = parseLibraryInitialization(payload)
      expect(value).toEqual({
        library: {
          id: setupLibrary.library_id,
          root: localPath(setupLibrary.root),
          skillsRoot: localPath(setupLibrary.skills_path),
        },
        gitHistory,
      })
      expect(JSON.stringify(value)).not.toContain('PRIVATE')
      expect(parseLibraryStatus(setupStatus(gitHistory))).toEqual(value)
      expect(
        parseLibraryInitialization({
          ...payload,
          created: false,
          status: 'already-initialized',
        }),
      ).toEqual(value)
    },
  )
  it.each([
    { schema: 'other' },
    { status: 'ready' },
    { created: false },
    { indexed: -1 },
    { library: { ...setupLibrary, library_id: 'unrecognized' } },
    { library: { ...setupLibrary, registration: 'mismatch' } },
    { library: { ...setupLibrary, skills_path: '/elsewhere' } },
    { git: { mode: 'system', repository: false } },
    { git: { mode: 'other' } },
  ])('rejects an incompatible or inconsistent init projection %j', (change) => {
    expect(() =>
      parseLibraryInitialization({ ...setupInitialization(), ...change }),
    ).toThrow('invalid library setup result')
  })
  it('does not expose indexing errors, warnings or degraded metadata as ready', () => {
    for (const payload of [
      { ...setupInitialization(), errors: ['PRIVATE BODY'] },
      { ...setupInitialization(), warnings: ['PRIVATE BODY'] },
    ]) {
      expect(() => parseLibraryInitialization(payload)).toThrow(
        expect.objectContaining({
          reason: 'unavailable',
        }),
      )
      expect(() => parseLibraryInitialization(payload)).not.toThrow('PRIVATE BODY')
    }
    expect(() => parseLibraryStatus({ ...setupStatus(), status: 'degraded' })).toThrow(
      'degraded',
    )
    expect(
      parseLibraryStatus({
        schema: 'skillager.library-status.v1',
        status: 'not-initialized',
        initialized: false,
        library: null,
        git: null,
      }),
    ).toEqual({})
    expect(() =>
      parseLibraryStatus({ ...setupStatus(), status: 'not-initialized' }),
    ).toThrow()
  })
})
