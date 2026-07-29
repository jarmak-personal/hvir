import { describe, expect, it, vi } from 'vitest'

import { ViewerCommandTargets } from '../src/renderer/src/viewer/viewer-command-targets'

describe('viewer command targets', () => {
  it('routes to only the selected tab and revokes an unmounted target', () => {
    const targets = new ViewerCommandTargets()
    const primary = { goToLine: vi.fn() }
    const secondary = { goToLine: vi.fn() }
    targets.register('primary', primary)
    const disposeSecondary = targets.register('secondary', secondary)

    targets.goToLine('secondary')
    expect(primary.goToLine).not.toHaveBeenCalled()
    expect(secondary.goToLine).toHaveBeenCalledOnce()

    disposeSecondary()
    disposeSecondary()
    targets.goToLine('secondary')
    expect(secondary.goToLine).toHaveBeenCalledOnce()
  })

  it('does not let an old disposer revoke a replacement target', () => {
    const targets = new ViewerCommandTargets()
    const first = { goToLine: vi.fn() }
    const replacement = { goToLine: vi.fn() }
    const disposeFirst = targets.register('tab', first)
    targets.register('tab', replacement)

    disposeFirst()
    targets.goToLine('tab')
    expect(replacement.goToLine).toHaveBeenCalledOnce()
  })
})
