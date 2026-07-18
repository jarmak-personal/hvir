import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { usesUnsavedContent } from '../src/renderer/src/viewer/diff-policy'
import { INVOKE_CHANNELS } from '../src/shared'

describe('renderer diff policy', () => {
  it('uses a dirty buffer only for live-file comparisons', () => {
    expect(usesUnsavedContent(true, 'working-tree')).toBe(true)
    expect(usesUnsavedContent(true, 'head')).toBe(true)
    expect(usesUnsavedContent(false, 'head')).toBe(false)
  })

  it('keeps branch-point and historical diffs immutable', () => {
    expect(usesUnsavedContent(true, 'branch-point')).toBe(false)
    expect(usesUnsavedContent(true, 'head', 'deadbeef')).toBe(false)
  })
})

describe('renderer filesystem contract', () => {
  it('exposes typed target-resolution and Git-decoration operations', () => {
    expect(INVOKE_CHANNELS).toContain('fs:resolve-entry')
    expect(INVOKE_CHANNELS).toContain('git:ignored-entries')
    expect(INVOKE_CHANNELS).toContain('git:branches')
    expect(INVOKE_CHANNELS).toContain('git:fetch')
    expect(INVOKE_CHANNELS).toContain('git:pull')
    expect(INVOKE_CHANNELS).toContain('git:switch-branch')
    expect(INVOKE_CHANNELS).toContain('harness:catalog')
    expect(INVOKE_CHANNELS).toContain('harness:probe-templates')
    expect(INVOKE_CHANNELS).toContain('harness:profile-materialize')
  })

  it('keeps the Harnesses editor wide and the add flow keyboard-addressable', () => {
    const styles = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles.css'),
      'utf8',
    )
    const dialogs = readFileSync(
      join(process.cwd(), 'src/renderer/src/settings/HarnessProfileDialogs.tsx'),
      'utf8',
    )
    expect(styles).toMatch(
      /\.project-dialog\.settings-dialog\s*\{[^}]*width:\s*min\(1120px,/s,
    )
    expect(dialogs).toContain('aria-labelledby="add-harness-title"')
    expect(dialogs).toContain('Already added · use Manual profile for another')
    expect(dialogs).toContain('checking || busy || alreadyConfigured')
    expect(dialogs).toContain("event.key === 'Escape'")
    expect(dialogs).toContain("event.key !== 'Tab'")
    expect(styles).toMatch(/\.terminal-list-profile\.elevated\s*\{[^}]*#d8b36f/s)
  })

  it('captures form values before scheduling profile state updates', () => {
    const editor = readFileSync(
      join(process.cwd(), 'src/renderer/src/settings/HarnessProfileEditor.tsx'),
      'utf8',
    )
    const terminalWorkspace = readFileSync(
      join(process.cwd(), 'src/renderer/src/terminal/TerminalWorkspace.tsx'),
      'utf8',
    )
    expect(editor).not.toMatch(/displayName:\s*event\.currentTarget\.value/)
    expect(editor).not.toMatch(/description:\s*event\.currentTarget\.value/)
    expect(terminalWorkspace).not.toMatch(
      /\[session\.id\]:\s*event\.currentTarget\.value/,
    )
  })
})
