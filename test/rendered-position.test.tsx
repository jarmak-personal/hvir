// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  captureRenderedPosition,
  restoreRenderedPosition,
} from '../src/renderer/src/viewer/rendered-position'

describe('rendered position geometry budget', () => {
  it('captures a visible source anchor with logarithmic live geometry reads', () => {
    const root = document.createElement('div')
    root.innerHTML = Array.from(
      { length: 4000 },
      (_, index) => `<p data-source-line="${index + 1}">line</p>`,
    ).join('')
    const measure = vi.fn()
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    for (const [index, child] of [...root.children].entries())
      vi.spyOn(child, 'getBoundingClientRect').mockImplementation(() => {
        measure()
        return { top: index * 20 - 4200 } as DOMRect
      })
    root.scrollTop = 4200
    expect(captureRenderedPosition(root, 4000)).toEqual({
      mode: 'rendered',
      line: 211,
      scrollTop: 4200,
    })
    expect(measure.mock.calls.length).toBeLessThanOrEqual(13)
    measure.mockClear()
    restoreRenderedPosition(root, { mode: 'source', line: 500, scrollTop: 0 }, 4000)
    expect(root.scrollTop).toBe(499 * 20)
    expect(measure).toHaveBeenCalledOnce()
  })
})
