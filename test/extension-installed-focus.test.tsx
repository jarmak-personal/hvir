// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ElectronExtensionGuestSurface } from '../src/renderer/src/extensions/ElectronExtensionGuestSurface'
import type { ExtensionView } from '../src/shared/extensions/workbench'

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
