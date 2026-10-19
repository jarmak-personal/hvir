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

it('loads only the selected host configuration and revokes that exact saved binding', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let saved = ['local', 'remote'].map((host) => ({
    connector: 'tool',
    host,
    availability: 'supported',
    executable: `/canonical/${host}`,
    selectedExecutable: `/selected/${host}`,
    configuration: { args: [host], env: {} },
  }))
  const invoke = vi.fn((channel: string, input: { host?: string }) => {
    if (channel === 'extensions:connector-revoke')
      saved = saved.filter((entry) => entry.host !== input.host)
    return Promise.resolve({
      hosts: ['local', 'remote', 'new'].map((host) => ({
        hostId: host,
        label: host,
        kind: host === 'local' ? 'local' : 'ssh',
      })),
      connectors: saved,
    })
  })
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const manifest = validateExtensionManifest(
    exampleManifest({
      connectors: [
        {
          id: 'tool',
          description: 'Project tool',
          context: 'workspace',
          timeoutMs: 1000,
          outputBytes: 1000,
          environment: [],
        },
      ],
    }),
  ).manifest
  const executable = () =>
    element.querySelector<HTMLInputElement>('[aria-label="Executable for tool"]')!
  const config = () =>
    element.querySelector<HTMLTextAreaElement>('[aria-label="Configuration for tool"]')!
  const select = (host: string) =>
    act(() => {
      const field = element.querySelector<HTMLSelectElement>(
        '[aria-label="Host for tool"]',
      )!
      field.value = host
      field.dispatchEvent(new Event('change', { bubbles: true }))
    })
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
    expect(element.querySelectorAll('[aria-label="Executable for tool"]')).toHaveLength(1)
    expect(
      element.querySelectorAll('[aria-label="Saved hosts for tool"] li'),
    ).toHaveLength(2)
    expect(executable().value).toBe('/selected/local')
    select('remote')
    expect(executable().value).toBe('/selected/remote')
    expect(JSON.parse(config().value) as unknown).toEqual({ args: ['remote'], env: {} })
    select('new')
    expect(executable().value).toBe('')
    expect(JSON.parse(config().value) as unknown).toEqual({ args: [], env: {} })
    select('remote')
    await act(async () => {
      ;[...element.querySelectorAll('button')]
        .find((button) => button.textContent === 'Revoke access on remote')!
        .click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('extensions:connector-revoke', {
      installationId: 'installed',
      connector: 'tool',
      host: 'remote',
    })
    expect(saved.map((entry) => entry.host)).toEqual(['local'])
    expect(executable().value).toBe('')
    select('local')
    expect(executable().value).toBe('/selected/local')
    expect(element.querySelector('[role="alert"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
})

it.each([
  'host',
  'path',
  'configuration',
  'unmount',
  'late-unmount',
  'replacement',
] as const)(
  'releases the exact prepared token on %s without revoking saved host access',
  async (ending) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const manifest = validateExtensionManifest(
      exampleManifest({
        connectors: [
          {
            id: 'tool',
            description: 'Project tool',
            context: 'workspace',
            timeoutMs: 1000,
            outputBytes: 1000,
            environment: [],
          },
        ],
      }),
    ).manifest
    const prepared = {
      token: 'exact-prepared-token',
      approval: {
        installationId: 'installed',
        connector: 'tool',
        host: 'local',
        executable: '/local/tool',
        canonicalExecutable: '/local/tool',
        configuration: { args: [], env: {} },
        declaration: manifest.connectors![0]!,
      },
    }
    let complete!: (value: typeof prepared) => void
    const pending = new Promise<typeof prepared>((resolve) => {
      complete = resolve
    })
    const invoke = vi.fn((channel: string): Promise<unknown> => {
      if (channel === 'extensions:connector-prepare') return pending
      if (channel === 'extensions:connector-settings')
        return Promise.resolve({
          hosts: [
            { hostId: 'local', kind: 'local', label: 'Local' },
            { hostId: 'remote', kind: 'ssh', label: 'Remote' },
          ],
          connectors: [],
        })
      return Promise.resolve()
    })
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    let unmounted = false
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
      await act(async () => {
        ;[...element.querySelectorAll('button')]
          .find((button) => button.textContent === 'Inspect native access')!
          .click()
        await Promise.resolve()
      })
      expect(invoke).toHaveBeenCalledWith(
        'extensions:connector-prepare',
        expect.objectContaining({ host: 'local' }),
      )
      if (ending === 'late-unmount') {
        act(() => root.unmount())
        unmounted = true
      }
      if (ending === 'replacement') {
        await act(async () => {
          root.render(
            <ConnectorSettings
              installation={{
                source: 'replacement',
                installationId: 'replacement',
                enabled: true,
                warnings: [],
                manifest,
              }}
            />,
          )
          await Promise.resolve()
        })
      }
      await act(async () => {
        complete(prepared)
        await pending
      })
      if (ending === 'unmount') {
        act(() => root.unmount())
        unmounted = true
      } else if (ending === 'host') {
        act(() => {
          const field = element.querySelector<HTMLSelectElement>(
            '[aria-label="Host for tool"]',
          )!
          field.value = 'remote'
          field.dispatchEvent(new Event('change', { bubbles: true }))
        })
      } else if (ending !== 'late-unmount' && ending !== 'replacement') {
        act(() => {
          const configuration = ending === 'configuration'
          const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            configuration
              ? '[aria-label="Configuration for tool"]'
              : '[aria-label="Executable for tool"]',
          )!
          const prototype = configuration
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
            field,
            configuration ? '{"args":["changed"],"env":{}}' : '/changed/tool',
          )
          field.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
      expect(invoke).toHaveBeenCalledWith('extensions:connector-cancel-prepared', {
        token: 'exact-prepared-token',
      })
      expect(invoke).not.toHaveBeenCalledWith(
        'extensions:connector-revoke',
        expect.anything(),
      )
      expect(invoke).not.toHaveBeenCalledWith(
        'extensions:connector-approve',
        expect.anything(),
      )
      expect(element.textContent).not.toContain('Approve native execution')
    } finally {
      if (!unmounted) act(() => root.unmount())
      await act(async () => {
        complete(prepared)
        await pending
      })
      element.remove()
      vi.unstubAllGlobals()
    }
  },
)

it.each([
  ['approve', 'installation'],
  ['approve', 'declaration'],
  ['revoke', 'installation'],
  ['revoke', 'declaration'],
] as const)(
  'ignores delayed %s completion after %s replacement',
  async (operation, replacement) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const manifest = (description: string) =>
      validateExtensionManifest(
        exampleManifest({
          connectors: [
            {
              id: 'tool',
              description,
              context: 'workspace',
              timeoutMs: 1000,
              outputBytes: 1000,
              environment: [],
            },
          ],
        }),
      ).manifest
    const initial = manifest('Initial declaration')
    const updated = manifest('Updated declaration')
    let revision = 'initial'
    let loadSettings!: () => void
    const replacementSettings = new Promise<void>((resolve) => {
      loadSettings = resolve
    })
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    const invoke = vi.fn((channel: string): Promise<unknown> => {
      if (channel === `extensions:connector-${operation}`) return pending
      if (channel === 'extensions:connector-settings') {
        const settings = {
          hosts: [{ hostId: 'local', kind: 'local', label: 'Local' }],
          connectors: [
            {
              connector: 'tool',
              host: 'local',
              availability: 'supported',
              executable: `/${revision}/tool`,
              selectedExecutable: `/${revision}/tool`,
              configuration: { args: [revision], env: {} },
            },
          ],
        }
        return revision === 'initial'
          ? Promise.resolve(settings)
          : replacementSettings.then(() => settings)
      }
      if (channel === 'extensions:connector-prepare')
        return Promise.resolve({
          token: `${revision}-token`,
          approval: {
            host: 'local',
            canonicalExecutable: `/${revision}/tool`,
            configuration: { args: [revision], env: {} },
          },
        })
      return Promise.resolve()
    })
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const render = () =>
      act(async () => {
        root.render(
          <ConnectorSettings
            installation={{
              source: 'package',
              installationId:
                replacement === 'installation' ? revision : 'same-installation',
              enabled: true,
              warnings: [],
              manifest: revision === 'initial' ? initial : updated,
            }}
          />,
        )
        await Promise.resolve()
      })
    const click = (label: string) =>
      act(async () => {
        ;[...element.querySelectorAll('button')]
          .find((button) => button.textContent === label)!
          .click()
        await Promise.resolve()
      })
    try {
      await render()
      if (operation === 'approve') await click('Inspect native access')
      await click(
        operation === 'approve' ? 'Approve native execution' : 'Revoke access on Local',
      )
      expect(invoke).toHaveBeenCalledWith(
        `extensions:connector-${operation}`,
        expect.anything(),
      )
      revision = 'replacement'
      await render()
      expect(
        element.querySelector<HTMLInputElement>('[aria-label="Executable for tool"]')!
          .value,
      ).toBe('')
      expect(element.querySelector('[aria-label="Saved hosts for tool"]')).toBeNull()
      expect(
        element.querySelector<HTMLTextAreaElement>(
          '[aria-label="Configuration for tool"]',
        )!.value,
      ).toBe('{"args":[],"env":{}}')
      expect(element.textContent).not.toContain('/initial/tool')
      await act(async () => {
        loadSettings()
        await replacementSettings
      })
      await click('Inspect native access')
      await act(async () => {
        complete()
        await pending
      })
      expect(
        element.querySelector<HTMLInputElement>('[aria-label="Executable for tool"]')!
          .value,
      ).toBe('/replacement/tool')
      expect(element.textContent).toContain('Approve local: /replacement/tool')
      expect(element.textContent).toContain('Approve native execution')
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === 'extensions:connector-settings',
        ),
      ).toHaveLength(2)
      expect(element.querySelector('[role="alert"]')).toBeNull()
      expect(element.querySelector('fieldset')!.disabled).toBe(false)
    } finally {
      act(() => root.unmount())
      await act(async () => {
        complete()
        loadSettings()
        await pending
        await replacementSettings
      })
      element.remove()
      vi.unstubAllGlobals()
    }
  },
)

