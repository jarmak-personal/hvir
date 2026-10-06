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
  it('submits no path or package mode, stays busy through import, and shows an enabled installation without Discover or Enable', async () => {
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
            installationId: 'chosen',
            revision: 'a'.repeat(64),
            enabled: true,
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
    ).toContain('Disable')
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

describe('Add selected configuration authority', () => {
  const state = (sources: string[], writable = true): ExtensionPlatformState => ({
    writable,
    installations: sources.map((source) => ({ source, enabled: false, warnings: [] })),
  })
  async function start() {
    let finish!: (value: ExtensionPlatformState) => void
    let reject!: (reason: Error) => void
    let publish!: (value: ExtensionPlatformState) => void
    const pending = new Promise<ExtensionPlatformState>((yes, no) => {
      finish = yes
      reject = no
    })
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'extensions:delivery-recovery'
          ? Promise.resolve([])
          : channel === 'extensions:add'
            ? pending
            : Promise.resolve(state(['first', 'second'])),
      ),
      on: vi.fn((_channel: string, listener: (value: ExtensionPlatformState) => void) => {
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
    act(() =>
      [...element!.querySelectorAll('button')]
        .find((e) => e.textContent === 'Add extension…')!
        .click(),
    )
    return { finish, reject, publish, pending }
  }
  const selected = () =>
    element!
      .querySelector('.extension-installation-list [aria-current="true"]')
      ?.getAttribute('data-source')
  it('selects a new package from a current reply when no publication has arrived', async () => {
    const { finish, pending } = await start()
    await act(async () => {
      finish(state(['first', 'second', 'added']))
      await pending
    })
    expect(selected()).toBe('added')
  })
  it('selects the current Add publication after the pre-import scan and does not retarget from a late reply', async () => {
    const { finish, publish, pending } = await start()
    act(() => publish(state(['first', 'second'])))
    expect(selected()).toBe('first')
    act(() => publish(state(['first', 'second', 'added'])))
    expect(selected()).toBe('added')
    act(() => publish(state(['first', 'second'])))
    await act(async () => {
      finish(state(['first', 'second', 'added']))
      await pending
    })
    expect(selected()).toBe('first')
    expect(element!.textContent).not.toContain('added')
  })
  it.each(['click', 'keyboard'] as const)(
    'keeps a newer %s selection through Add publication and stale reply',
    async (method) => {
      const { finish, publish, pending } = await start()
      act(() => {
        if (method === 'click')
          element!.querySelector<HTMLButtonElement>('[data-source="second"]')!.click()
        else
          element!
            .querySelector<HTMLButtonElement>('[data-source="first"]')!
            .dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
            )
      })
      act(() => publish(state(['first', 'second', 'added'])))
      await act(async () => {
        finish(state(['first', 'second', 'added']))
        await pending
      })
      expect(selected()).toBe('second')
    },
  )
  it.each(['failure', 'revocation'] as const)(
    'retires Add selection after %s so later additions cannot retarget it',
    async (mode) => {
      const { reject, publish, pending } = await start()
      if (mode === 'revocation') act(() => publish(state(['first', 'second'], false)))
      await act(async () => {
        reject(new Error('Selection cancelled'))
        await pending.catch(() => undefined)
      })
      act(() => publish(state(['first', 'second', 'later'])))
      expect(selected()).toBe('first')
      expect(element!.textContent).toContain('Selection cancelled')
    },
  )
})

it('surfaces retained deliveries and access warnings before immediate Enable', async () => {
  const state: ExtensionPlatformState = {
    writable: true,
    installations: [
      {
        source: 'reference',
        revision: 'current',
        enabled: false,
        warnings: ['Newer contract: optional features may be unavailable'],
        manifest: {
          id: 'reference',
          name: 'Reference',
          version: '1.0.0',
          contract: '1.1',
          requiredCapabilities: ['presentation.read'],
          optionalCapabilities: ['future.optional'],
          access: [],
          views: [],
        },
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
  const card = element.querySelector('article')!,
    enable = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Enable',
    )!,
    scope = [...card.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('does not give access to project files'),
    )!,
    warning = [...card.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('Newer contract'),
    )!,
    recovery = element.querySelector('[aria-label="Retained extension deliveries"]')!
  for (const disclosure of [scope, warning]) {
    expect(disclosure.closest('details')).toBeNull()
    expect(
      disclosure.compareDocumentPosition(enable) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  }
  expect(
    recovery.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(card.querySelector<HTMLDetailsElement>('details:last-of-type')?.open).toBe(false)
  await act(async () => {
    enable.click()
    await Promise.resolve()
  })
  expect(invoke).toHaveBeenCalledWith('extensions:enable', {
    source: 'reference',
    revision: 'current',
  })
})

describe('selected extension configuration lifetime', () => {
  const installation = (id: string, enabled = true) => ({
    source: id,
    installationId: id,
    revision: 'revision',
    acceptedRevision: 'revision',
    enabled,
    warnings: [],
    manifest: {
      id,
      name: id,
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: [],
      optionalCapabilities: [],
      access: [],
      views: [],
      connectors: [
        {
          id: 'tool',
          description: 'Installed tool',
          context: 'application' as const,
          timeoutMs: 1000,
          outputBytes: 1024,
          environment: [],
        },
      ],
    },
  })
  async function renderSelection(prepare?: Promise<unknown>, failure?: boolean) {
    let publish!: (state: ExtensionPlatformState) => void
    const initial: ExtensionPlatformState = {
      writable: true,
      installations: [installation('First'), installation('Second')],
    }
    const invoke = vi.fn((channel: string) =>
      channel === 'extensions:delivery-recovery'
        ? Promise.resolve([])
        : channel === 'extensions:connector-settings'
          ? Promise.resolve({
              hosts: [{ hostId: 'local', kind: 'local', label: 'Local' }],
              connectors: [],
            })
          : channel === 'extensions:connector-prepare'
            ? prepare
            : channel === 'extensions:disable' && failure
              ? Promise.reject(new Error('First could not be disabled'))
              : Promise.resolve(initial),
    )
    vi.stubGlobal('hvir', {
      invoke,
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
    const choose = async (name: string) =>
      act(async () => {
        ;[
          ...element!.querySelectorAll<HTMLButtonElement>(
            '.extension-installation-list button',
          ),
        ]
          .find((e) => e.querySelector('strong')?.textContent === name)!
          .click()
        await Promise.resolve()
      })
    return { publish, invoke, choose, initial }
  }
  it('shows one selected configuration, preserves identity across reordered publications, and selects the first remaining entry after removal', async () => {
    const { publish, choose } = await renderSelection()
    expect(element!.querySelectorAll('.extension-installation')).toHaveLength(1)
    await choose('Second')
    const input = element!.querySelector<HTMLInputElement>(
      '[aria-label="Executable for tool"]',
    )!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '/owned/program',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() =>
      publish({
        writable: true,
        installations: [installation('Second'), installation('First')],
      }),
    )
    expect(element!.querySelector('h4')!.textContent).toBe('Second')
    expect(
      element!.querySelector<HTMLInputElement>('[aria-label="Executable for tool"]')!
        .value,
    ).toBe('/owned/program')
    act(() => publish({ writable: true, installations: [installation('First', false)] }))
    expect(element!.querySelector('h4')!.textContent).toBe('First')
    expect(element!.querySelector('[aria-label="Executable for tool"]')).toBeNull()
    act(() =>
      publish({
        writable: true,
        installations: [installation('First', false), installation('Second')],
      }),
    )
    expect(element!.querySelector('h4')!.textContent).toBe('First')
  })
  it.each(['retarget', 'revision'] as const)(
    'discards a held unconfirmed program proposal after %s without retargeting approval',
    async (change) => {
      let resolve!: (value: unknown) => void
      const pending = new Promise((resolveValue) => {
        resolve = resolveValue
      })
      const { publish, choose, invoke } = await renderSelection(pending)
      act(() =>
        [...element!.querySelectorAll<HTMLButtonElement>('button')]
          .find((e) => e.textContent === 'Inspect native access')!
          .click(),
      )
      if (change === 'retarget') await choose('Second')
      else
        act(() =>
          publish({
            writable: true,
            installations: [
              {
                ...installation('First'),
                revision: 'changed',
                acceptedRevision: 'changed',
              },
              installation('Second'),
            ],
          }),
        )
      await act(async () => {
        resolve({
          token: 'never-approved',
          approval: {
            host: 'local',
            canonicalExecutable: '/owned/program',
            configuration: { args: [], env: {} },
          },
        })
        await pending
      })
      expect(element!.textContent).not.toContain('Approve local:')
      expect(
        invoke.mock.calls.some(([channel]) => channel === 'extensions:connector-approve'),
      ).toBe(false)
      if (change === 'retarget') {
        await choose('First')
        expect(element!.textContent).not.toContain('Approve local:')
      }
    },
  )
  it('keeps invalid and retained entries reachable, and does not clear a meaningful operation failure on selection', async () => {
    const { choose, publish } = await renderSelection(undefined, true)
    await act(async () => {
      ;[...element!.querySelectorAll<HTMLButtonElement>('button')]
        .find((e) => e.textContent === 'Disable')!
        .click()
      await Promise.resolve()
    })
    await choose('Second')
    expect(element!.querySelector('[role="alert"]')!.textContent).toBe(
      'First could not be disabled',
    )
    act(() =>
      publish({
        writable: true,
        installations: [
          { ...installation('Invalid', false), error: 'Invalid package' },
          { ...installation('Saved', false), retainedIdentity: true },
        ],
      }),
    )
    expect(element!.textContent).toContain('Invalid package')
    await choose('Saved')
    expect(element!.textContent).toContain('Saved setup is kept')
    expect(element!.querySelectorAll('.extension-installation')).toHaveLength(1)
  })
})
