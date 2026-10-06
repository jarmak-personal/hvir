// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createContext, runInContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import { verifyExtensionSettingsGeometry } from '../src/main/smoke/extension-presentation-geometry'
import { extensionSettingsControls } from '../src/main/smoke/extension-settings-controls'
import type { ExtensionPlatformState } from '../src/shared/extensions/workbench'

vi.mock('../src/renderer/src/settings/sections/AgentAccessSettings', () => ({
  AgentAccessSettings: () => null,
}))

it('restores the exact selected configuration when removal publication reorders a retained row', async () => {
  const reference = {
    source: 'reference',
    enabled: false,
    warnings: [],
    manifest: {
      id: 'example.reference',
      name: 'Reference',
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: [],
      optionalCapabilities: [],
      access: [],
      views: [],
    },
  }
  const connection = {
    ...reference,
    source: 'connection-source',
    manifest: { ...reference.manifest, id: 'example.connection', name: 'Connection' },
  }
  const bad = { source: 'bad', enabled: false, warnings: [], error: 'Invalid package' }
  const initial: ExtensionPlatformState = {
    writable: true,
    installations: [bad, connection, reference],
  }
  const removed: ExtensionPlatformState = {
    writable: true,
    installations: [
      bad,
      reference,
      {
        source: connection.source,
        enabled: false,
        warnings: [],
        error: 'Package is missing',
      },
    ],
  }
  let publish!: (state: ExtensionPlatformState) => void
  vi.stubGlobal('hvir', {
    invoke: (channel: string) =>
      Promise.resolve(channel === 'extensions:delivery-recovery' ? [] : initial),
    on: (channel: string, listener: typeof publish) => {
      if (channel === 'extensions:state-changed') publish = listener
      return () => {}
    },
  })
  const visible = vi
    .spyOn(HTMLElement.prototype, 'checkVisibility')
    .mockImplementation(function (this: HTMLElement) {
      return this.isConnected
    })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const context = createContext({ document, KeyboardEvent })
  const selected = () =>
    element.querySelector('[aria-current="true"]')?.getAttribute('data-source')
  let reordered = false
  const win = {
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      executeJavaScript: async (script: string) => {
        // Layout/pixels are the retained real Electron assertion, not this adapter proof.
        if (script.includes('const section=document.querySelector')) return true
        let value: unknown
        await act(async () => {
          await Promise.resolve()
          if (!reordered && script.includes('.click()')) {
            publish(removed)
            reordered = true
          }
        })
        await act(async () => {
          value = runInContext(script, context) as unknown
          await Promise.resolve()
        })
        return value
      },
      sendInputEvent: (event: { type: string }) => {
        if (event.type === 'keyDown')
          act(() => {
            document.activeElement!.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
            )
          })
      },
    },
  } as unknown as BrowserWindow
  try {
    await act(async () => {
      root.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    act(() =>
      element.querySelector<HTMLButtonElement>('[data-source="reference"]')!.click(),
    )
    await verifyExtensionSettingsGeometry(win, async (predicate, label) => {
      if (!(await predicate())) throw new Error(label)
    })
    expect(reordered).toBe(true)
    expect(selected()).toBe(reference.source)
    expect(element.querySelector('.extension-installation h4')?.textContent).toBe(
      'Reference',
    )
  } finally {
    act(() => root.unmount())
    element.remove()
    visible.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('does not finish first-use cleanup at revocation or publication before the ordinary Remove reply settles', async () => {
  const installed = {
    source: 'connection-source',
    enabled: true,
    installationId: 'owned',
    warnings: [],
    manifest: {
      id: 'example.connection',
      name: 'Connection',
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: [],
      optionalCapabilities: [],
      access: [],
      views: [],
    },
  }
  const initial: ExtensionPlatformState = { writable: true, installations: [installed] }
  const removed: ExtensionPlatformState = {
    writable: true,
    installations: [
      {
        source: installed.source,
        enabled: false,
        warnings: [],
        error: 'Package is missing',
      },
    ],
  }
  let publish!: (state: ExtensionPlatformState) => void
  let reply!: (state: ExtensionPlatformState) => void
  let revoked = false
  const held = new Promise<ExtensionPlatformState>((resolve) => {
    reply = resolve
  })
  vi.stubGlobal('hvir', {
    invoke: (channel: string) => {
      if (channel === 'extensions:remove') {
        revoked = true
        return held
      }
      return Promise.resolve(channel === 'extensions:state' ? initial : [])
    },
    on: (channel: string, listener: typeof publish) => {
      if (channel === 'extensions:state-changed') publish = listener
      return () => {}
    },
  })
  const visible = vi
    .spyOn(HTMLElement.prototype, 'checkVisibility')
    .mockImplementation(function (this: HTMLElement) {
      return this.isConnected
    })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const context = createContext({ document })
  let attached = false
  const win = {
    webContents: {
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true
        },
        detach: () => {
          attached = false
        },
        sendCommand: async (command: string, input: { functionDeclaration?: string }) => {
          if (command === 'Runtime.evaluate')
            return { result: { objectId: 'owned-document' } }
          if (command !== 'Runtime.callFunctionOn') return {}
          let value: unknown
          await act(async () => {
            value = runInContext(`(${input.functionDeclaration})()`, context) as unknown
            await Promise.resolve()
          })
          return { result: { value } }
        },
      },
    },
  } as unknown as BrowserWindow
  const button = (name: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === name,
    )!
  try {
    await act(async () => {
      root.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    act(() => button('Remove').click())
    act(() => button('Confirm remove').click())
    expect(revoked).toBe(true) // Main revocation is deliberately earlier than its held reply.
    const settings = extensionSettingsControls(win, 'Connection', {
      within: (work) => work,
      wait: () => {
        throw new Error('Settlement observation must not add a second deadline')
      },
    })
    expect(await settings.settled()).toBe(false)
    await act(async () => {
      publish(removed)
      await Promise.resolve()
    })
    expect(element.querySelector('.extension-installation h4')?.textContent).toBe(
      installed.source,
    )
    expect(await settings.settled()).toBe(false)
    await act(async () => {
      reply(removed)
      await held
    })
    expect(await settings.settled()).toBe(true)
    expect(element.querySelector('[data-source="connection-source"]')).not.toBeNull()
    expect(element.querySelector('[aria-labelledby="extension-remove-title"]')).toBeNull()
    expect(attached).toBe(false)
  } finally {
    reply(removed)
    await act(async () => {
      await held
      root.unmount()
    })
    element.remove()
    visible.mockRestore()
    vi.unstubAllGlobals()
  }
})
