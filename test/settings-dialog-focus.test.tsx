// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsDialog } from '../src/renderer/src/settings/SettingsDialog'
import type { SettingsDestination } from '../src/renderer/src/settings/settings-navigation'
import { DEFAULT_KEYBINDINGS, localPath } from '../src/shared'

const confirmSafeToLeave = vi.fn(() => Promise.resolve(true))

vi.mock('../src/renderer/src/settings/HarnessProfilesSettings', async () => {
  const { createElement, forwardRef, useImperativeHandle, useState } =
    await import('react')
  return {
    HarnessProfilesSettings: forwardRef<
      { readonly confirmSafeToLeave: () => Promise<boolean> },
      { readonly initialAddOpen?: boolean }
    >(function MockHarnessProfilesSettings({ initialAddOpen }, ref) {
      const [addOpen] = useState(initialAddOpen)
      useImperativeHandle(ref, () => ({ confirmSafeToLeave }))
      return createElement(
        'section',
        {
          className: 'settings-section settings-harnesses',
          'data-initial-add-open': String(addOpen),
        },
        createElement(
          'h3',
          { id: 'settings-harnesses-title', tabIndex: -1 },
          'Harnesses',
        ),
        createElement('input', { 'aria-label': 'Harness profile name' }),
      )
    }),
  }
})

const frameCallbacks = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  confirmSafeToLeave.mockReset()
  confirmSafeToLeave.mockResolvedValue(true)
  frameCallbacks.clear()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frameCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameCallbacks.delete(id)
  })
  vi.stubGlobal('hvir', { invoke: vi.fn(() => Promise.resolve(undefined)) })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SettingsDialog section workflow', () => {
  it('targets Harnesses without scroll alignment and preserves app drafts across sections', async () => {
    renderDialog({ section: 'harnesses' })
    flushFrames()

    const heading = document.querySelector<HTMLElement>('#settings-harnesses-title')
    expect(heading).toBeTruthy()
    expect(document.activeElement).toBe(heading)
    expect(navButton('Harnesses').getAttribute('aria-current')).toBe('page')

    await selectSection('Terminal')
    const idle = document.querySelector<HTMLInputElement>('#settings-idle-threshold')
    expect(idle).toBeTruthy()
    changeValue(idle!, '9')
    await selectSection('Appearance')
    await selectSection('Terminal')
    expect(
      document.querySelector<HTMLInputElement>('#settings-idle-threshold')?.value,
    ).toBe('9')
  })

  it('changes section only after the dirty-profile guard allows it', async () => {
    confirmSafeToLeave.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderDialog({ section: 'harnesses' })

    await selectSection('Appearance')
    expect(document.querySelector('#settings-harnesses-title')).toBeTruthy()
    expect(navButton('Harnesses').getAttribute('aria-current')).toBe('page')

    await selectSection('Appearance')
    expect(document.querySelector('#settings-appearance-title')).toBeTruthy()
    expect(confirmSafeToLeave).toHaveBeenCalledTimes(2)
  })

  it('reveals and focuses the section containing an invalid app setting', async () => {
    renderDialog()
    await selectSection('Terminal')
    changeValue(document.querySelector<HTMLInputElement>('#settings-idle-threshold')!, '')
    await selectSection('Appearance')

    await act(async () => {
      button('Save app settings').click()
      await Promise.resolve()
    })
    flushFrames()

    const idle = document.querySelector<HTMLInputElement>('#settings-idle-threshold')
    expect(idle?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(idle)
    expect(document.body.textContent).toContain(
      'Idle threshold must be between 0.5 and 60 seconds',
    )
    expect(navButton('Terminal').getAttribute('aria-current')).toBe('page')
  })

  it('requires consent and waits for Save before changing Claude config', async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined))
    vi.stubGlobal('hvir', { invoke })
    const onSave = vi.fn()
    renderDialog(undefined, onSave)
    await selectSection('Terminal')

    const checkbox = document.querySelector<HTMLInputElement>('#settings-composer-submit')
    act(() => checkbox?.click())
    expect(document.querySelector('#composer-submit-consent-title')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()

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

  it('contains focus and Escape inside the nested composer consent dialog', async () => {
    const onClose = vi.fn()
    renderDialog(undefined, vi.fn(), onClose)
    await selectSection('Terminal')

    act(() =>
      document.querySelector<HTMLInputElement>('#settings-composer-submit')?.click(),
    )
    flushFrames()

    const cancel = button('Cancel')
    const allow = button('Allow this change')
    expect(document.activeElement).toBe(cancel)

    act(() => {
      allow.focus()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(cancel)

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(document.querySelector('#composer-submit-consent-title')).toBeNull()
    expect(document.querySelector('#settings-title')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('consumes the add-harness intent the first time Harnesses mounts', async () => {
    renderDialog({ section: 'harnesses', intent: 'add-harness' })
    expect(
      document
        .querySelector('.settings-harnesses')
        ?.getAttribute('data-initial-add-open'),
    ).toBe('true')

    await act(async () => Promise.resolve())
    await selectSection('Appearance')
    await selectSection('Harnesses')
    expect(
      document
        .querySelector('.settings-harnesses')
        ?.getAttribute('data-initial-add-open'),
    ).toBe('false')
  })
})

function renderDialog(
  initialDestination?: SettingsDestination,
  onSave = vi.fn(),
  onClose = vi.fn(),
): void {
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
        initialDestination,
        onClose,
        onSave,
      }),
    )
  })
}

async function selectSection(label: string): Promise<void> {
  await act(async () => {
    navButton(label).click()
    await Promise.resolve()
  })
}

function navButton(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>('.settings-section-index button'),
  ].find((candidate) => candidate.textContent?.trim() === label)
  if (!match) throw new Error(`Missing settings section '${label}'`)
  return match
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function changeValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
