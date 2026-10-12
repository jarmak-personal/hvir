// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ConnectorSettings } from '../src/renderer/src/settings/sections/ConnectorSettings'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

it.each(['application', 'workspace'] as const)(
  'offers achievable %s setup without an untargeted project Connect action',
  async (context) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const invoke = vi.fn(() => Promise.resolve({ hosts: [], connectors: [] }))
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const manifest = validateExtensionManifest(
      exampleManifest({
        connectors: [
          {
            id: 'tool',
            description: 'Read observations',
            context,
            timeoutMs: 1000,
            outputBytes: 1000,
            environment: [],
            setup: { executable: 'tool' },
          },
        ],
      }),
    ).manifest
    try {
      await act(async () => {
        root.render(
          <ConnectorSettings
            installation={{
              source: 'package',
              installationId: 'installed',
              enabled: true,
              warnings: [],
              manifest,
            }}
          />,
        )
        await Promise.resolve()
      })
      const connect = [...element.querySelectorAll('button')].find(
        (button) => button.textContent === 'Connect tool',
      )
      const manual = [...element.querySelectorAll('details')].find(
        (details) =>
          details.querySelector('summary')?.textContent ===
          'Manual program configuration',
      )
      expect(manual?.open).toBe(context === 'workspace')
      if (context === 'application') expect(connect).toBeDefined()
      else {
        expect(connect).toBeUndefined()
        expect(element.textContent).toContain('from an open local project view')
        expect(element.querySelector('[aria-label="Executable for tool"]')).not.toBeNull()
        expect(element.querySelector('[aria-label="Host for tool"]')).not.toBeNull()
      }
      expect(invoke).not.toHaveBeenCalledWith(
        'extensions:connector-connect',
        expect.anything(),
      )
    } finally {
      act(() => root.unmount())
      element.remove()
      vi.unstubAllGlobals()
    }
  },
)
