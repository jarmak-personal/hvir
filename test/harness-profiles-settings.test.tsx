// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessProfilesSettings } from '../src/renderer/src/settings/HarnessProfilesSettings'
import {
  asHostId,
  asHarnessProfileId,
  asHarnessProviderId,
  hostPath,
  localPath,
  type HarnessProfile,
  type HarnessProfileInput,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
  type HostPath,
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

  it('contains a load failure and retries without replacing the settings shell', async () => {
    let catalogAttempts = 0
    vi.stubGlobal('hvir', {
      invoke: vi.fn((channel: string) => {
        if (channel !== 'harness:catalog') return Promise.resolve([])
        catalogAttempts += 1
        return catalogAttempts === 1
          ? Promise.reject(new Error('catalog unavailable'))
          : Promise.resolve([])
      }),
    })
    renderHarnesses()
    await settleEffects()

    expect(document.body.textContent).toContain('Harness profiles could not be loaded.')
    expect(document.body.textContent).toContain('catalog unavailable')
    expect(document.querySelector('.add-harness-dialog')).toBeFalsy()

    act(() => button('Try again').click())
    await settleEffects()
    expect(document.body.textContent).not.toContain(
      'Harness profiles could not be loaded.',
    )
    expect(document.querySelector('.add-harness-dialog')).toBeTruthy()
  })

  it('reads cached availability on open and probes only after explicit refresh', async () => {
    const provider = testProvider()
    const profile = testProfile(provider)
    const invoke = vi.fn((channel: string) => {
      if (channel === 'harness:catalog') return Promise.resolve([provider])
      if (channel === 'harness:profiles') return Promise.resolve([profile])
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })

    renderHarnesses(false)
    await settleEffects()

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-snapshot'),
    ).toHaveLength(1)
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-profiles'),
    ).toEqual([])

    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Refresh availability',
    )
    act(() => refresh?.click())
    await settleEffects()

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-profiles'),
    ).toHaveLength(1)
  })

  it('does not send incomplete binding drafts to command preview', async () => {
    vi.useFakeTimers()
    const provider = testProvider()
    const profile = testProfile(provider)
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

  it('cancels pending detection without reopening, then materializes a detected provider', async () => {
    const provider = testProvider()
    const shellProvider = testShellProvider()
    const shellProfile: HarnessProfile = {
      ...testProfile(shellProvider),
      id: asHarnessProfileId('plain-shell-default'),
      displayName: 'Shell',
      builtIn: true,
      order: 0,
    }
    const probe = testProbe(provider, localPath('/tmp/hvir'))
    let resolveInitialProbe: (probes: readonly HarnessProfileProbe[]) => void = () =>
      undefined
    const initialProbe = new Promise<readonly HarnessProfileProbe[]>((resolve) => {
      resolveInitialProbe = resolve
    })
    let probeRequests = 0
    let materialized = false
    const profile = testProfile(provider)
    const invoke = vi.fn((channel: string) => {
      if (channel === 'harness:catalog') {
        return Promise.resolve([shellProvider, provider])
      }
      if (channel === 'harness:profiles') {
        return Promise.resolve(materialized ? [shellProfile, profile] : [shellProfile])
      }
      if (channel === 'harness:probe-templates') {
        probeRequests += 1
        return probeRequests === 1 ? initialProbe : Promise.resolve([probe])
      }
      if (channel === 'harness:profile-materialize') {
        materialized = true
        return Promise.resolve([profile])
      }
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })
    renderHarnesses()
    await settleEffects()

    expect(document.querySelector('.add-harness-dialog')).toBeTruthy()
    expect(document.body.textContent).toContain('Checking…')
    act(() => button('Cancel').click())
    expect(document.querySelector('.add-harness-dialog')).toBeNull()

    await act(async () => {
      resolveInitialProbe([probe])
      await initialProbe
      await Promise.resolve()
    })
    expect(document.querySelector('.add-harness-dialog')).toBeNull()

    act(() => button('Add a harness…').click())
    await settleEffects()
    const candidate = document.querySelector<HTMLInputElement>(
      '.add-harness-candidates input[type="checkbox"]',
    )
    expect(candidate).toBeTruthy()
    act(() => candidate?.click())
    act(() => button('Add selected').click())
    await settleEffects()
    await settleEffects()

    expect(invoke).toHaveBeenCalledWith('harness:profile-materialize', {
      root: localPath('/tmp/hvir'),
      providerIds: [provider.id],
    })
    expect(document.querySelector('.add-harness-dialog')).toBeNull()
    expect(profileButton('Test profile').classList).toContain('active')
  })

  it('guards dirty profile selection through keep, discard, save, and two-step delete', async () => {
    const provider = testProvider()
    const first = testProfile(provider)
    let second: HarnessProfile = {
      ...first,
      id: asHarnessProfileId('second-profile'),
      displayName: 'Second profile',
      order: 2,
    }
    let profiles: readonly HarnessProfile[] = [first, second]
    const invoke = vi.fn((channel: string, request?: unknown) => {
      if (channel === 'harness:catalog') return Promise.resolve([provider])
      if (channel === 'harness:profiles') return Promise.resolve(profiles)
      if (channel === 'harness:profile-save') {
        const input = (request as { readonly input: HarnessProfileInput }).input
        second = { ...second, ...input, metadataRevision: second.metadataRevision + 1 }
        profiles = [first, second]
        return Promise.resolve(second)
      }
      if (channel === 'harness:profile-delete') {
        profiles = profiles.filter(
          ({ id }) => id !== (request as { readonly id: HarnessProfile['id'] }).id,
        )
        return Promise.resolve(undefined)
      }
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })
    renderHarnesses(false)
    await settleEffects()

    changeValue(labelledInput('Name'), 'First draft')
    act(() => profileButton('Second profile').click())
    await settleEffects()
    expect(document.querySelector('.unsaved-harness-dialog')).toBeTruthy()
    act(() => button('Keep editing').click())
    expect(profileButton('Test profile').classList).toContain('active')
    expect(labelledInput('Name').value).toBe('First draft')

    act(() => profileButton('Second profile').click())
    await settleEffects()
    act(() => button('Discard changes').click())
    await settleEffects()
    expect(profileButton('Second profile').classList).toContain('active')
    expect(labelledInput('Name').value).toBe('Second profile')

    changeValue(labelledInput('Name'), 'Saved second')
    act(() => profileButton('Test profile').click())
    await settleEffects()
    act(() => nestedButton('Save harness profile').click())
    await settleEffects()
    await settleEffects()
    expect(profileButton('Test profile').classList).toContain('active')
    expect(profiles[1]?.displayName).toBe('Saved second')

    act(() => profileButton('Saved second').click())
    await settleEffects()
    act(() => button('Delete').click())
    expect(button('Confirm delete')).toBeTruthy()
    act(() => button('Confirm delete').click())
    await settleEffects()
    await settleEffects()
    expect(invoke).toHaveBeenCalledWith('harness:profile-delete', { id: second.id })
    expect(document.body.textContent).not.toContain('Saved second')
    expect(profileButton('Test profile').classList).toContain('active')
  })

  it('keeps a replacement SSH workspace after a late local catalog completion', async () => {
    const provider = testProvider()
    const localRoot = localPath('/tmp/local-workspace')
    const remoteRoot = hostPath(asHostId('ssh-characterization'), '/srv/workspace')
    const remoteProject = hostPath(asHostId('ssh-characterization'), '/srv/project')
    const localProfile = testProfile(provider)
    const remoteProfile: HarnessProfile = {
      ...localProfile,
      id: asHarnessProfileId('remote-profile'),
      displayName: 'Remote profile',
      scope: { kind: 'project', projectRoot: remoteProject },
    }
    let resolveLocalProfiles: (profiles: readonly HarnessProfile[]) => void = () =>
      undefined
    const localProfiles = new Promise<readonly HarnessProfile[]>((resolve) => {
      resolveLocalProfiles = resolve
    })
    const invoke = vi.fn((channel: string, request?: unknown) => {
      if (channel === 'harness:catalog') return Promise.resolve([provider])
      if (channel === 'harness:profiles') {
        const root = (request as { readonly root: HostPath }).root
        return root.hostId === remoteRoot.hostId
          ? Promise.resolve([remoteProfile])
          : localProfiles
      }
      if (channel === 'harness:probe-profiles') {
        return Promise.resolve([testProbe(provider, remoteRoot, remoteProfile)])
      }
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })
    renderHarnessesAt(localRoot, localRoot, false)
    await settleEffects()
    expect(document.body.textContent).toContain('Loading harness providers…')

    renderHarnessesAt(remoteRoot, remoteProject, false)
    await settleEffects()
    expect(profileButton('Remote profile').classList).toContain('active')
    expect(labelledSelect('Scope').value).toBe('project')

    await act(async () => {
      resolveLocalProfiles([localProfile])
      await localProfiles
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Test profile')
    expect(profileButton('Remote profile').classList).toContain('active')

    act(() => button('Refresh availability').click())
    await settleEffects()
    expect(invoke).toHaveBeenCalledWith('harness:probe-profiles', {
      root: remoteRoot,
      profileIds: [remoteProfile.id],
      force: true,
    })
  })
})

function testProvider(): HarnessProviderDescriptor {
  return {
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
}

function testShellProvider(): HarnessProviderDescriptor {
  return {
    ...testProvider(),
    id: asHarnessProviderId('plain-shell'),
    displayName: 'Shell',
    default: true,
    profileTemplate: {
      displayName: 'Shell',
      description: 'Interactive shell',
    },
  }
}

function testProfile(provider: HarnessProviderDescriptor): HarnessProfile {
  return {
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
}

function renderHarnesses(initialAddOpen = true): void {
  renderHarnessesAt(localPath('/tmp/hvir'), localPath('/tmp/hvir'), initialAddOpen)
}

function renderHarnessesAt(
  workspaceRoot: HostPath,
  projectRoot: HostPath,
  initialAddOpen: boolean,
): void {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
  }
  if (!root) root = createRoot(host)
  act(() => {
    root?.render(
      createElement(HarnessProfilesSettings, {
        workspaceRoot,
        projectRoot,
        initialAddOpen,
      }),
    )
  })
}

function testProbe(
  provider: HarnessProviderDescriptor,
  rootPath: HostPath,
  profile = testProfile(provider),
): HarnessProfileProbe {
  return {
    providerId: provider.id,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    hostId: rootPath.hostId,
    status: 'available',
    checkedAt: 1,
    expiresAt: 10_000,
    capabilities: provider.capabilities,
  }
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function nestedButton(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>('.modal-backdrop.nested button'),
  ].find((candidate) => candidate.textContent?.trim() === label)
  if (!match) throw new Error(`Missing nested button '${label}'`)
  return match
}

function profileButton(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>('.settings-profile-list button'),
  ].find((candidate) => candidate.querySelector('strong')?.textContent === label)
  if (!match) throw new Error(`Missing profile '${label}'`)
  return match
}

function labelledInput(label: string): HTMLInputElement {
  const match = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input')
  if (!match) throw new Error(`Missing input '${label}'`)
  return match
}

function labelledSelect(label: string): HTMLSelectElement {
  const match = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLSelectElement>('select')
  if (!match) throw new Error(`Missing select '${label}'`)
  return match
}

function changeValue(control: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      control,
      value,
    )
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
