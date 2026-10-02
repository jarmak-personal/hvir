// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import type { ExtensionPlatformState } from '../src/shared/extensions/workbench'

let root: Root | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root?.unmount())
  element?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

describe('extension Settings observation order', () => {
  it.each(['snapshot', 'error'] as const)(
    'keeps a newer authority publication when initial %s arrives late',
    async (completion) => {
      let resolve!: (state: ExtensionPlatformState) => void
      let reject!: (error: Error) => void
      let publish!: (state: ExtensionPlatformState) => void
      const initial = new Promise<ExtensionPlatformState>((yes, no) => {
        resolve = yes
        reject = no
      })
      const unsubscribe = vi.fn()
      vi.stubGlobal('hvir', {
        invoke: vi.fn(() => initial),
        on: vi.fn(
          (_channel: string, callback: (state: ExtensionPlatformState) => void) => {
            publish = callback
            return unsubscribe
          },
        ),
      })
      element = document.createElement('div')
      document.body.append(element)
      root = createRoot(element)
      act(() => root!.render(createElement(ExtensionsSettings)))
      const newer: ExtensionPlatformState = {
        writable: false,
        explanation: 'Extension write ownership was revoked',
        installations: [{ source: 'current-package', enabled: true, warnings: [] }],
      }
      act(() => publish(newer))
      await act(async () => {
        if (completion === 'snapshot') resolve({ writable: true, installations: [] })
        else reject(new Error('Old initialization error'))
        await initial.catch(() => undefined)
      })
      expect(element.textContent).toContain('Extension write ownership was revoked')
      expect(element.textContent).toContain('current-package')
      expect(element.textContent).not.toContain('No extensions found')
      expect(element.textContent).not.toContain('Old initialization error')
      expect(element.querySelector<HTMLButtonElement>('article button')?.disabled).toBe(
        true,
      )
      act(() => root!.unmount())
      root = undefined
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      act(() => publish({ writable: true, installations: [] }))
    },
  )
})
