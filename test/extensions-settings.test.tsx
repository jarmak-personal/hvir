// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import type { ExtensionPlatformState } from '../src/shared/extensions/workbench'

vi.mock('../src/renderer/src/settings/sections/AgentAccessSettings', () => ({
  AgentAccessSettings: () => null,
}))

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
        invoke: vi.fn((channel: string) =>
          channel === 'extensions:delivery-recovery' ? Promise.resolve([]) : initial,
        ),
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

describe('extension Settings empty discovery guidance', () => {
  it.each([
    {
      situation: 'writer conflict',
      writable: false,
      explanation:
        'Another hvir instance uses extensions in this data directory. Close it or start hvir with a separate user-data directory.',
      showEmptyGuidance: false,
    },
    {
      situation: 'unreadable state',
      writable: false,
      explanation:
        'Extension state cannot be read safely. Ordinary workbench features remain available; repair the extension state file before enabling packages.',
      showEmptyGuidance: false,
    },
    {
      situation: 'writable empty discovery',
      writable: true,
      explanation: undefined,
      showEmptyGuidance: true,
    },
    {
      situation: 'writable empty discovery with a cleanup explanation',
      writable: true,
      explanation: 'Package cleanup needs attention: cleanup failed',
      showEmptyGuidance: true,
    },
  ])('shows an achievable next step for $situation', async (testCase) => {
    const state: ExtensionPlatformState = {
      writable: testCase.writable,
      explanation: testCase.explanation,
      installations: [],
    }
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        Promise.resolve(channel === 'extensions:delivery-recovery' ? [] : state),
      ),
      on: vi.fn(() => vi.fn()),
    })
    element = document.createElement('div')
    document.body.append(element)
    root = createRoot(element)
    await act(async () => {
      root!.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    if (testCase.explanation)
      expect(element.querySelector('[role="status"]')?.textContent).toBe(
        testCase.explanation,
      )
    if (testCase.showEmptyGuidance) {
      expect(element.textContent).toContain('No extensions found. Choose Add extension')
    } else {
      expect(element.textContent).not.toContain('No extensions found')
      expect(element.textContent).not.toContain('Add a directory or ZIP package')
    }
  })
})

