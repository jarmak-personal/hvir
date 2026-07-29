// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FilenameSearch } from '../src/renderer/src/tree/FilenameSearch'
import { localPath, type FilenameSearchRequest } from '../src/shared'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('FilenameSearch', () => {
  it('searches the whole workspace and opens pointer and keyboard selections', async () => {
    const invoke = vi.fn((_channel: string, _request?: unknown) =>
      Promise.resolve({
        ok: true as const,
        value: {
          results: [
            {
              path: localPath('/repo/collapsed/needle.ts'),
              name: 'needle.ts',
              parentPath: 'collapsed',
            },
            {
              path: localPath('/repo/other/needle.test.ts'),
              name: 'needle.test.ts',
              parentPath: 'other',
            },
          ],
          traversalTruncated: true,
          resultsTruncated: false,
        },
      }),
    )
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, send },
    })
    const onOpen = vi.fn()
    const onActiveChange = vi.fn()
    act(() => {
      root.render(
        <FilenameSearch
          root={localPath('/repo')}
          connected
          gitIgnoreAvailable
          refreshVersion={4}
          onActiveChange={onActiveChange}
          onOpen={onOpen}
        />,
      )
    })
    const input = container.querySelector<HTMLInputElement>('[data-filename-search]')!
    setInput(input, 'needle')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledOnce()
    const [channel, request] = invoke.mock.calls[0]!
    expect(channel).toBe('fs:filename-search')
    expect(request).toMatchObject({
      root: localPath('/repo'),
      query: 'needle',
      includeIgnored: false,
      refreshVersion: 4,
    })
    expect((request as FilenameSearchRequest).requestId).toBeGreaterThan(0)
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    expect(container.textContent).toContain('workspace scan limited')
    expect(container.textContent).toContain('collapsed')

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    const first = container.querySelector<HTMLButtonElement>('.filename-search-result')!
    expect(document.activeElement).toBe(first)
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledWith(localPath('/repo/collapsed/needle.ts'), false)

    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>('.filename-search-result')[1]!
        .click(),
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      localPath('/repo/other/needle.test.ts'),
      false,
    )
    act(() => root.render(<div />))
    expect(send).toHaveBeenCalledWith('fs:filename-search-cancel', {
      requestId: (request as FilenameSearchRequest).requestId,
    })
  })

  it('makes ignored scope visible and recovers after reconnect', async () => {
    const invoke = vi.fn((_channel: string, _request?: unknown) =>
      Promise.resolve({
        ok: true as const,
        value: {
          results: [],
          traversalTruncated: false,
          resultsTruncated: false,
        },
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, send: vi.fn() },
    })
    const render = (connected: boolean): void => {
      root.render(
        <FilenameSearch
          root={localPath('/repo')}
          connected={connected}
          gitIgnoreAvailable
          refreshVersion={1}
          onActiveChange={vi.fn()}
          onOpen={vi.fn()}
        />,
      )
    }
    act(() => render(false))
    const input = container.querySelector<HTMLInputElement>('[data-filename-search]')!
    expect(input.disabled).toBe(false)
    expect(container.textContent).toContain('Include ignored files')
    setInput(input, 'file')
    expect(container.textContent).toContain('Reconnect to search this host')
    act(() => render(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledOnce()
  })
})

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
