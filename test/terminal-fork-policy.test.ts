import { describe, expect, it } from 'vitest'

import { terminalForkAvailability } from '../src/renderer/src/terminal/terminal-fork-policy'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProviderDescriptor,
} from '../src/shared'

describe('terminal conversation fork policy', () => {
  it.each([
    ['dead target', session(), provider(), false, 'no longer live'],
    [
      'unsupported provider',
      session(),
      provider(false),
      true,
      'provider does not support',
    ],
    [
      'unsupported probed version',
      session({ exactFork: false }),
      provider(),
      true,
      'probed harness version',
    ],
    [
      'identity divergence',
      { ...session(), identityDiverged: true as const },
      provider(),
      true,
      'identity diverged',
    ],
    [
      'missing exact identity',
      {
        ...session(),
        harnessSessionId: undefined,
        identityStatus: 'unavailable' as const,
      },
      provider(),
      true,
      'exact current conversation identity',
    ],
    [
      'concurrent request',
      { ...session(), forkPending: true as const },
      provider(),
      true,
      'already starting',
    ],
  ])('states why %s cannot fork', (_name, value, descriptor, live, reason) => {
    const availability = terminalForkAvailability(value, descriptor, live)
    expect(availability.available).toBe(false)
    if (!availability.available) expect(availability.reason).toContain(reason)
  })

  it('enables only a live exact identified non-diverged terminal', () => {
    expect(terminalForkAvailability(session(), provider(), true)).toEqual({
      available: true,
    })
  })
})

function session(options: { readonly exactFork?: boolean } = {}): TerminalSession {
  return {
    id: 'source',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      ...(options.exactFork === false ? {} : { exactFork: true as const }),
      contextPresentation: 'pressure',
    },
    fallbackTitle: 'Codex · repo',
    title: 'Source',
    status: 'Ready',
    harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
    identityStatus: 'identified',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
  }
}

function provider(supported = true): HarnessProviderDescriptor {
  return {
    id: asHarnessProviderId('codex'),
    displayName: 'Codex',
    default: false,
    ...(supported ? { exactForkLaunch: true as const } : {}),
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'pressure',
    },
    terminalInput: {
      modifiedKeyProtocol: 'csi-u',
      metaEnterAliasesControl: false,
    },
    profileGuidance: { reservedArguments: [] },
  }
}