describe('package lifecycle Settings intent', () => {
  it('provides direct Reload and a nested, cancellable removal decision bound to the selected entry', async () => {
    const state: ExtensionPlatformState = {
      writable: true,
      installations: [
        {
          source: 'development',
          sourceIdentity: '1:2',
          kind: 'development',
          installationId: 'installed',
          manifest: {
            id: 'example.reference',
            name: 'Reference',
            version: '0.1.0',
            contract: '1.0',
            requiredCapabilities: [],
            optionalCapabilities: [],
            access: [],
            views: [],
          },
          revision: 'candidate',
          acceptedRevision: 'accepted',
          warnings: [],
          enabled: false,
          retainedIdentity: true,
        },
      ],
    }
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(channel === 'extensions:delivery-recovery' ? [] : state),
    )
    vi.stubGlobal('hvir', { invoke, on: vi.fn(() => vi.fn()) })
    element = document.createElement('div')
    document.body.append(element)
    root = createRoot(element)
    await act(async () => {
      root!.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    expect(element.textContent).toContain('The package changed. Use Reload or Replace')
    expect(element.textContent).toContain('Saved setup is kept')
    expect(element.textContent).not.toContain('kept for reinstall')
    const button = (name: string) =>
      [...element!.querySelectorAll<HTMLButtonElement>('button')].find(
        (entry) => entry.textContent === name,
      )!
    await act(async () => {
      button('Reload').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('extensions:reload', {
      source: 'development',
      revision: 'candidate',
    })
    act(() => button('Remove').click())
    expect(element.querySelector('.modal-backdrop.nested')).not.toBeNull()
    expect(element.textContent).toContain('Only the development link is deleted')
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(element.querySelector('[role="dialog"]')).toBeNull()
    act(() => button('Remove').click())
    const checkbox = element.querySelector<HTMLInputElement>(
      '.modal-backdrop.nested input[type="checkbox"]',
    )!
    act(() => checkbox.click())
    await act(async () => {
      button('Confirm remove').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('extensions:remove', {
      source: 'development',
      identity: '1:2',
      forget: true,
    })
    expect(element.querySelector('[role="dialog"]')).toBeNull()
  })
  it('gives a missing accepted source a repair and discovery step before revision acceptance', async () => {
    const state: ExtensionPlatformState = {
      writable: true,
      installations: [
        {
          source: 'missing',
          enabled: false,
          warnings: [],
          acceptedRevision: 'accepted',
          retainedIdentity: true,
          error: 'Package is missing',
        },
      ],
    }
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        Promise.resolve(channel === 'extensions:delivery-recovery' ? [] : state),
      ),
      on: vi.fn(() => vi.fn()),
    })
    element = document.createElement('div')
    document.body.append(element)
    root = createRoot(element)
    await act(async () => {
      root!.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    expect(element.textContent).toContain(
      'Restore or repair the package, then choose Discover extensions',
    )
    expect(element.textContent).not.toContain('The package changed. Use Reload')
    expect(
      [...element.querySelectorAll('button')].some(
        (button) => button.textContent === 'Reload',
      ),
    ).toBe(false)
  })
})

describe('single Add extension Settings intent', () => {
  it('submits no path or package mode, stays busy through import, and shows an inactive candidate without Discover', async () => {
    let finish!: (state: ExtensionPlatformState) => void
    const pending = new Promise<ExtensionPlatformState>((resolve) => {
      finish = resolve
    })
    const invoke = vi.fn((channel: string) =>
      channel === 'extensions:delivery-recovery'
        ? Promise.resolve([])
        : channel === 'extensions:add'
          ? pending
          : Promise.resolve({ writable: true, installations: [] }),
    )
    vi.stubGlobal('hvir', { invoke, on: vi.fn(() => vi.fn()) })
    element = document.createElement('div')
    document.body.append(element)
    root = createRoot(element)
    await act(async () => {
      root!.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === 'Add extension…',
    )!
    expect(element.querySelector('select')).toBeNull()
    act(() => button.click())
    expect(invoke).toHaveBeenCalledWith('extensions:add', undefined)
    expect(button.disabled).toBe(true)
    await act(async () => {
      finish({
        writable: true,
        installations: [
          {
            source: 'chosen.zip',
            kind: 'zip',
            revision: 'a'.repeat(64),
            enabled: false,
            warnings: [],
          },
        ],
      })
      await pending
    })
    expect(button.disabled).toBe(false)
    expect(element.textContent).toContain('chosen.zip')
    expect(
      [...element.querySelectorAll('article button')].map((item) => item.textContent),
    ).toContain('Enable')
    expect(
      invoke.mock.calls.some(([channel]) =>
        ['extensions:discover', 'extensions:enable'].includes(channel),
      ),
    ).toBe(false)
    expect(element.querySelector('details')?.open).toBe(false)
  })
})

describe('Add extension result authority order', () => {
  it('keeps a newer writer revocation when an old Add reply arrives afterward', async () => {
    let finish!: (state: ExtensionPlatformState) => void
    let publish!: (state: ExtensionPlatformState) => void
    const pending = new Promise<ExtensionPlatformState>((resolve) => {
      finish = resolve
    })
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'extensions:delivery-recovery'
          ? Promise.resolve([])
          : channel === 'extensions:add'
            ? pending
            : Promise.resolve({ writable: true, installations: [] }),
      ),
      on: vi.fn((_channel: string, listener: (state: ExtensionPlatformState) => void) => {
        publish = listener
        return vi.fn()
      }),
    })
    element = document.createElement('div')
    document.body.append(element)
    root = createRoot(element)
    await act(async () => {
      root!.render(createElement(ExtensionsSettings))
      await Promise.resolve()
    })
    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === 'Add extension…',
    )!
    act(() => button.click())
    act(() =>
      publish({
        writable: false,
        explanation: 'Extension write ownership was revoked',
        installations: [],
      }),
    )
    await act(async () => {
      finish({ writable: true, installations: [] })
      await pending
    })
    expect(button.disabled).toBe(true)
    expect(element.querySelector('[role="status"]')?.textContent).toBe(
      'Extension write ownership was revoked',
    )
    expect(element.textContent).not.toContain('No extensions found')
  })
})