it.each([false, true])(
  'prefills exact repair, requires session consent and preserves truthful Off state (failure=%s)',
  async (offFails) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const configuration = { args: ['--custom'], env: { TOOL_HOME: '/private/library' } }
    let trusted = false
    const approval = {
      installationId: 'installed',
      connector: 'tool',
      host: 'local',
      executable: '/custom/tool',
      canonicalExecutable: '/versions/B/tool',
      configuration,
    }
    const invoke = vi.fn((channel: string, input: Record<string, unknown>) => {
      if (channel === 'extensions:connector-prepare')
        return Promise.resolve({
          token: 'review',
          approval,
          trustUpdates: input.trustUpdates,
          preservesBaseline: true,
        })
      if (channel === 'extensions:connector-approve') trusted = true
      if (channel === 'extensions:connector-session-end') {
        if (offFails) return Promise.reject(new Error('Off was not applied'))
        trusted = false
      }
      return Promise.resolve({
        hosts: [{ hostId: 'local', label: 'Local', kind: 'local' }],
        connectors: [
          {
            connector: 'tool',
            host: 'local',
            selectedExecutable: '/custom/tool',
            executable: '/versions/A/tool',
            currentExecutable: '/versions/B/tool',
            configuration,
            trustUpdates: trusted,
            availability: trusted ? 'supported' : 'unavailable',
            ...(trusted ? {} : { reason: 'executable-changed' }),
          },
        ],
      })
    })
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
            context: 'application',
            timeoutMs: 1000,
            outputBytes: 1000,
            environment: ['TOOL_HOME'],
          },
        ],
      }),
    ).manifest
    const click = async (label: string) =>
      act(async () => {
        const button = [...element.querySelectorAll('button')].find(
          (button) => button.textContent === label,
        )
        expect(button).toBeDefined()
        button!.click()
        await Promise.resolve()
      })
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
      expect(invoke).toHaveBeenCalledWith('extensions:connector-settings', {
        installationId: 'installed',
        connector: 'tool',
        host: 'local',
      })
      expect(element.textContent).toContain('Program updated · review access')
      expect(element.textContent).toContain('/versions/A/tool')
      expect(element.textContent).toContain('/versions/B/tool')
      expect(
        element.querySelector<HTMLInputElement>('[aria-label="Executable for tool"]')
          ?.value,
      ).toBe('/custom/tool')
      expect(
        JSON.parse(element.querySelector<HTMLTextAreaElement>('textarea')!.value),
      ).toEqual(configuration)
      await click('Trust updates at this launcher until hvir quits')
      expect(trusted).toBe(false)
      await click('Cancel')
      expect(trusted).toBe(false)
      expect(invoke).toHaveBeenCalledWith('extensions:connector-cancel-prepared', {
        token: 'review',
      })
      await click('Trust updates at this launcher until hvir quits')
      expect(invoke).toHaveBeenCalledWith('extensions:connector-prepare', {
        installationId: 'installed',
        connector: 'tool',
        host: 'local',
        executable: '/custom/tool',
        configuration,
        trustUpdates: true,
      })
      expect(element.textContent).toContain('Saved approval stays unchanged')
      await click('Trust launcher updates for this session')
      expect(trusted).toBe(true)
      expect(element.textContent).toContain('Updates trusted for this session')
      await click('Stop trusting launcher updates')
      expect(invoke).toHaveBeenCalledWith('extensions:connector-session-end', {
        installationId: 'installed',
        connector: 'tool',
        host: 'local',
      })
      expect(trusted).toBe(offFails)
      expect(
        [...element.querySelectorAll('button')].some(
          (button) => button.textContent === 'Stop trusting launcher updates',
        ),
      ).toBe(offFails)
      expect(element.textContent).toContain(
        offFails ? 'Updates trusted for this session' : 'Program updated · review access',
      )
      if (offFails)
        expect(element.querySelector('[role="alert"]')?.textContent).toBe(
          'Off was not applied',
        )
    } finally {
      act(() => root.unmount())
      element.remove()
      vi.unstubAllGlobals()
    }
  },
)

