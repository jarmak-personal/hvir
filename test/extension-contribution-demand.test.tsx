// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type {
  ExtensionContributionState,
  ExtensionDemand,
} from '../src/shared/extensions/workbench'
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
  ElectronExtensionGuestSurface: () => createElement('div'),
}))
import { ExtensionContributionsProvider } from '../src/renderer/src/extensions/ExtensionContributions'
import { ExtensionTerminalItems } from '../src/renderer/src/extensions/ExtensionTerminalItems'

async function fixture() {
  const manifest = validateExtensionManifest(
    exampleManifest({
      railItems: [
        {
          id: 'pulse',
          placement: 'header',
          kind: 'observation',
          icon: '◇',
          tooltip: 'Pulse',
          click: { view: 'detail', placement: 'popup' },
        },
      ],
    }),
  ).manifest
  const state: ExtensionContributionState = {
    installationId: 'one',
    extensionName: 'Example',
    manifest,
    values: [],
  }
  const listeners = new Map<string, (value: unknown) => void>()
  const stops: ReturnType<typeof vi.fn>[] = []
  let holdNext = false,
    finish: (() => void) | undefined
  const invoke = vi.fn((channel: string, _input?: unknown) => {
    if (channel === 'extensions:contributions') return Promise.resolve([state])
    if (channel === 'extensions:context')
      return Promise.resolve({ sessions: [], terminalIds: {} })
    if (channel === 'extensions:demand' && holdNext) {
      holdNext = false
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    return Promise.resolve(undefined)
  })
  vi.stubGlobal('hvir', {
    invoke,
    send: vi.fn(),
    on: (channel: string, listener: (value: unknown) => void) => {
      listeners.set(channel, listener)
      const stop = vi.fn(() => {
        listeners.delete(channel)
      })
      stops.push(stop)
      return stop
    },
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = (obscured = false) =>
    root.render(
      createElement(ExtensionContributionsProvider, {
        workspaceId: 'workspace',
        views: [],
        topActive: false,
        obscured,
        onTop: vi.fn(),
        onWorkspace: vi.fn(),
        onError: vi.fn(),
        children: createElement(ExtensionTerminalItems, {
          placement: 'header',
          active: true,
        }),
      }),
    )
  const emit = (channel: string, value?: unknown) => listeners.get(channel)?.(value)
  const demands = () =>
    invoke.mock.calls
      .filter(([channel]) => channel === 'extensions:demand')
      .map(([, value]) => value as readonly ExtensionDemand[])
  let mounted = true
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
  }
  await act(async () => {
    render()
    await Promise.resolve()
  })
  return {
    state,
    element,
    render,
    emit,
    listeners,
    stops,
    demands,
    unmount,
    hold: () => {
      holdNext = true
    },
    release: () => finish?.(),
    cleanup: async () => {
      await unmount()
      await act(async () => {
        finish?.()
        await Promise.resolve()
      })
      element.remove()
      vi.unstubAllGlobals()
    },
  }
}

describe('contribution demand across activation publication', () => {
  it('renews unchanged visible rail entries when replacement snapshots coalesce', async () => {
    const data = await fixture()
    try {
      const prior = data.demands().length,
        visible = data.demands().at(-1)
      expect(visible).toEqual([
        {
          installationId: 'one',
          contributionId: 'pulse',
          surface: 'rail',
          workspaceId: 'workspace',
        },
      ])
      await act(async () => {
        data.emit('extensions:contributions-changed', [])
        data.emit('extensions:state-changed')
        data.emit('extensions:contributions-changed', [
          {
            ...data.state,
            manifest: { ...data.state.manifest, updater: 'updater.html' },
          },
        ])
        await Promise.resolve()
      })
      expect(
        data.element.querySelector('.extension-terminal-items button'),
      ).not.toBeNull()
      expect(data.demands()).toHaveLength(prior + 1)
      expect(data.demands().at(-1)).toEqual(visible)
      // Same-byte Reload also replaces its lifetime, without a changed manifest or ID.
      await act(async () => {
        data.emit('extensions:state-changed')
        await Promise.resolve()
      })
      expect(data.demands()).toHaveLength(prior + 2)
      expect(data.demands().at(-1)).toEqual(visible)
    } finally {
      await data.cleanup()
    }
  })

  it('keeps renewal empty while obscured or after contribution revocation', async () => {
    const data = await fixture()
    try {
      await act(async () => {
        data.render(true)
        await Promise.resolve()
      })
      const hidden = data.demands().length
      await act(async () => {
        data.emit('extensions:state-changed')
        await Promise.resolve()
      })
      expect(data.demands().slice(hidden)).toEqual([[]])
      await act(async () => {
        data.emit('extensions:contributions-changed', [])
        await Promise.resolve()
      })
      await act(async () => {
        data.render(false)
        await Promise.resolve()
      })
      const revoked = data.demands().length
      await act(async () => {
        data.emit('extensions:state-changed')
        await Promise.resolve()
      })
      expect(data.demands().slice(revoked)).toEqual([[]])
      expect(data.element.querySelector('.extension-terminal-items button')).toBeNull()
    } finally {
      await data.cleanup()
    }
  })

  it('drains in-flight renewal to withdrawal and ignores disposed activation or contribution events', async () => {
    const data = await fixture()
    try {
      const lateActivation = data.listeners.get('extensions:state-changed'),
        lateContributions = data.listeners.get('extensions:contributions-changed')
      data.hold()
      await act(async () => {
        data.emit('extensions:state-changed')
        await Promise.resolve()
      })
      expect(data.demands().at(-1)).toHaveLength(1)
      await data.unmount()
      const disposed = data.demands().length
      await act(async () => {
        lateActivation?.(undefined)
        lateContributions?.([data.state])
        data.release()
        await Promise.resolve()
      })
      expect(data.demands().slice(disposed)).toEqual([[]])
      expect(data.stops).toHaveLength(2)
      expect(data.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
      const drained = data.demands().length
      await act(async () => {
        lateActivation?.(undefined)
        await Promise.resolve()
      })
      expect(data.demands()).toHaveLength(drained)
    } finally {
      await data.cleanup()
    }
  })
})
