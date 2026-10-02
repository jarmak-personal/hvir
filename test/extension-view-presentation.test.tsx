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
import { createExtensionPresentationReader } from '../src/renderer/src/extensions/extension-presentation'
import { ExtensionViewStack } from '../src/renderer/src/extensions/ExtensionViewStack'

describe('extension presentation observation', () => {
  it('reuses resolved colors on resize and resolves changed root presentation', () => {
    const read = createExtensionPresentationReader()
    const target = document.createElement('div')
    const extent = vi.spyOn(target, 'getBoundingClientRect')
    extent.mockReturnValue({ width: 320, height: 240 } as DOMRect)
    const create = vi.spyOn(document, 'createElement')
    const originalStyle = document.documentElement.getAttribute('style')
    try {
      const first = read('dark', 1, target)
      expect(first).toMatchObject({ width: 320, height: 240 })
      create.mockClear()
      extent.mockReturnValue({ width: 480.4, height: 180.6 } as DOMRect)
      const resized = read('dark', 1, target)
      expect(resized).toMatchObject({ width: 480, height: 181 })
      expect(resized.colors).toBe(first.colors)
      expect(create).not.toHaveBeenCalled()
      document.documentElement.style.setProperty('--accent', 'rgb(10 20 30)')
      const next = read('dark', 1, target)
      expect(next.colors).not.toBe(first.colors)
      expect(create).toHaveBeenCalledOnce()
      create.mockClear()
      expect(read('dark', 1, target).colors).toBe(next.colors)
      expect(create).not.toHaveBeenCalled()
      expect(read('light', 1.1, target)).toMatchObject({
        appearance: 'light',
        interfaceScale: 1.1,
      })
      expect(create).toHaveBeenCalledOnce()
      document.documentElement.style.setProperty(
        '--hvir-interface-font',
        'Example, serif',
      )
      document.documentElement.style.setProperty(
        '--hvir-monospace-font',
        'Example Mono, monospace',
      )
      expect(read('light', 1.1, target)).toMatchObject({
        fontFamily: 'Example, serif',
        monospaceFontFamily: 'Example Mono, monospace',
      })
    } finally {
      if (originalStyle === null) document.documentElement.removeAttribute('style')
      else document.documentElement.setAttribute('style', originalStyle)
      create.mockRestore()
    }
  })
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
        presentation: { appearance: 'light', interfaceScale: 1.1 },
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
