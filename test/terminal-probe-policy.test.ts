import { describe, expect, it } from 'vitest'

import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import {
  mergeTerminalProbe,
  terminalProbeRefreshCandidates,
} from '../src/renderer/src/terminal/terminal-probe-policy'
import { asHostId, hostPath, type HarnessProfileProbe } from '../src/shared'

describe('terminal probe policy', () => {
  const root = hostPath(asHostId('probe-host'), '/repo')
  const profile = { ...providerTemplateProfiles()[0]!, builtIn: false }
  const available: HarnessProfileProbe = {
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    hostId: root.hostId,
    status: 'available',
    checkedAt: 1,
    expiresAt: 20,
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    },
  }

  it('refreshes only expired configured profiles unless forced', () => {
    expect(terminalProbeRefreshCandidates([profile], [available], 10, false)).toEqual([])
    expect(
      terminalProbeRefreshCandidates([profile], [available], 20, false).map(
        ({ id }) => id,
      ),
    ).toEqual([profile.id])
    expect(terminalProbeRefreshCandidates([profile], [available], 10, true)).toHaveLength(
      1,
    )
  })

  it('replaces matching profile generations without renderer-owned cache policy', () => {
    expect(mergeTerminalProbe([available], { ...available, checkedAt: 2 })).toEqual([
      { ...available, checkedAt: 2 },
    ])
  })
})
