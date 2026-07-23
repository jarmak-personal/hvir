// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessProfilesSettings } from '../src/renderer/src/settings/HarnessProfilesSettings'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
} from '../src/shared'

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HarnessProfilesSettings', () => {
  it('paints the shell while a requested add flow waits for provider data', () => {
    let resolveCatalog: (value: readonly never[]) => void = () => undefined
    const catalog = new Promise<readonly never[]>((resolve) => {
      resolveCatalog = resolve
    })
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'harness:catalog' ? catalog : Promise.resolve([]),
      ),
    })
    renderHarnesses()

    expect(document.body.textContent).toContain('Loading harness providers…')
    expect(document.querySelector('.add-harness-dialog')).toBeFalsy()
    expect(resolveCatalog).toBeTypeOf('function')
  })

  it('opens the deferred add flow after an empty catalog has settled', async () => {
    vi.stubGlobal('hvir', {
      invoke: vi.fn(() => Promise.resolve([])),
    })
    renderHarnesses()
    await settleEffects()

    expect(document.querySelector('.add-harness-dialog')).toBeTruthy()
    expect(document.body.textContent).toContain(
      'No bundled harnesses were detected on this host.',
    )
  })

  it('shows an explicit load failure instead of opening the add flow', async () => {
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) =>
        channel === 'harness:catalog'
          ? Promise.reject(new Error('catalog unavailable'))
          : Promise.resolve([]),
      ),
    })
    renderHarnesses()
    await settleEffects()

    expect(document.body.textContent).toContain('Harness profiles could not be loaded.')
    expect(document.body.textContent).toContain('catalog unavailable')
    expect(document.querySelector('.add-harness-dialog')).toBeFalsy()
  })

  it('does not send incomplete binding drafts to command preview', async () => {
    vi.useFakeTimers()
    const provider: HarnessProviderDescriptor = {
      id: asHarnessProviderId('test'),
      displayName: 'Test provider',
      default: false,
      capabilities: {
        exactResume: false,
        sessionIdentity: 'none',
        contextPresentation: 'none',
      },
      terminalInput: {
        modifiedKeyProtocol: 'none',
        metaEnterAliasesControl: false,
      },
      profileTemplate: {
        displayName: 'Test profile',
        description: 'Test profile',
      },
      profileGuidance: {
        reservedArguments: [],
        riskClassification: 'best-effort',
      },
    }
    const profile: HarnessProfile = {
      id: asHarnessProfileId('test-profile'),
      launchRevision: 1,
      metadataRevision: 1,
      providerContractVersion: 1,
      builtIn: false,
      risk: 'standard',
      displayName: 'Test profile',
      providerId: provider.id,
      scope: { kind: 'global' },
      executable: { kind: 'provider-default' },
      args: [],
      environment: [],
      pathBindings: [],
      order: 1,
    }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'harness:catalog') return Promise.resolve([provider])
      if (channel === 'harness:profiles') return Promise.resolve([profile])
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })
    renderHarnesses(false)
    await settleEffects()

    const environment = [...document.querySelectorAll<HTMLElement>('strong')].find(
      (candidate) => candidate.textContent === 'Environment',
    )
    const add = environment
      ?.closest<HTMLElement>('.settings-profile-rows')
      ?.querySelector<HTMLButtonElement>('header button')
    expect(add).toBeTruthy()
    act(() => add?.click())
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
    })

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:preview'),
    ).toEqual([])
    expect(document.body.textContent).toContain('Invalid environment binding')
  })
})

function renderHarnesses(initialAddOpen = true): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      createElement(HarnessProfilesSettings, {
        workspaceRoot: localPath('/tmp/hvir'),
        projectRoot: localPath('/tmp/hvir'),
        initialAddOpen,
      }),
    )
  })
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
