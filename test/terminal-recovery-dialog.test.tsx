// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  builtInProfiles,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import { TerminalRecoveryDialog } from '../src/renderer/src/terminal/TerminalRecoveryDialog'
import {
  asHarnessProfileId,
  asHostId,
  hostPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
  type TerminalRecoverySession,
} from '../src/shared'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('TerminalRecoveryDialog', () => {
  it('warns after one skip and keeps Escape distinct from explicit Not now', async () => {
    const onDismiss = vi.fn()
    const onSkip = vi.fn(() => Promise.resolve())
    renderDialog({
      sessions: [{ ...record, recoverySkipCount: 1 }],
      onDismiss,
      onSkip,
    })

    expect(container.textContent).toContain(
      'Skip again to forget this record from hvir. Provider-native resume remains available.',
    )

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onSkip).not.toHaveBeenCalled()

    await clickButton('Not now')
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('submits a mixed selection without treating restored rows as skipped', async () => {
    const onResume = vi.fn<(ids: ReadonlySet<string>) => Promise<void>>(() =>
      Promise.resolve(),
    )
    renderDialog({
      sessions: [
        { ...record, id: 'terminal-1', title: 'First' },
        { ...record, id: 'terminal-2', title: 'Second', active: false },
      ],
      onResume,
    })
    const second = container.querySelector<HTMLInputElement>(
      'input[aria-label="Restore Second"]',
    )
    if (!second) throw new Error('Missing second recovery option')

    act(() => second.click())
    await clickButton('Restore selected')

    const selected = onResume.mock.calls[0]?.[0]
    expect(selected).toEqual(new Set(['terminal-1']))
  })

  it('reviews the retained profile revision and selects a successful rebind', async () => {
    const onRebind = vi.fn(() => Promise.resolve())
    const onResume = vi.fn<(ids: ReadonlySet<string>) => Promise<void>>(() =>
      Promise.resolve(),
    )
    renderDialog({
      sessions: [driftedRecord],
      providers: [claudeProvider],
      profiles: [alternateClaudeProfile, currentClaudeProfile],
      onRebind,
      onResume,
    })

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Rebind Retained Claude profile"]',
    )
    expect(select?.value).toBe(currentClaudeProfile.id)
    expect(container.textContent).toContain('Current profile: Elevated Claude')
    expect(container.textContent).toContain('Launch revision changed (4 → 5)')
    expect(select?.selectedOptions[0]?.textContent).toContain('Elevated')

    await clickButton('Rebind and acknowledge Elevated')
    expect(onRebind).toHaveBeenCalledWith(driftedRecord, currentClaudeProfile)

    await clickButton('Restore selected')
    expect(onResume).toHaveBeenCalledWith(new Set([driftedRecord.id]))
  })

  it('requires an explicit alternative when the retained profile was removed', () => {
    renderDialog({
      sessions: [
        {
          ...driftedRecord,
          profileId: asHarnessProfileId('removed-claude-profile'),
        },
      ],
      providers: [claudeProvider],
      profiles: [alternateClaudeProfile, currentClaudeProfile],
    })

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Rebind Retained Claude profile"]',
    )
    const rebindButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((candidate) => candidate.textContent?.trim() === 'Review and rebind')
    expect(select?.value).toBe('')
    expect(select?.selectedOptions[0]?.textContent).toContain('Select a profile')
    expect(rebindButton?.disabled).toBe(true)
  })

  it('keeps a drifted row unselected and reports a failed rebind', async () => {
    const onRebind = vi.fn(() => Promise.reject(new Error('disk unavailable')))
    renderDialog({
      sessions: [driftedRecord],
      providers: [claudeProvider],
      profiles: [currentClaudeProfile],
      onRebind,
    })

    await clickButton('Rebind and acknowledge Elevated')

    expect(container.textContent).toContain('disk unavailable')
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Restore Retained Claude"]',
      )?.checked,
    ).toBe(false)
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Restore selected',
      )?.disabled,
    ).toBe(true)
  })
})

const profile = builtInProfiles()[0]!
const provider: HarnessProviderDescriptor = {
  id: profile.providerId,
  displayName: 'Shell',
  default: true,
  capabilities: {
    sessionIdentity: 'none',
    exactResume: false,
    contextPresentation: 'none',
  },
  terminalInput: {
    modifiedKeyProtocol: 'none',
    metaEnterAliasesControl: false,
  },
  profileGuidance: {
    reservedArguments: [],
    riskClassification: 'best-effort',
  },
}
const recoveryRoot = hostPath(asHostId('recovery-dialog'), '/repo')
const record: TerminalRecoverySession = {
  id: 'terminal-1',
  providerId: provider.id,
  profileId: profile.id,
  launchRevision: profile.launchRevision,
  recoverySkipCount: 0,
  hostId: recoveryRoot.hostId,
  cwd: recoveryRoot,
  title: 'Retained shell',
  position: 0,
  active: true,
  updatedAt: 1,
}

const currentClaudeProfile: HarnessProfile = {
  ...providerTemplateProfiles().find(
    (candidate) => candidate.providerId === 'claude-code',
  )!,
  displayName: 'Elevated Claude',
  launchRevision: 5,
  risk: 'elevated',
}
const alternateClaudeProfile: HarnessProfile = {
  ...currentClaudeProfile,
  id: asHarnessProfileId('claude-code-alternative'),
  displayName: 'Alternative Claude',
  risk: 'standard',
}
const claudeProvider: HarnessProviderDescriptor = {
  id: currentClaudeProfile.providerId,
  displayName: 'Claude Code',
  default: false,
  capabilities: {
    sessionIdentity: 'preassigned',
    exactResume: true,
    contextPresentation: 'count',
  },
  terminalInput: {
    modifiedKeyProtocol: 'none',
    metaEnterAliasesControl: false,
  },
  profileGuidance: {
    reservedArguments: [],
    riskClassification: 'best-effort',
  },
}
const driftedRecord: TerminalRecoverySession = {
  ...record,
  providerId: currentClaudeProfile.providerId,
  profileId: currentClaudeProfile.id,
  launchRevision: 4,
  harnessSessionId: '00000000-0000-4000-8000-000000000001',
  title: 'Retained Claude',
}

function renderDialog({
  sessions,
  providers = [provider],
  profiles = [profile],
  onDismiss = vi.fn(),
  onSkip = vi.fn(() => Promise.resolve()),
  onResume = vi.fn(() => Promise.resolve()),
  onRebind = vi.fn(() => Promise.resolve()),
}: {
  readonly sessions: readonly TerminalRecoverySession[]
  readonly providers?: readonly HarnessProviderDescriptor[]
  readonly profiles?: readonly HarnessProfile[]
  readonly onDismiss?: () => void
  readonly onSkip?: () => Promise<void>
  readonly onResume?: (ids: ReadonlySet<string>) => Promise<void>
  readonly onRebind?: (
    record: TerminalRecoverySession,
    profile: HarnessProfile,
  ) => Promise<void>
}): void {
  act(() => {
    root.render(
      <TerminalRecoveryDialog
        sessions={sessions}
        providers={providers}
        profiles={profiles}
        probes={[]}
        onDismiss={onDismiss}
        onSkip={onSkip}
        onResume={onResume}
        onRebind={onRebind}
      />,
    )
  })
}

async function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`Missing button '${label}'`)
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}
