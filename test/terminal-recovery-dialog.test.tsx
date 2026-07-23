// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { TerminalRecoveryDialog } from '../src/renderer/src/terminal/TerminalRecoveryDialog'
import {
  asHostId,
  hostPath,
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

function renderDialog({
  sessions,
  onDismiss = vi.fn(),
  onSkip = vi.fn(() => Promise.resolve()),
  onResume = vi.fn(() => Promise.resolve()),
}: {
  readonly sessions: readonly TerminalRecoverySession[]
  readonly onDismiss?: () => void
  readonly onSkip?: () => Promise<void>
  readonly onResume?: (ids: ReadonlySet<string>) => Promise<void>
}): void {
  act(() => {
    root.render(
      <TerminalRecoveryDialog
        sessions={sessions}
        providers={[provider]}
        profiles={[profile]}
        probes={[]}
        onDismiss={onDismiss}
        onSkip={onSkip}
        onResume={onResume}
        onRebind={() => Promise.resolve()}
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
