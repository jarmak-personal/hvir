// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DomFindTarget } from '../src/renderer/src/viewer/dom-find-target'

interface HighlightRecord {
  readonly ranges: readonly Range[]
}

const highlightRecords = new Map<string, HighlightRecord>()
let animationFrame: FrameRequestCallback | undefined

beforeEach(() => {
  highlightRecords.clear()
  animationFrame = undefined
  vi.stubGlobal(
    'Highlight',
    class implements HighlightRecord {
      readonly ranges: readonly Range[]

      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    },
  )
  vi.stubGlobal('CSS', {
    highlights: {
      set: (name: string, highlight: HighlightRecord) => {
        highlightRecords.set(name, highlight)
      },
      delete: (name: string) => highlightRecords.delete(name),
    },
  })
  vi.spyOn(Element.prototype, 'checkVisibility').mockReturnValue(true)
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    animationFrame = callback
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
})

afterEach(() => {
  document.body.replaceChildren()
  document.head.querySelectorAll('style').forEach((style) => style.remove())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DomFindTarget', () => {
  it('searches visible rendered text across inline nodes and SVG labels', () => {
    const root = renderedRoot()
    const target = new DomFindTarget(root)

    expect(target.update({ text: 'Alpha needle', caseSensitive: false }, 0)).toEqual({
      current: 1,
      total: 1,
    })
    expect(activeRanges()[0]?.toString()).toBe('Alpha needle')

    expect(target.update({ text: 'needle', caseSensitive: false }, 1)).toEqual({
      current: 2,
      total: 2,
    })
    expect(activeRanges()[0]?.startContainer.parentElement?.localName).toBe('text')

    target.dispose()
  })

  it('refreshes an open session after DOM changes and removes owned resources', async () => {
    const root = renderedRoot()
    const target = new DomFindTarget(root)
    const listener = vi.fn()
    target.subscribe(listener)
    target.update({ text: 'needle', caseSensitive: false }, 0)
    const ownedStyle = document.head.lastElementChild

    root.querySelector('strong')?.replaceChildren('changed')
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    animationFrame?.(0)
    expect(listener).toHaveBeenCalledOnce()
    expect(target.update({ text: 'needle', caseSensitive: false }, 0).total).toBe(1)

    target.dispose()
    expect(highlightRecords.size).toBe(0)
    expect(ownedStyle?.isConnected).toBe(false)

    root.append('needle')
    await Promise.resolve()
    animationFrame?.(0)
    expect(listener).toHaveBeenCalledOnce()
  })
})

function renderedRoot(): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <p>Alpha <strong>needle</strong> end</p>
    <p hidden>needle</p>
    <svg><text>Diagram needle</text></svg>
  `
  document.body.append(root)
  return root
}

function activeRanges(): readonly Range[] {
  const active = [...highlightRecords.entries()].find(([name]) =>
    name.includes('find-active'),
  )
  return active?.[1].ranges ?? []
}
