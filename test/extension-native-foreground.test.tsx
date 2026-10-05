// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExtensionContributionsProvider,
  ExtensionTopRail,
  ExtensionTopDestination,
} from '../src/renderer/src/extensions/ExtensionContributions'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'
import type { ExtensionView } from '../src/shared/extensions/workbench'
vi.mock('../src/renderer/src/extensions/ElectronExtensionGuestSurface', () => ({
  ElectronExtensionGuestSurface: () => createElement('div'),
}))
vi.mock('../src/renderer/src/theme', () => ({ useAppTheme: () => 'dark' }))
vi.mock('../src/renderer/src/settings/settings', () => ({
  useAppSettings: () => ({ interfaceScale: 1, interfaceFont: 'system' }),
}))
afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  const manifest = validateExtensionManifest(
    exampleManifest({ views: [{ ...exampleManifest().views[0]!, navigation: 'top' }] }),
  ).manifest
  const view: ExtensionView = {
    id: 'top-view',
    installationId: 'one',
    contributionId: 'reference',
    extensionName: 'Reference',
    title: 'Reference',
    url: 'hvir-extension://one/index.html',
    partition: 'owned',
    context: { surface: 'top', visible: true },
  }
  let resolve!: (value: boolean) => void
  const initial = new Promise<boolean>((yes) => {
    resolve = yes
  })
  const listeners = new Map<string, (value: unknown) => void>()
  const send = vi.fn()
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'extensions:foreground'
        ? initial
        : channel === 'extensions:contributions'
          ? [{ installationId: 'one', extensionName: 'Reference', manifest, values: [] }]
          : channel === 'extensions:context'
            ? { terminalIds: {}, sessions: [] }
            : channel === 'extensions:open-view'
              ? view
              : undefined,
    ),
  )
  vi.stubGlobal('hvir', {
    invoke,
    send,
    on: (channel: string, listener: (value: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = (obscured = false) =>
    act(async () => {
      root.render(
        createElement(ExtensionContributionsProvider, {
          topActive: true,
          obscured,
          views: [view],
          onTop: () => {},
          onWorkspace: () => {},
          onError: () => {},
          children: createElement(
            Fragment,
            null,
            createElement(ExtensionTopRail),
            createElement(ExtensionTopDestination),
          ),
        }),
      )
      await Promise.resolve()
    })
  await render()
  await act(async () => {
    element.querySelector('button')!.click()
    await Promise.resolve()
  })
  const publish = (value: boolean) =>
    act(async () => {
      listeners.get('extensions:foreground-changed')!(value)
      await Promise.resolve()
    })
  const unmount = async () => {
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    element.remove()
  }
  return { element, send, invoke, resolve, publish, render, listeners, unmount }
}

describe('native extension window foreground', () => {
  it('keeps the selected view visible from its cold-start native query without requiring a later focus event', async () => {
    const data = await fixture()
    try {
      await act(async () => {
        data.resolve(true)
        await Promise.resolve()
      })
      await data.render()
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(false)
      expect(data.send).toHaveBeenLastCalledWith(
        'extensions:presentation',
        expect.objectContaining({ visible: true, refreshDemand: true }),
      )
      expect(
        data.invoke.mock.calls.filter(([channel]) => channel === 'extensions:foreground'),
      ).toHaveLength(1)
    } finally {
      await data.unmount()
    }
  })
  it('keeps selected guest paint/demand through parent document blur, while native background and Settings withdraw both', async () => {
    const data = await fixture()
    try {
      await act(async () => {
        data.resolve(true)
        await Promise.resolve()
      })
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(false)
      await act(async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        window.dispatchEvent(new Event('blur'))
        await Promise.resolve()
      })
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(false)
      expect(data.send).toHaveBeenLastCalledWith(
        'extensions:presentation',
        expect.objectContaining({ visible: true, refreshDemand: true }),
      )
      await data.publish(false)
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(true)
      expect(data.send).toHaveBeenLastCalledWith(
        'extensions:presentation',
        expect.objectContaining({ visible: false, refreshDemand: false }),
      )
      await data.publish(true)
      await data.render(true)
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(true)
      await data.render(false)
      expect(
        data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden,
      ).toBe(false)
    } finally {
      await data.unmount()
      vi.restoreAllMocks()
    }
  })
  it('rejects a late initial foreground read after a native event and retires its subscription on closure', async () => {
    const data = await fixture()
    await data.publish(false)
    await act(async () => {
      data.resolve(true)
      await Promise.resolve()
    })
    expect(data.element.querySelector<HTMLElement>('[data-extension-view]')!.hidden).toBe(
      true,
    )
    await data.unmount()
    expect(data.listeners.has('extensions:foreground-changed')).toBe(false)
    expect(
      data.invoke.mock.calls.filter(([channel]) => channel === 'extensions:foreground'),
    ).toHaveLength(1)
  })
})