it.each(['unavailable', 'error'] as const)(
  'distinguishes pending inspection and %s metadata from missing approval',
  async (outcome) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let finish!: (value: unknown) => void, fail!: () => void
    const pending = new Promise((resolve, reject) => {
      finish = resolve
      fail = () => reject(new Error('Unavailable'))
    })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke: vi.fn(() => pending) },
    })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const manifest = validateExtensionManifest(
      exampleManifest({
        connectors: [
          {
            id: 'tool',
            description: 'Read observations',
            context: 'application',
            timeoutMs: 1000,
            outputBytes: 1000,
            environment: [],
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
      expect(element.querySelector('[role="status"]')?.textContent).toBe(
        'Checking program…',
      )
      expect(element.textContent).not.toContain('Not approved')
      await act(async () => {
        if (outcome === 'error') fail()
        else
          finish({
            hosts: [],
            connectors: [
              {
                connector: 'tool',
                host: 'local',
                availability: 'unavailable',
                reason: 'unavailable',
                selectedExecutable: '/tool',
                executable: '/A/tool',
                configuration: { args: [], env: {} },
              },
            ],
          })
        await Promise.resolve()
      })
      expect(element.querySelector('[role="status"]')?.textContent).toBe(
        outcome === 'error' ? 'Couldn’t check program' : 'Program unavailable',
      )
      expect(element.textContent).not.toContain('Not approved')
      expect(element.textContent).not.toContain('Needs approval')
    } finally {
      act(() => root.unmount())
      element.remove()
      vi.unstubAllGlobals()
    }
  },
)
