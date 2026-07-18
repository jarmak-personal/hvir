import { describe, expect, it } from 'vitest'

import { asHostId, hostPath } from '../src/shared'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  normalizeTerminalWebTarget,
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
    expect(resolveTerminalFileTarget('src/main.ts:9', root)).toEqual({
      path: hostPath(asHostId('remote'), '/srv/project/src/main.ts'),
      line: 9,
    })
    expect(resolveTerminalFileTarget('/srv/project/README.md', root)?.path.path).toBe(
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

describe('terminal web links', () => {
  it('detects scheme-less loopback server links with their positions', () => {
    expect(detectTerminalWebLinks('serving at localhost:5174')).toEqual([
      { target: 'localhost:5174', start: 11, end: 24 },
    ])
    expect(detectTerminalWebLinks('open 127.0.0.1:8082/reef?tab=1 now')).toEqual([
      { target: '127.0.0.1:8082/reef?tab=1', start: 5, end: 29 },
    ])
    expect(detectTerminalWebLinks('bound to 0.0.0.0:3000.')).toEqual([
      { target: '0.0.0.0:3000', start: 9, end: 20 },
    ])
    expect(detectTerminalWebLinks('IPv6 [::1]:4173/app')).toEqual([
      { target: '[::1]:4173/app', start: 5, end: 18 },
    ])
    expect(detectTerminalWebLinks('all interfaces [::]:4173')).toEqual([
      { target: '[::]:4173', start: 15, end: 23 },
    ])
    expect(detectTerminalWebLinks('query localhost:5173?mode=agent')).toEqual([
      { target: 'localhost:5173?mode=agent', start: 6, end: 30 },
    ])
  })

  it('claims schemed loopback URLs before the built-in detector and skips lookalikes', () => {
    expect(detectTerminalWebLinks('see http://localhost:8082/reef')).toEqual([
      { target: 'http://localhost:8082/reef', start: 4, end: 29 },
    ])
    expect(detectTerminalWebLinks('see http://localhost/reef')).toEqual([
      { target: 'http://localhost/reef', start: 4, end: 24 },
    ])
    expect(detectTerminalWebLinks('ratio 12:34 and time 08:15:00')).toEqual([])
    expect(detectTerminalWebLinks('remote-host:8080/path')).toEqual([])
    expect(detectTerminalWebLinks('invalid localhost:65536')).toEqual([])
    expect(detectTerminalWebLinks('claimed http://localhost:65536')).toEqual([
      { target: 'http://localhost:65536', start: 8, end: 29 },
    ])
    expect(detectTerminalWebLinks('claimed http://user:pass@localhost:5173/')).toEqual([
      { target: 'http://user:pass@localhost:5173/', start: 8, end: 39 },
    ])
    expect(detectTerminalFileLinks('see http://localhost:8082/reef')).toEqual([])
  })

  it('normalizes clicked loopback targets to http URLs', () => {
    expect(normalizeTerminalWebTarget('localhost:8082/reef')).toBe(
      'http://localhost:8082/reef',
    )
    expect(normalizeTerminalWebTarget('127.0.0.1:5174')).toBe('http://127.0.0.1:5174/')
    expect(normalizeTerminalWebTarget('localhost:8082/reef).')).toBe(
      'http://localhost:8082/reef',
    )
    expect(normalizeTerminalWebTarget('[::1]:4173/app')).toBe('http://[::1]:4173/app')
    expect(normalizeTerminalWebTarget('0.0.0.0:3000')).toBe('http://localhost:3000/')
    expect(normalizeTerminalWebTarget('http://user:pass@localhost:5173/')).toBeUndefined()
    expect(normalizeTerminalWebTarget('localhost:65536')).toBeUndefined()
    expect(normalizeTerminalWebTarget('src/main.ts:9')).toBeUndefined()
    expect(normalizeTerminalWebTarget('example.com:8080/x')).toBeUndefined()
  })
})
