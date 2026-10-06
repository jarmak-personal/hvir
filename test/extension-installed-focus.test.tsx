// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ElectronExtensionGuestSurface } from '../src/renderer/src/extensions/ElectronExtensionGuestSurface'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { ExtensionContributionsProvider } from '../src/renderer/src/extensions/ExtensionContributions'
import {
  useExtensionContributions,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'
import { ExtensionViewPane } from '../src/renderer/src/extensions/ExtensionViewStack'

vi.mock('../src/renderer/src/theme', () => ({ useAppTheme: () => 'dark' }))
vi.mock('../src/renderer/src/settings/settings', () => ({
  useAppSettings: () => ({ interfaceScale: 1, interfaceFont: 'system' }),
}))

const view: ExtensionView = {
  id: 'exact',
  installationId: 'installed',
  contributionId: 'library',
  extensionName: 'Example',
  title: 'Library',
  partition: 'owned',
  url: 'hvir-extension://exact/index.html',
}
describe('deferred explicit installation guest focus', () => {
  it.each([
    'hidden',
    'native-same-turn',
    'selection-same-turn',
    'viewer-hidden',
    'prepared-hidden-then-armed',
  ] as const)(
    'retires an armed hint before the first focus attempt after %s',
    async (ending) => {
      const listeners = new Map<string, (value: unknown) => void>()
      const invoke = vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'extensions:foreground'
            ? true
            : channel === 'extensions:context'
              ? { sessions: [], terminalIds: {} }
              : [],
        ),
      )
      vi.stubGlobal('hvir', {
        invoke,
        send: vi.fn(),
        on: (channel: string, callback: (value: unknown) => void) => {
          listeners.set(channel, callback)
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
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const landing: ExtensionView = {
        ...view,
        context: {
          surface: ending === 'viewer-hidden' ? 'viewer' : 'top',
          visible: false,
        },
      }
      let model!: Contributions, show!: () => void
      function Pane({ visible }: { visible: boolean }) {
        model = useExtensionContributions()!
        return createElement(ExtensionViewPane, {
          view: landing,
          visible,
          selected: visible,
          onClose: () => {},
          Surface: ElectronExtensionGuestSurface,
        })
      }
      function Fixture() {
        const [topActive, setTopActive] = useState(false)
        const [visible, setVisible] = useState(
          ending === 'native-same-turn' || ending === 'selection-same-turn',
        )
        show = () => setVisible(true)
        return createElement(ExtensionContributionsProvider, {
          topActive,
          obscured: false,
          onTop: () => setTopActive(true),
          onWorkspace: () => setTopActive(false),
          onError: vi.fn(),
          placement: {
            guests: [landing],
            active: true,
            activeId: landing.id,
            activate: vi.fn(),
          },
          children: createElement(Pane, { visible }),
        })
      }
      try {
        await act(async () => {
          root.render(createElement(Fixture))
          await Promise.resolve()
        })
        const guest = host.querySelector<HTMLElement>('webview')!
        const focus = vi.spyOn(guest, 'focus')
        Object.defineProperty(guest, 'checkVisibility', { value: () => true })
        Object.defineProperty(guest, 'getWebContentsId', { value: () => 42 })
        if (ending === 'prepared-hidden-then-armed') act(() => show())
        act(() => {
          if (ending !== 'viewer-hidden') model.selectTop(landing)
          model.focusLanding(landing)
          if (ending === 'native-same-turn') {
            listeners.get('extensions:foreground-changed')!(false)
            listeners.get('extensions:foreground-changed')!(true)
          }
          if (ending === 'selection-same-turn') {
            model.selectTop({ ...landing, id: 'other' })
            model.selectTop(landing)
          }
        })
        if (ending !== 'prepared-hidden-then-armed')
          expect(model.landingFocusId).toBeUndefined()
        await act(async () => {
          show()
          if (ending !== 'prepared-hidden-then-armed')
            guest.dispatchEvent(new Event('dom-ready'))
          await Promise.resolve()
        })
        expect(focus).toHaveBeenCalledTimes(
          ending === 'prepared-hidden-then-armed' ? 1 : 0,
        )
        expect(
          invoke.mock.calls.filter(([channel]) => channel === 'extensions:foreground'),
        ).toHaveLength(ending === 'prepared-hidden-then-armed' ? 2 : 1)
      } finally {
        await act(async () => {
          root.unmount()
          await Promise.resolve()
        })
        host.remove()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
    },
  )
  it.each(['current', 'withdrawn', 'closed', 'background'] as const)(
    'rechecks exact selection and native foreground after readiness for %s',
    async (ending) => {
      let finish!: (foreground: boolean) => void
      const query = new Promise<boolean>((resolve) => {
        finish = resolve
      })
      const invoke = vi.fn(() => query)
      vi.stubGlobal('hvir', { invoke })
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      try {
        act(() =>
          root.render(
            createElement(ElectronExtensionGuestSurface, { view, focus: true }),
          ),
        )
        const guest = host.querySelector<HTMLElement>('webview')!
        const focus = vi.spyOn(guest, 'focus')
        Object.defineProperty(guest, 'checkVisibility', { value: () => true })
        Object.defineProperty(guest, 'getWebContentsId', { value: () => 42 })
        if (ending === 'withdrawn')
          act(() =>
            root.render(
              createElement(ElectronExtensionGuestSurface, { view, focus: false }),
            ),
          )
        if (ending === 'closed') act(() => root.unmount())
        await act(async () => {
          finish(ending !== 'background')
          await query
        })
        expect(focus).toHaveBeenCalledTimes(ending === 'current' ? 1 : 0)
        act(() => {
          guest.dispatchEvent(new Event('dom-ready'))
        })
        await act(async () => Promise.resolve())
        expect(focus).toHaveBeenCalledTimes(ending === 'current' ? 1 : 0)
        if (ending !== 'closed') {
          act(() =>
            root.render(
              createElement(ElectronExtensionGuestSurface, { view, focus: false }),
            ),
          )
          act(() =>
            root.render(
              createElement(ElectronExtensionGuestSurface, { view, focus: true }),
            ),
          )
          await act(async () => Promise.resolve())
          expect(invoke).toHaveBeenCalledTimes(1)
        }
      } finally {
        act(() => root.unmount())
        host.remove()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
    },
  )
  it('waits only for its exact guest attachment and removes readiness work on withdrawal', async () => {
    const invoke = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('hvir', { invoke })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() =>
        root.render(createElement(ElectronExtensionGuestSurface, { view, focus: true })),
      )
      const guest = host.querySelector<HTMLElement>('webview')!
      const focus = vi.spyOn(guest, 'focus')
      Object.defineProperty(guest, 'checkVisibility', { value: () => true })
      let ready = false
      Object.defineProperty(guest, 'getWebContentsId', {
        value: () => {
          if (!ready) throw new Error('not attached')
          return 42
        },
      })
      await act(async () => Promise.resolve())
      expect(focus).not.toHaveBeenCalled()
      ready = true
      await act(async () => {
        guest.dispatchEvent(new Event('dom-ready'))
        await Promise.resolve()
      })
      expect(focus).toHaveBeenCalledOnce()
      act(() =>
        root.render(createElement(ElectronExtensionGuestSurface, { view, focus: false })),
      )
      await act(async () => {
        guest.dispatchEvent(new Event('dom-ready'))
        await Promise.resolve()
      })
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      act(() => root.unmount())
      host.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
})
