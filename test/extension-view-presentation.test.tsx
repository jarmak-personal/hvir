// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ExtensionView } from '../src/shared/extensions/workbench'

const appearance = vi.hoisted(() => ({ theme: 'dark', scale: 1 }))
vi.mock('../src/renderer/src/theme', () => ({ useAppTheme: () => appearance.theme }))
vi.mock('../src/renderer/src/settings/settings', () => ({
  useAppSettings: () => ({ interfaceScale: appearance.scale, interfaceFont: 'system' }),
}))
import { ExtensionViewStack } from '../src/renderer/src/extensions/ExtensionViewStack'

describe('extension presentation observation', () => {
  it('updates real presentation without a fabricated hide on appearance changes, and hides on selection', () => {
    const observers: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
    const send = vi.fn()
    vi.stubGlobal('hvir', { send })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const view = {
      id: 'view',
      extensionName: 'Example',
      title: 'Viewer',
    } as ExtensionView
    const render = (active: boolean): void => {
      act(() =>
        root.render(
          createElement(ExtensionViewStack, {
            views: [view],
            activeId: view.id,
            active,
            onClose: () => undefined,
            Surface: () => createElement('div'),
          }),
        ),
      )
    }
    try {
      render(true)
      send.mockClear()
      appearance.theme = 'light'
      appearance.scale = 1.1
      render(true)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toMatchObject({
        visible: true,
        presentation: { appearance: 'light', fontSize: 14.3 },
      })
      send.mockClear()
      observers[0]!()
      expect(send).not.toHaveBeenCalled()
      render(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toMatchObject({
        visible: false,
        presentation: { appearance: 'light' },
      })
      send.mockClear()
      act(() => root.unmount())
      observers.at(-1)!()
      expect(send).not.toHaveBeenCalled()
    } finally {
      if (element.childNodes.length) act(() => root.unmount())
      element.remove()
      appearance.theme = 'dark'
      appearance.scale = 1
      vi.unstubAllGlobals()
    }
  })
})
