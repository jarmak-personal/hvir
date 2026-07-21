// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsDialog } from '../src/renderer/src/settings/SettingsDialog'
import { DEFAULT_KEYBINDINGS, localPath } from '../src/shared'

vi.mock('../src/renderer/src/settings/HarnessProfilesSettings', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react')
  return {
    HarnessProfilesSettings: forwardRef(
      function MockHarnessProfilesSettings(_props, ref) {
        useImperativeHandle(ref, () => ({
          confirmSafeToLeave: () => Promise.resolve(true),
        }))
        return createElement(
          'section',
          { className: 'settings-harnesses' },
          createElement(
            'h3',
            { id: 'settings-harnesses-title', tabIndex: -1 },
            'Harnesses',
          ),
          createElement('input', { 'aria-label': 'Harness profile name' }),
        )
      },
    ),
  }
})

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = []

  private disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(_target: Element, _options?: ResizeObserverOptions): void {}

  unobserve(_target: Element): void {}

  disconnect(): void {
    this.disconnected = true
  }

  takeRecords(): ResizeObserverEntry[] {
    return []
  }

  fire(): void {
    if (!this.disconnected) this.callback([], this)
  }
}

const frameCallbacks = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  TestResizeObserver.instances = []
  frameCallbacks.clear()
  nextFrame = 1
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frameCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameCallbacks.delete(id)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      return domRect(this.id === 'settings-harnesses-title' ? 100 : 0)
    },
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SettingsDialog harness alignment', () => {
  it('does not reclaim field focus after a resize or parent render', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const render = (parentRevision: number): void => {
      act(() => {
        root?.render(
          createElement(SettingsDialog, {
            theme: 'dark',
            settings: {
              idleThresholdMs: 4_000,
              gitAutoFetchIntervalMs: 5 * 60_000,
              terminalRecoveryMode: 'prompt',
              terminalTheme: 'app',
              composerSubmitMode: 'enter',
              keybindings: DEFAULT_KEYBINDINGS,
            },
            workspaceRoot: localPath('/tmp/hvir'),
            projectRoot: localPath('/tmp/hvir'),
            initialSection: 'harnesses',
            onClose: () => void parentRevision,
            onSave: vi.fn(),
          }),
        )
      })
    }

    render(0)
    flushFrames()

    const heading = document.querySelector<HTMLElement>('#settings-harnesses-title')
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Harness profile name"]',
    )
    expect(heading).toBeTruthy()
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(heading)
    expect(headingFocusCount(focus)).toBe(1)
    expect(TestResizeObserver.instances).toHaveLength(1)

    TestResizeObserver.instances[0]?.fire()
    input?.focus()
    input?.setRangeText('profile', 0, 0, 'end')
    flushFrames()

    expect(document.activeElement).toBe(input)
    expect(input?.selectionStart).toBe(7)
    expect(headingFocusCount(focus)).toBe(1)

    render(1)
    flushFrames()

    expect(document.activeElement).toBe(input)
    expect(input?.selectionStart).toBe(7)
    expect(headingFocusCount(focus)).toBe(1)
  })

  it('requires explicit consent and waits for Save before changing Claude config', async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined))
    const onSave = vi.fn()
    vi.stubGlobal('hvir', { invoke, send: vi.fn(), on: vi.fn() })
    act(() => {
      root?.render(
        createElement(SettingsDialog, {
          theme: 'dark',
          settings: {
            idleThresholdMs: 4_000,
            gitAutoFetchIntervalMs: 5 * 60_000,
            terminalRecoveryMode: 'prompt',
            terminalTheme: 'app',
            composerSubmitMode: 'enter',
            keybindings: DEFAULT_KEYBINDINGS,
          },
          workspaceRoot: localPath('/tmp/hvir'),
          projectRoot: localPath('/tmp/hvir'),
          onClose: vi.fn(),
          onSave,
        }),
      )
    })

    const checkbox = document.querySelector<HTMLInputElement>(
      '.settings-checkbox input[type="checkbox"]',
    )
    expect(checkbox?.checked).toBe(false)
    act(() => checkbox?.click())
    expect(document.querySelector('#composer-submit-consent-title')).toBeTruthy()
    expect(document.body.textContent).toContain(
      'Shift+Enter submits in supported terminals outside hvir',
    )
    expect(invoke).not.toHaveBeenCalled()

    act(() => button('Cancel').click())
    expect(checkbox?.checked).toBe(false)
    expect(document.querySelector('#composer-submit-consent-title')).toBeFalsy()

    act(() => checkbox?.click())
    act(() => button('Allow this change').click())
    expect(checkbox?.checked).toBe(true)
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => {
      button('Save app settings').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('harness:configure-composer-submit', {
      scope: 'all-connected',
      mode: 'ctrl-enter',
      previousMode: 'enter',
    })
    expect(onSave).toHaveBeenCalledWith(
      'dark',
      expect.objectContaining({ composerSubmitMode: 'ctrl-enter' }),
    )
  })
})

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function flushFrames(): void {
  act(() => {
    while (frameCallbacks.size > 0) {
      const callbacks = [...frameCallbacks.values()]
      frameCallbacks.clear()
      for (const callback of callbacks) callback(performance.now())
    }
  })
}

function headingFocusCount(focus: {
  readonly mock: { readonly instances: readonly unknown[] }
}): number {
  return focus.mock.instances.filter(
    (instance) =>
      instance instanceof HTMLElement && instance.id === 'settings-harnesses-title',
  ).length
}

function domRect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  }
}
