import { describe, expect, it, vi } from 'vitest'

import { ViewerCommandTargets } from '../src/renderer/src/viewer/viewer-command-targets'

describe('viewer command targets', () => {
  it('routes to only the selected tab and revokes an unmounted target', () => {
    const targets = new ViewerCommandTargets()
    const primary = { findInFile: vi.fn(), goToLine: vi.fn() }
    const secondary = { findInFile: vi.fn(), goToLine: vi.fn() }
    targets.register('primary', primary)
    const disposeSecondary = targets.register('secondary', secondary)

    targets.goToLine('secondary')
    expect(primary.goToLine).not.toHaveBeenCalled()
    expect(secondary.goToLine).toHaveBeenCalledOnce()
    targets.findInFile('secondary')
    expect(primary.findInFile).not.toHaveBeenCalled()
    expect(secondary.findInFile).toHaveBeenCalledOnce()

    disposeSecondary()
    disposeSecondary()
    targets.goToLine('secondary')
    expect(secondary.goToLine).toHaveBeenCalledOnce()
  })

  it('does not let an old disposer revoke a replacement target', () => {
    const targets = new ViewerCommandTargets()
    const first = { findInFile: vi.fn(), goToLine: vi.fn() }
    const replacement = { findInFile: vi.fn(), goToLine: vi.fn() }
    const disposeFirst = targets.register('tab', first)
    targets.register('tab', replacement)

    disposeFirst()
    targets.goToLine('tab')
    expect(replacement.goToLine).toHaveBeenCalledOnce()
  })
})
