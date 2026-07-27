// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installDevelopmentRendererInstrumentation } from '../src/renderer/src/development/development-renderer-instrumentation'

describe('development renderer instrumentation ownership', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces the prior owner and disposes the current renderer lifetime once', () => {
    vi.useFakeTimers()
    const first = installDevelopmentRendererInstrumentation()
    expect(vi.getTimerCount()).toBe(1)

    const replacement = installDevelopmentRendererInstrumentation()
    expect(vi.getTimerCount()).toBe(1)
    expect(document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy).toBe(
      'hvir:development-performance-measure-budget:v1',
    )

    first.dispose()
    expect(vi.getTimerCount()).toBe(1)
    window.dispatchEvent(new Event('pagehide'))
    replacement.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(
      document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy,
    ).toBeUndefined()
  })
})
