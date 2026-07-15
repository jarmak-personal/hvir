import { describe, expect, it } from 'vitest'

import { asHostId, hostPath } from '../src/shared'
import {
  detectTerminalFileLinks,
  parseTerminalFileTarget,
  resolveTerminalFileTarget,
} from '../src/renderer/src/terminal/terminal-file-link'

const root = hostPath(asHostId('remote'), '/srv/project')

describe('terminal file links', () => {
  it('detects conservative path forms and line decorations', () => {
    expect(detectTerminalFileLinks('at src/main.ts:12:4 and README.md.')).toEqual([
      { target: 'src/main.ts:12:4', start: 3, end: 18 },
      { target: 'README.md', start: 24, end: 32 },
    ])
  })

  it('parses file URIs and line positions', () => {
    expect(parseTerminalFileTarget('file:///srv/project/a%20b.ts')).toEqual({
      path: '/srv/project/a b.ts',
    })
    expect(parseTerminalFileTarget('./src/main.ts:9:2')).toEqual({
      path: './src/main.ts',
      line: 9,
      column: 2,
    })
  })

  it('keeps relative and absolute targets inside the active workspace', () => {
    expect(resolveTerminalFileTarget('src/main.ts:9', root)?.path).toBe(
      '/srv/project/src/main.ts',
    )
    expect(resolveTerminalFileTarget('/srv/project/README.md', root)?.path).toBe(
      '/srv/project/README.md',
    )
    expect(resolveTerminalFileTarget('../secret', root)).toBeUndefined()
    expect(resolveTerminalFileTarget('/etc/passwd', root)).toBeUndefined()
  })

  it('rejects non-file protocols and home expansion', () => {
    expect(resolveTerminalFileTarget('https://example.com/a.ts', root)).toBeUndefined()
    expect(resolveTerminalFileTarget('~/a.ts', root)).toBeUndefined()
  })
})
