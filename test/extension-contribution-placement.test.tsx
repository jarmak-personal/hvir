// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

vi.mock('../src/renderer/src/sessions/use-sessions-foreground', () => ({
  useSessionsForeground: () => true,
}))
vi.mock('../src/renderer/src/theme', () => ({ useAppTheme: () => 'dark' }))
vi.mock('../src/renderer/src/settings/settings', () => ({
  useAppSettings: () => ({ interfaceScale: 1, interfaceFont: 'system' }),
}))
vi.mock('../src/renderer/src/extensions/ElectronExtensionGuestSurface', () => ({
  ElectronExtensionGuestSurface: () => createElement('div', { 'data-guest': true }),
}))
import {
  ExtensionContributionContext,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'
import {
  ExtensionLeftRail,
  ExtensionTopRail,
  ExtensionTopDestination,
  ExtensionContributionsProvider,
} from '../src/renderer/src/extensions/ExtensionContributions'
import { ExtensionViewStack } from '../src/renderer/src/extensions/ExtensionViewStack'
import { ExtensionTerminalItems } from '../src/renderer/src/extensions/ExtensionTerminalItems'
import { useExtensionViews } from '../src/renderer/src/extensions/use-extension-views'

const view: ExtensionView = {
  id: 'popup',
  installationId: 'one',
  contributionId: 'detail',
  title: 'Detail',
  extensionName: 'Example',
  partition: 'partition',
  url: 'hvir-extension://popup/detail.html',
  role: 'view',
  context: {
    surface: 'popup',
    visible: true,
    workspace: { id: 'workspace', name: 'Workspace', host: 'local' },
    session: {
      id: 'live',
      title: 'Shell',
      workspace: { id: 'workspace', name: 'Workspace', host: 'local' },
    },
  },
}

describe('extension contribution placement and focus', () => {
  it.each(['empty', 'top-only'] as const)(
    'preserves builtin rail controls without an empty extension navigation strip for %s contributions',
    async (contributions) => {
      const manifest = validateExtensionManifest(
        exampleManifest({
          views: [{ ...exampleManifest().views[0]!, navigation: 'top' }],
        }),
      ).manifest
      const invoke = vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'extensions:contributions'
            ? contributions === 'top-only'
              ? [
                  {
                    installationId: 'one',
                    extensionName: 'Example',
                    manifest,
                    values: [],
                  },
                ]
              : []
            : channel === 'extensions:context'
              ? { terminalIds: {}, sessions: [] }
              : undefined,
        ),
      )
      vi.stubGlobal('hvir', { invoke, on: () => () => undefined, send: vi.fn() })
      const element = document.createElement('div')
      document.body.append(element)
      const root = createRoot(element)
      try {
        await act(async () => {
          root.render(
            createElement(ExtensionContributionsProvider, {
              workspaceId: 'workspace',
              views: [],
              topActive: false,
              obscured: false,
              onTop: vi.fn(),
              onWorkspace: vi.fn(),
              onError: vi.fn(),
              children: createElement(ExtensionLeftRail, {
                visible: true,
                children: createElement(
                  'nav',
                  { className: 'rail-nav', 'aria-label': 'Project views' },
                  createElement('button', null, 'Files'),
                  createElement('button', null, 'Git'),
                ),
              }),
            }),
          )
          await Promise.resolve()
        })
        expect(element.querySelector('[aria-label="Extension project views"]')).toBeNull()
        expect(element.querySelectorAll('.rail-nav')).toHaveLength(1)
        expect(
          [...element.querySelectorAll('[aria-label="Project views"] button')].map(
            (button) => button.textContent,
          ),
        ).toEqual(['Files', 'Git'])
      } finally {
        await act(async () => {
          root.unmount()
          await Promise.resolve()
        })
        element.remove()
        vi.unstubAllGlobals()
      }
    },
  )

  it.each(['workspace', 'manual-left', 'top'] as const)(
    'reports %s close rejection without retrying failed physical disposal',
    async (path) => {
      const top = path === 'top'
      const manifest = validateExtensionManifest(
        exampleManifest({
          views: [
            {
              ...exampleManifest().views[0]!,
              navigation: top ? 'top' : 'left',
              placement: top ? 'application' : 'workspace',
            },
          ],
        }),
      ).manifest
      const guest: ExtensionView = {
        ...view,
        id: 'owned',
        contributionId: manifest.views[0]!.id,
        context: top
          ? { surface: 'top', visible: true }
          : { ...view.context!, surface: 'left' },
      }
      const failure = 'Native disposal failed; capacity retained'
      const invoke = vi.fn((channel: string) => {
        if (channel === 'extensions:close-view') return Promise.reject(new Error(failure))
        return Promise.resolve(
          channel === 'extensions:contributions'
            ? [{ installationId: 'one', extensionName: 'Example', manifest, values: [] }]
            : channel === 'extensions:context'
              ? { terminalIds: {}, sessions: [] }
              : channel === 'extensions:open-view'
                ? guest
                : undefined,
        )
      })
      vi.stubGlobal('hvir', { invoke, on: () => () => undefined, send: vi.fn() })
      const element = document.createElement('div')
      document.body.append(element)
      const root = createRoot(element)
      const onError = vi.fn()
      const render = (workspaceId: string, retained = guest): void => {
        root.render(
          createElement(ExtensionContributionsProvider, {
            workspaceId,
            views: [retained],
            topActive: top,
            obscured: false,
            onTop: vi.fn(),
            onWorkspace: vi.fn(),
            onError,
            children: top
              ? createElement(
                  Fragment,
                  null,
                  createElement(ExtensionTopRail),
                  createElement(ExtensionTopDestination),
                )
              : createElement(ExtensionLeftRail, {
                  visible: true,
                  children: createElement('div'),
                }),
          }),
        )
      }
      try {
        await act(async () => {
          render('workspace')
          await Promise.resolve()
        })
        await act(async () => {
          element
            .querySelector<HTMLButtonElement>(
              top ? '.sessions-destination' : 'nav button',
            )!
            .click()
          await Promise.resolve()
        })
        expect(element.querySelector('[aria-current=page]')).not.toBeNull()
        await act(async () => {
          if (path === 'workspace') render('next-workspace')
          else
            element
              .querySelector<HTMLButtonElement>('[aria-label="Close Detail"]')!
              .click()
          await Promise.resolve()
        })
        expect(
          invoke.mock.calls.filter(([channel]) => channel === 'extensions:close-view'),
        ).toEqual([['extensions:close-view', { viewId: guest.id }]])
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
        // A failed receipt remains in the native snapshot; it must not trigger a retry.
        await act(async () => {
          render(path === 'workspace' ? 'next-workspace' : 'workspace', {
            ...guest,
            failure,
          })
          await Promise.resolve()
        })
        expect(
          invoke.mock.calls.filter(([channel]) => channel === 'extensions:close-view'),
        ).toHaveLength(1)
        expect(onError).toHaveBeenCalledTimes(1)
        expect(element.querySelector('[data-extension-view="owned"]')).not.toBeNull()
      } finally {
        await act(async () => {
          root.unmount()
          await Promise.resolve()
        })
        element.remove()
        vi.unstubAllGlobals()
      }
    },
  )

  it('keeps same-workspace hide/reopen but closes every inaccessible old-workspace left guest', async () => {
    const manifest = validateExtensionManifest(
      exampleManifest({
        views: [
          { ...exampleManifest().views[0]!, navigation: 'left', placement: 'workspace' },
        ],
      }),
    ).manifest
    const left = {
      ...view,
      id: 'left',
      contributionId: manifest.views[0]!.id,
      context: { ...view.context!, surface: 'left' as const },
    }
    const hiddenLeft = { ...left, id: 'hidden-left', installationId: 'two' }
    const independent = {
      ...view,
      id: 'independent',
      context: { surface: 'top' as const, visible: false },
    }
    const invoke = vi.fn(() => Promise.resolve()),
      open = vi.fn(() => Promise.resolve(left))
    const model: Contributions = {
      state: [{ installationId: 'one', extensionName: 'Example', manifest, values: [] }],
      views: [left, hiddenLeft, independent, view],
      topActive: false,
      obscured: false,
      terminalIds: {},
      sessions: [],
      workspaceId: 'workspace',
      foreground: true,
      open,
      demand: () => () => undefined,
      close: (id) => {
        void window.hvir.invoke('extensions:close-view', { viewId: id })
      },
      closeTop: vi.fn(),
      selectTop: vi.fn(),
    }
    vi.stubGlobal('hvir', { invoke, send: vi.fn() })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const render = (workspaceId: string) =>
      root.render(
        createElement(ExtensionContributionContext.Provider, {
          value: { ...model, workspaceId },
          children: createElement(ExtensionLeftRail, {
            visible: true,
            children: createElement('div'),
          }),
        }),
      )
    try {
      act(() => render('workspace'))
      await act(async () => {
        element.querySelector<HTMLButtonElement>('nav button')!.click()
        await Promise.resolve()
      })
      expect(element.querySelector('[aria-current=page]')).not.toBeNull()
      act(() =>
        [...element.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === 'Project views')!
          .click(),
      )
      expect(element.querySelector('[aria-current=page]')).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
      await act(async () => {
        element.querySelector<HTMLButtonElement>('nav button')!.click()
        await Promise.resolve()
      })
      expect(open).toHaveBeenCalledTimes(2)
      act(() =>
        [...element.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === 'Project views')!
          .click(),
      )
      act(() => render('next-workspace'))
      expect(invoke.mock.calls).toEqual([
        ['extensions:close-view', { viewId: left.id }],
        ['extensions:close-view', { viewId: hiddenLeft.id }],
      ])
    } finally {
      act(() => root.unmount())
      element.remove()
      vi.unstubAllGlobals()
    }
  })
  it.each(['missing', 'failed'] as const)(
    'dismisses an exact %s popup snapshot and returns focus without activating its terminal',
    async (condition) => {
      const manifest = validateExtensionManifest(
        exampleManifest({
          railItems: [
            {
              id: 'signal',
              placement: 'session',
              kind: 'control',
              icon: '◇',
              tooltip: 'Popup',
              click: { view: 'detail', placement: 'popup' },
            },
          ],
        }),
      ).manifest
      const invoke = vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'extensions:contributions'
            ? [{ installationId: 'one', extensionName: 'Example', manifest, values: [] }]
            : channel === 'extensions:context'
              ? { terminalIds: { live: 'terminal' }, sessions: [view.context!.session!] }
              : channel === 'extensions:open-view'
                ? view
                : undefined,
        ),
      )
      vi.stubGlobal('hvir', { invoke, on: () => () => undefined, send: vi.fn() })
      const element = document.createElement('div')
      document.body.append(element)
      const root = createRoot(element)
      const activateTerminal = vi.fn()
      const render = (views: readonly ExtensionView[]): void => {
        root.render(
          createElement(ExtensionContributionsProvider, {
            workspaceId: 'workspace',
            views,
            topActive: false,
            obscured: false,
            onTop: vi.fn(),
            onWorkspace: vi.fn(),
            onError: vi.fn(),
            children: createElement(
              'div',
              { onClick: activateTerminal },
              createElement(ExtensionTerminalItems, {
                placement: 'session',
                terminalId: 'terminal',
                active: true,
              }),
            ),
          }),
        )
      }
      try {
        await act(async () => {
          render([view])
          await Promise.resolve()
        })
        const item = element.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!
        expect(item).toBeTruthy()
        await act(async () => {
          item.click()
          await Promise.resolve()
        })
        expect(
          document.querySelector('.extension-item-popup [data-guest]'),
        ).not.toBeNull()
        expect(activateTerminal).not.toHaveBeenCalled()
        act(() =>
          render(
            condition === 'missing' ? [] : [{ ...view, failure: 'Native guest stopped' }],
          ),
        )
        expect(document.querySelector('.extension-item-popup')).toBeNull()
        expect(document.activeElement).toBe(item)
        expect(invoke).toHaveBeenCalledWith('extensions:close-view', { viewId: 'popup' })
        expect(activateTerminal).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
          await Promise.resolve()
        })
        element.remove()
        vi.unstubAllGlobals()
      }
    },
  )

  it('keeps a nonfocusing action as an ordinary selected placement and forwards its focus intent', async () => {
    let publish!: (event: {
      views: readonly ExtensionView[]
      selectedId: string
      focus: boolean
    }) => void
    const activate = vi.fn()
    vi.stubGlobal('hvir', {
      invoke: () => Promise.resolve([]),
      on: (_channel: string, callback: typeof publish) => {
        publish = callback
        return () => undefined
      },
    })
    const element = document.createElement('div'),
      button = document.createElement('button')
    document.body.append(button, element)
    button.focus()
    const root = createRoot(element)
    function Placement() {
      const placement = useExtensionViews({ onActivate: activate, onError: vi.fn() })
      return createElement('div', {
        'data-selected': placement.activeId,
        'data-active': placement.active,
      })
    }
    try {
      await act(async () => {
        root.render(createElement(Placement))
        await Promise.resolve()
      })
      const ordinary = {
        ...view,
        id: 'ordinary',
        context: { surface: 'viewer' as const, visible: true },
      }
      act(() =>
        publish({ views: [ordinary, view], selectedId: ordinary.id, focus: false }),
      )
      expect(activate).toHaveBeenCalledWith(false)
      expect(element.firstElementChild?.getAttribute('data-selected')).toBe('ordinary')
      expect(element.firstElementChild?.getAttribute('data-active')).toBe('true')
      expect(document.activeElement).toBe(button)
    } finally {
      act(() => root.unmount())
      element.remove()
      button.remove()
      vi.unstubAllGlobals()
    }
  })
  it.each(['top', 'left'] as const)(
    'announces only the selected installation when %s contribution IDs repeat',
    async (surface) => {
      const declaration = {
        ...exampleManifest().views[0]!,
        navigation: surface,
        placement: surface === 'left' ? 'workspace' : 'application',
      }
      const manifest = validateExtensionManifest(
        exampleManifest({ views: [declaration] }),
      ).manifest
      const selected = {
        ...view,
        id: 'first-guest',
        contributionId: declaration.id,
        context: { ...view.context!, surface },
      }
      const other = { ...selected, id: 'second-guest', installationId: 'two' }
      const open = vi.fn(() => Promise.resolve(selected))
      const model: Contributions = {
        state: ['one', 'two'].map((installationId) => ({
          installationId,
          extensionName: installationId,
          manifest,
          values: [],
        })),
        views: [selected, other],
        topActive: true,
        obscured: false,
        selectedTop: selected,
        terminalIds: {},
        sessions: [],
        workspaceId: 'workspace',
        foreground: true,
        open,
        demand: () => () => undefined,
        close: vi.fn(),
        closeTop: vi.fn(),
        selectTop: vi.fn(),
      }
      vi.stubGlobal('hvir', { send: vi.fn() })
      const element = document.createElement('div')
      document.body.append(element)
      const root = createRoot(element)
      try {
        act(() =>
          root.render(
            createElement(ExtensionContributionContext.Provider, {
              value: model,
              children:
                surface === 'top'
                  ? createElement(ExtensionTopRail)
                  : createElement(ExtensionLeftRail, {
                      visible: true,
                      children: createElement('div'),
                    }),
            }),
          ),
        )
        const buttons = [
          ...element.querySelectorAll<HTMLButtonElement>(
            surface === 'top' ? 'button' : 'nav button',
          ),
        ]
        expect(buttons).toHaveLength(2)
        if (surface === 'left')
          await act(async () => {
            buttons[0]!.click()
            await Promise.resolve()
          })
        expect(buttons[0]!.getAttribute('aria-current')).toBe('page')
        expect(buttons[1]!.getAttribute('aria-current')).toBeNull()
        expect(element.querySelectorAll('[aria-current=page]')).toHaveLength(1)
      } finally {
        act(() => root.unmount())
        element.remove()
        vi.unstubAllGlobals()
      }
    },
  )
  it('keeps a Settings-obscured named placement hidden until ordinary visible presentation resumes', () => {
    const ordinary = {
      ...view,
      context: { ...view.context!, surface: 'viewer' as const },
    }
    const model: Contributions = {
      state: [],
      views: [ordinary],
      topActive: false,
      obscured: true,
      terminalIds: {},
      sessions: [],
      foreground: true,
      open: vi.fn(),
      demand: () => () => undefined,
      close: vi.fn(),
      closeTop: vi.fn(),
      selectTop: vi.fn(),
    }
    const send = vi.fn()
    vi.stubGlobal('hvir', { send })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const render = (obscured: boolean) =>
      root.render(
        createElement(ExtensionContributionContext.Provider, {
          value: { ...model, obscured },
          children: createElement(ExtensionViewStack, {
            views: [ordinary],
            activeId: ordinary.id,
            active: true,
            onClose: vi.fn(),
          }),
        }),
      )
    try {
      act(() => render(true))
      expect(element.querySelector<HTMLElement>('[data-extension-view]')?.hidden).toBe(
        true,
      )
      expect(send).toHaveBeenLastCalledWith(
        'extensions:presentation',
        expect.objectContaining({ viewId: ordinary.id, visible: false }),
      )
      act(() => render(false))
      expect(element.querySelector<HTMLElement>('[data-extension-view]')?.hidden).toBe(
        false,
      )
      expect(send).toHaveBeenLastCalledWith(
        'extensions:presentation',
        expect.objectContaining({ viewId: ordinary.id, visible: true }),
      )
    } finally {
      act(() => root.unmount())
      element.remove()
      vi.unstubAllGlobals()
    }
  })
})
