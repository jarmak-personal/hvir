// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchAccessDialogs } from '../src/renderer/src/workbench/WorkbenchAccessDialogs'
import {
  ExtensionContributionContext,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'
import type {
  ExtensionAdditionResult,
  ExtensionView,
} from '../src/shared/extensions/workbench'
import { getAppSettings } from '../src/renderer/src/settings/settings'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

vi.mock('../src/renderer/src/workbench/AgentConfirmationDialog', () => ({
  AgentConfirmationDialog: () => null,
}))
vi.mock('../src/renderer/src/workbench/ConnectionConfirmationDialog', () => ({
  ConnectionConfirmationDialog: () => null,
}))
vi.mock('../src/renderer/src/settings/sections/AgentAccessSettings', () => ({
  AgentAccessSettings: () => null,
}))

let root: Root, host: HTMLDivElement
const frames = new Map<number, FrameRequestCallback>()
let sequence = 0
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  frames.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function fixture(surface: 'top' | 'viewer' = 'top', initialView = true) {
  let finish!: (result: ExtensionAdditionResult) => void
  const pending = new Promise<ExtensionAdditionResult>((resolve) => {
    finish = resolve
  })
  const unsubscribed = vi.fn()
  const manifest = validateExtensionManifest(
    exampleManifest({ landing: 'reference' }),
  ).manifest
  const row = {
    source: 'installed',
    installationId: 'exact',
    manifest,
    enabled: true,
    warnings: [],
  }
  const view: ExtensionView = {
    id: 'prepared',
    installationId: 'exact',
    contributionId: 'reference',
    extensionName: 'Reference',
    title: 'Reference',
    partition: 'owned',
    url: 'hvir-extension://prepared/index.html',
    context: { surface, visible: false },
  }
  const invoke = vi.fn((channel: string) =>
    channel === 'extensions:add'
      ? pending
      : channel === 'extensions:state'
        ? Promise.resolve({ writable: true, installations: [row] })
        : Promise.resolve([]),
  )
  vi.stubGlobal('hvir', { invoke, on: () => unsubscribed })
  const settings = getAppSettings(),
    saved = vi.fn(),
    closed = vi.fn(),
    top = vi.fn(),
    viewer = vi.fn(),
    focus = vi.fn()
  let reopen!: () => void
  let publishViews!: (views: readonly ExtensionView[]) => void
  const model: Contributions = {
    topActive: false,
    obscured: true,
    views: [view],
    state: [
      { installationId: 'exact', extensionName: 'Reference', manifest, values: [] },
    ],
    sessions: [],
    terminalIds: {},
    foreground: true,
    selectTop: top,
    selectViewer: viewer,
    focusLanding: focus,
    close: vi.fn(),
    closeTop: vi.fn(),
    open: vi.fn(),
    demand: () => () => {},
  }
  function Fixture() {
    const [open, setOpen] = useState(true)
    const [views, setViews] = useState<readonly ExtensionView[]>(
      initialView ? [view] : [],
    )
    publishViews = setViews
    reopen = () => setOpen(true)
    return createElement(ExtensionContributionContext.Provider, {
      value: { ...model, views },
      children: createElement(WorkbenchAccessDialogs, {
        open,
        theme: 'dark',
        settings,
        onClose: () => {
          closed()
          setOpen(false)
        },
        onSave: saved,
      }),
    })
  }
  await act(async () => {
    root.render(createElement(Fixture))
    await Promise.resolve()
  })
  return {
    finish,
    pending,
    view,
    invoke,
    saved,
    closed,
    top,
    viewer,
    focus,
    unsubscribed,
    reopen: () => act(() => reopen()),
    model,
    publishViews: () => publishViews([view]),
  }
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )!
}
async function click(label: string) {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}
function input(id: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>('#' + id)!
  act(() => {
    Object.getOwnPropertyDescriptor(
      element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('installation handoff preserves only the existing Settings application draft', () => {
  it.each(['separate-render', 'same-turn'] as const)(
    'selects a newly prepared exact landing from an initially empty publication in %s',
    async (timing) => {
      const data = await fixture('viewer', false)
      await click('Extensions')
      act(() => button('Add extension…').click())
      if (timing === 'separate-render')
        await act(async () => {
          data.publishViews()
          await Promise.resolve()
        })
      await act(async () => {
        if (timing === 'same-turn') data.publishViews()
        data.finish({
          writable: true,
          installations: [],
          installed: { installationId: 'exact', landing: data.view },
        })
        await data.pending
      })
      expect(data.viewer).toHaveBeenCalledExactlyOnceWith('prepared')
      expect(data.closed).toHaveBeenCalledOnce()
      expect(data.top).not.toHaveBeenCalled()
      expect(data.focus).toHaveBeenCalledExactlyOnceWith('prepared')
    },
  )
  it.each(['top', 'viewer'] as const)(
    'hands off synchronously through %s, retires hidden resources, and restores valid and invalid drafts without saving',
    async (surface) => {
      const data = await fixture(surface)
      input('settings-interface-scale', '1.25')
      await click('Keybindings')
      input('settings-keybindings-json', '{ invalid unfinished')
      await click('Extensions')
      act(() => button('Add extension…').click())
      const initialUnsubscribed = data.unsubscribed.mock.calls.length
      await act(async () => {
        data.finish({
          writable: true,
          installations: [],
          installed: { installationId: 'exact', landing: data.view },
        })
        await data.pending
      })
      expect(host.querySelector('.settings-dialog')).toBeNull()
      expect(data.closed).toHaveBeenCalledOnce()
      expect(surface === 'top' ? data.top : data.viewer).toHaveBeenCalledExactlyOnceWith(
        surface === 'top' ? data.view : data.view.id,
      )
      expect(data.focus).toHaveBeenCalledExactlyOnceWith(data.view.id)
      expect(data.saved).not.toHaveBeenCalled()
      expect(frames.size).toBe(0)
      expect(data.unsubscribed.mock.calls.length).toBeGreaterThan(initialUnsubscribed)
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        await Promise.resolve()
      })
      expect(data.closed).toHaveBeenCalledOnce()
      data.reopen()
      expect(
        host.querySelector<HTMLInputElement>('#settings-interface-scale')?.value,
      ).toBe('1.25')
      await click('Keybindings')
      expect(
        host.querySelector<HTMLTextAreaElement>('#settings-keybindings-json')?.value,
      ).toBe('{ invalid unfinished')
      await click('Save app settings')
      expect(data.saved).not.toHaveBeenCalled()
      expect(host.textContent).toContain('JSON')
      await click('Close settings')
      data.reopen()
      expect(
        host.querySelector<HTMLInputElement>('#settings-interface-scale')?.value,
      ).toBe('1')
      await click('Keybindings')
      expect(
        host.querySelector<HTMLTextAreaElement>('#settings-keybindings-json')?.value,
      ).not.toBe('{ invalid unfinished')
    },
  )
  it.each(['section', 'close', 'package', 'background'] as const)(
    'does not navigate from a late exact reply after %s',
    async (ending) => {
      const data = await fixture()
      await click('Extensions')
      act(() => button('Add extension…').click())
      if (ending === 'section') act(() => button('Appearance').click())
      if (ending === 'close') act(() => button('Close settings').click())
      if (ending === 'package')
        act(() =>
          host.querySelector<HTMLButtonElement>('[data-source="installed"]')!.click(),
        )
      if (ending === 'background')
        await act(async () => {
          Object.defineProperty(data.model, 'foreground', { value: false })
          data.publishViews()
          await Promise.resolve()
        })
      await act(async () => {
        data.finish({
          writable: true,
          installations: [],
          installed: { installationId: 'exact', landing: data.view },
        })
        await data.pending
      })
      expect(data.top).not.toHaveBeenCalled()
      expect(data.viewer).not.toHaveBeenCalled()
      expect(data.focus).not.toHaveBeenCalled()
      expect(data.saved).not.toHaveBeenCalled()
    },
  )
  it('keeps ordinary explicit Save behavior after a retained draft reopens', async () => {
    const data = await fixture()
    input('settings-interface-scale', '1.25')
    await click('Extensions')
    act(() => button('Add extension…').click())
    await act(async () => {
      data.finish({
        writable: true,
        installations: [],
        installed: { installationId: 'exact', landing: data.view },
      })
      await data.pending
    })
    data.reopen()
    await click('Save app settings')
    expect(data.saved).toHaveBeenCalledExactlyOnceWith(
      'dark',
      expect.objectContaining({ interfaceScale: 1.25 }),
    )
  })
})
