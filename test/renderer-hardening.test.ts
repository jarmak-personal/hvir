import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  shouldPublishDiffPosition,
  usesUnsavedContent,
} from '../src/renderer/src/viewer/diff-policy'
import { restoreCodePosition } from '../src/renderer/src/viewer/code-scroll-anchor'
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

  it('publishes a diff location only after deliberate navigation', () => {
    expect(shouldPublishDiffPosition(true, false)).toBe(false)
    expect(shouldPublishDiffPosition(true, true)).toBe(true)
    expect(shouldPublishDiffPosition(false, true)).toBe(false)
  })
})

describe('CodeMirror scroll restoration', () => {
  it('measures the captured line before applying exact or cross-mode offsets', () => {
    let request:
      | {
          readonly read: (view: {
            readonly lineBlockAt: () => { readonly top: number }
            readonly documentPadding: { readonly top: number }
          }) => unknown
          readonly write: (value: never) => void
        }
      | undefined
    const view = {
      state: { doc: { lines: 20, line: () => ({ from: 120 }) } },
      requestMeasure: (next: typeof request) => (request = next),
    }
    const root = { scrollTop: 0 }
    const measured = {
      lineBlockAt: () => ({ top: 700 }),
      documentPadding: { top: 8 },
    }

    restoreCodePosition(
      view as never,
      root as never,
      { mode: 'source', line: 13, scrollTop: 320 },
      'source',
    )
    expect(root.scrollTop).toBe(0)
    request?.write(request.read(measured) as never)
    expect(root.scrollTop).toBe(320)

    restoreCodePosition(
      view as never,
      root as never,
      { mode: 'source', line: 13, scrollTop: 320 },
      'diff',
    )
    request?.write(request.read(measured) as never)
    expect(root.scrollTop).toBe(708)
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
    expect(INVOKE_CHANNELS).toContain('harness:probe-snapshot')
    expect(INVOKE_CHANNELS).toContain('harness:probe-templates')
    expect(INVOKE_CHANNELS).toContain('harness:profile-materialize')
  })

  it('keeps the Harnesses editor wide and the add flow keyboard-addressable', () => {
    const styles = ['settings.css', 'harness-settings.css', 'terminal-list.css']
      .map((file) =>
        readFileSync(join(process.cwd(), 'src/renderer/src/styles', file), 'utf8'),
      )
      .join('\n')
    const dialogs = readFileSync(
      join(process.cwd(), 'src/renderer/src/settings/HarnessProfileDialogs.tsx'),
      'utf8',
    )
    expect(styles).toMatch(
      /\.project-dialog\.settings-dialog\s*\{[^}]*width:\s*min\(1240px,/s,
    )
    expect(styles).toMatch(
      /@media \(max-width: 800px\)[\s\S]*\.settings-section-selector\s*\{[^}]*display:\s*grid/s,
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
