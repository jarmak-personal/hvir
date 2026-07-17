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
    const settings = readFileSync(
      join(process.cwd(), 'src/renderer/src/settings/HarnessProfilesSettings.tsx'),
      'utf8',
    )
    expect(styles).toMatch(
      /\.project-dialog\.settings-dialog\s*\{[^}]*width:\s*min\(1120px,/s,
    )
    expect(settings).toContain('aria-labelledby="add-harness-title"')
    expect(settings).toContain("event.key === 'Escape'")
    expect(settings).toContain("event.key !== 'Tab'")
  })
})
