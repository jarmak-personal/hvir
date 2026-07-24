// @vitest-environment happy-dom

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { harnessProviderCatalog } from '../src/main/harness/harness-provider'
import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { useTerminalProfiles } from '../src/renderer/src/terminal/use-terminal-profiles'
import {
  asHostId,
  hostPath,
  type HarnessProfileProbe,
  type HostConnectionState,
} from '../src/shared'

const rootPath = hostPath(asHostId('profile-host'), '/repo')
const profile = { ...providerTemplateProfiles()[0]!, builtIn: false }
const provider = harnessProviderCatalog().find(
  (candidate) => candidate.id === profile.providerId,
)!
const available: HarnessProfileProbe = {
  providerId: profile.providerId,
  profileId: profile.id,
  launchRevision: profile.launchRevision,
  hostId: rootPath.hostId,
  status: 'available',
  checkedAt: 1,
  expiresAt: 10_000,
  capabilities: provider.capabilities,
}

let host: HTMLDivElement
let reactRoot: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('terminal profile availability effects', () => {
  it('reads a snapshot on menu open and probes only after explicit refresh', async () => {
    let resolveSnapshot: (probes: readonly HarnessProfileProbe[]) => void = () =>
      undefined
    const snapshot = new Promise<readonly HarnessProfileProbe[]>((resolve) => {
      resolveSnapshot = resolve
    })
    const invoke = vi.fn((channel: string) => {
      if (channel === 'harness:probe-snapshot') return snapshot
      if (channel === 'harness:probe-profiles') return Promise.resolve([available])
      return Promise.resolve([])
    })
    vi.stubGlobal('hvir', { invoke })

    renderFixture('connected')
    await settleEffects()

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-snapshot'),
    ).toHaveLength(1)
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-profiles'),
    ).toEqual([])

    act(() => host.querySelector<HTMLButtonElement>('button')?.click())
    await settleEffects()

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-profiles'),
    ).toEqual([
      [
        'harness:probe-profiles',
        {
          root: rootPath,
          profileIds: [profile.id],
          force: true,
        },
      ],
    ])
    expect(
      host.querySelector('[data-probe-count]')?.getAttribute('data-probe-count'),
    ).toBe('1')

    await act(async () => {
      resolveSnapshot([])
      await Promise.resolve()
    })
    expect(
      host.querySelector('[data-probe-count]')?.getAttribute('data-probe-count'),
    ).toBe('1')

    renderFixture('disconnected')
    await settleEffects()

    expect(
      host.querySelector('[data-probe-count]')?.getAttribute('data-probe-count'),
    ).toBe('0')
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'harness:probe-profiles'),
    ).toHaveLength(1)
  })
})

function Fixture({ connectionState }: { readonly connectionState: HostConnectionState }) {
  const state = useTerminalProfiles({
    root: rootPath,
    connectionState,
    menuOpen: true,
  })
  useEffect(() => {
    state.acceptCatalog([provider], [profile])
  }, [state.acceptCatalog])
  return (
    <>
      <button type="button" onClick={() => state.refreshProbes(true)}>
        Refresh
      </button>
      <span data-probe-count={state.probes.length} />
    </>
  )
}

function renderFixture(connectionState: HostConnectionState): void {
  act(() => {
    reactRoot.render(<Fixture connectionState={connectionState} />)
  })
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
