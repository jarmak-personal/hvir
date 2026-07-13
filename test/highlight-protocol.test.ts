import { describe, expect, it } from 'vitest'

import { languageForPath } from '../src/renderer/src/viewer/highlight-protocol'

describe('source highlighting language inference', () => {
  it.each([
    ['eslint.config.mjs', 'javascript'],
    ['legacy.cjs', 'javascript'],
    ['config.mts', 'typescript'],
    ['config.cts', 'typescript'],
  ] as const)('classifies %s as %s', (path, language) => {
    expect(languageForPath(`/project/${path}`)).toBe(language)
  })

  it('matches module extensions case-insensitively', () => {
    expect(languageForPath('/project/SCRIPT.MJS')).toBe('javascript')
  })
})
