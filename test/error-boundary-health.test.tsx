// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '../src/renderer/src/ErrorBoundary'
const OCCURRENCE = '019c0000-0000-7000-8000-000000000090'
const SENSITIVE = '/secret/project TOKEN=hvir-private'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(OCCURRENCE)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('ErrorBoundary health evidence', () => {
  it('retains the fallback and emits only an opaque occurrence identifier', () => {
    const recordRenderContainment = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { diagnostics: { recordRenderContainment } },
    })

    expect(() => {
      act(() =>
        root.render(
          <ErrorBoundary>
            <ThrowingView />
          </ErrorBoundary>,
        ),
      )
    }).not.toThrow()

    expect(host.textContent).toContain('hvir hit a rendering problem')
    expect(host.textContent).toContain(OCCURRENCE)
    expect(recordRenderContainment).toHaveBeenCalledExactlyOnceWith(OCCURRENCE)
    expect(JSON.stringify(recordRenderContainment.mock.calls)).not.toContain(SENSITIVE)
  })
})

function ThrowingView(): never {
  throw new Error(SENSITIVE)
}
