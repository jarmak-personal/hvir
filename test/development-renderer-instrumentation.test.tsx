// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT } from '../src/renderer/src/development/development-performance-events'
import { installDevelopmentRendererInstrumentation } from '../src/renderer/src/development/development-renderer-instrumentation'

const fixtureInstances = vi.hoisted(
  () => [] as Array<{ readonly dispose: () => void; readonly start: () => void }>,
)

vi.mock('../src/renderer/src/development/development-performance-fixture', () => ({
  DevelopmentPerformanceFixture: class {
    readonly dispose = vi.fn()
    readonly start = vi.fn()

    constructor() {
      fixtureInstances.push(this)
    }
  },
}))

describe('development renderer fixture ownership', () => {
  beforeEach(() => {
    fixtureInstances.length = 0
  })

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'))
  })

  it('replaces the prior owner and starts one disposable fixture per lifetime', () => {
    const first = installDevelopmentRendererInstrumentation()
    requestFixture()
    expect(fixtureInstances).toHaveLength(1)
    expect(fixtureInstances[0]?.start).toHaveBeenCalledOnce()

    const replacement = installDevelopmentRendererInstrumentation()
    expect(fixtureInstances[0]?.dispose).toHaveBeenCalledOnce()

    requestFixture()
    requestFixture()
    expect(fixtureInstances).toHaveLength(2)
    expect(fixtureInstances[1]?.start).toHaveBeenCalledOnce()

    first.dispose()
    window.dispatchEvent(new Event('pagehide'))
    replacement.dispose()
    expect(fixtureInstances[1]?.dispose).toHaveBeenCalledOnce()

    requestFixture()
    expect(fixtureInstances).toHaveLength(2)
  })
})

function requestFixture(): void {
  window.dispatchEvent(new Event(DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT))
}
