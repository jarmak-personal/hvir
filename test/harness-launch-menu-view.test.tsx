// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfile,
  type HarnessProfileProbe,
  type HarnessProviderDescriptor,
} from '../src/shared'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('harness launch-menu view', () => {
  it('shows every advisory state without blocking a failed profile', () => {
    const provider = launchProvider()
    const profiles = [
      launchProfile(provider, 'unchecked', 'Unchecked profile'),
      launchProfile(provider, 'checking', 'Checking profile'),
      launchProfile(provider, 'available', 'Available profile'),
      launchProfile(provider, 'stale', 'Stale profile'),
      launchProfile(provider, 'failed', 'Failed profile'),
    ]
    const probe = (profile: HarnessProfile): HarnessProfileProbe => ({
      providerId: profile.providerId,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      hostId: localPath('/repo').hostId,
      status: 'available',
      checkedAt: 1,
      expiresAt: 20,
      version: '1.2.3',
      capabilities: provider.capabilities,
    })
    const onAddSession = vi.fn()

    act(() => {
      root.render(
        <TerminalRail
          label="main"
          visible
          compact={false}
          onCompact={vi.fn()}
          terminalTheme="app"
          recoveryReady
          available
          menuOpen
          moveMenuOpen={false}
          moveTargets={[]}
          launchMenuEntries={[
            { profile: profiles[0]!, provider, state: { availability: 'unchecked' } },
            {
              profile: profiles[1]!,
              provider,
              state: { availability: 'checking', probe: probe(profiles[1]!) },
            },
            {
              profile: profiles[2]!,
              provider,
              state: { availability: 'available', probe: probe(profiles[2]!) },
            },
            {
              profile: profiles[3]!,
              provider,
              state: { availability: 'stale', probe: probe(profiles[3]!) },
            },
            {
              profile: profiles[4]!,
              provider,
              state: {
                availability: 'failed',
                probe: { ...probe(profiles[4]!), status: 'timeout' },
              },
            },
          ]}
          split={false}
          sessions={[]}
          providers={[provider]}
          profiles={profiles}
          onSplit={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleMenu={vi.fn()}
          onToggleMoveMenu={vi.fn()}
          onPlanMove={vi.fn()}
          onDismissNewTargets={vi.fn()}
          onAddSession={onAddSession}
          onAddHarness={vi.fn()}
          onRefreshProbes={vi.fn()}
          onOpenHarnessSettings={vi.fn()}
          onResumeAll={vi.fn()}
          onFocusSession={vi.fn()}
          onMoveSession={vi.fn()}
          onCloseSession={vi.fn()}
        />,
      )
    })

    const launchButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-harness-availability]'),
    ]
    expect(launchButtons.map((button) => button.dataset.harnessAvailability)).toEqual([
      'unchecked',
      'checking',
      'available',
      'stale',
      'failed',
    ])
    expect(launchButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Unchecked'),
      expect.stringContaining('Checking…'),
      expect.stringContaining('Available · 1.2.3'),
      expect.stringContaining('Stale · 1.2.3'),
      expect.stringContaining('Failed · Probe timed out'),
    ])

    act(() => launchButtons[4]?.click())
    expect(onAddSession).toHaveBeenCalledWith(profiles[4])
  })
})

function launchProvider(): HarnessProviderDescriptor {
  return {
    id: asHarnessProviderId('advisory-harness'),
    displayName: 'Advisory Harness',
    default: false,
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    },
    terminalInput: {
      modifiedKeyProtocol: 'csi-u',
      metaEnterAliasesControl: false,
    },
    profileGuidance: {
      reservedArguments: [],
      riskClassification: 'best-effort',
    },
  }
}

function launchProfile(
  provider: HarnessProviderDescriptor,
  id: string,
  displayName: string,
): HarnessProfile {
  return {
    id: asHarnessProfileId(id),
    providerId: provider.id,
    launchRevision: 1,
    metadataRevision: 1,
    providerContractVersion: 1,
    builtIn: false,
    risk: 'standard',
    displayName,
    scope: { kind: 'global' },
    executable: { kind: 'provider-default' },
    args: [],
    environment: [],
    pathBindings: [],
    order: 1,
  }
}
