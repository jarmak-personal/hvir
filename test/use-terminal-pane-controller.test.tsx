// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { useTerminalPaneController } from '../src/renderer/src/terminal/use-terminal-pane-controller'
import type { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { runtimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'

describe('terminal pane React attachment', () => {
  it.each(['unmount', 'unpresent'] as const)(
    'withdraws the runtime before React removes its container on %s',
    (transition) => {
      const snapshot = {}
      const subscribe = () => () => {}
      const detach = vi.fn((container: HTMLElement) => container.isConnected)
      const attach = vi.fn((container: HTMLElement) => container.isConnected)
      const runtime = {
        update: vi.fn(),
        subscribe,
        snapshot: () => snapshot,
        interactions: { paneEvents: { subscribe, snapshot: () => snapshot } },
        attach,
        detach,
        synchronizeLifecycle: vi.fn(),
      }
      const registry = {
        acquire: () => runtime,
      } as unknown as TerminalRuntimeRegistry
      const options = { ...runtimeOptions(), active: false }
      function Pane({ presented }: { presented: boolean }) {
        const controller = useTerminalPaneController(options, registry, presented)
        return presented ? <div ref={controller.containerRef} /> : null
      }
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      try {
        act(() => root.render(<Pane presented />))
        expect(attach.mock.results[0]?.value).toBe(true)
        act(() => {
          if (transition === 'unmount') root.unmount()
          else root.render(<Pane presented={false} />)
        })
        expect(detach).toHaveBeenCalledTimes(1)
        expect(detach.mock.results[0]?.value).toBe(true)
      } finally {
        if (transition !== 'unmount') act(() => root.unmount())
        host.remove()
      }
    },
  )
})
