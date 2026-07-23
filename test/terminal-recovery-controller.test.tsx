// @vitest-environment happy-dom

import { act, useCallback, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { useTerminalRecovery } from '../src/renderer/src/terminal/use-terminal-recovery'
import {
  initialTerminalWorkspaceModel,
  terminalWorkspaceReducer,
  type TerminalWorkspaceAction,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  asHarnessProfileId,
  asHostId,
  hostPath,
  type HarnessProviderDescriptor,
  type TerminalRecoverySession,
} from '../src/shared'

let container: HTMLDivElement
let reactRoot: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('terminal recovery controller', () => {
  it('dismisses residual review without replacing an automatic live session', async () => {
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
    const root = hostPath(asHostId('recovery-controller'), '/repo')
    const automatic: TerminalRecoverySession = {
      id: 'automatic',
      providerId: provider.id,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      recoverySkipCount: 0,
      hostId: root.hostId,
      cwd: root,
      title: 'Automatic shell',
      position: 0,
      active: true,
      updatedAt: 1,
    }
    const residual: TerminalRecoverySession = {
      ...automatic,
      id: 'residual',
      profileId: asHarnessProfileId('missing-profile'),
      title: 'Needs review',
      position: 1,
      active: false,
      updatedAt: 2,
    }
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case 'harness:catalog':
          return Promise.resolve([provider])
        case 'harness:profiles':
          return Promise.resolve([profile])
        case 'terminal:recovery':
          return Promise.resolve([automatic, residual])
        case 'harness:probe-profiles':
          return Promise.resolve([])
        case 'terminal:record-recovery-decision':
          return Promise.resolve()
        default:
          return Promise.reject(new Error(`Unexpected IPC ${channel}`))
      }
    })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, on: vi.fn(), send: vi.fn() },
    })

    await act(async () => {
      reactRoot.render(
        <RecoveryHarness root={root} provider={provider} profile={profile} />,
      )
      await settleEffects()
    })

    expect(text('sessions')).toBe('automatic')
    expect(text('candidates')).toBe('residual')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
      await settleEffects()
    })

    expect(text('sessions')).toBe('automatic')
    expect(text('candidates')).toBe('')
    expect(invoke).toHaveBeenCalledWith('terminal:record-recovery-decision', {
      root,
      restoredIds: [],
      skippedIds: [],
    })
  })

  it('records restored and skipped rows before applying a mixed manual selection', async () => {
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
    const root = hostPath(asHostId('manual-recovery-controller'), '/repo')
    const first: TerminalRecoverySession = {
      id: 'first',
      providerId: provider.id,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      recoverySkipCount: 1,
      hostId: root.hostId,
      cwd: root,
      title: 'First shell',
      position: 0,
      active: true,
      updatedAt: 1,
    }
    const second = {
      ...first,
      id: 'second',
      recoverySkipCount: 0 as const,
      title: 'Second shell',
      position: 1,
      active: false,
    }
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case 'harness:catalog':
          return Promise.resolve([provider])
        case 'harness:profiles':
          return Promise.resolve([profile])
        case 'terminal:recovery':
          return Promise.resolve([first, second])
        case 'terminal:record-recovery-decision':
          return Promise.resolve()
        default:
          return Promise.reject(new Error(`Unexpected IPC ${channel}`))
      }
    })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, on: vi.fn(), send: vi.fn() },
    })

    await act(async () => {
      reactRoot.render(
        <RecoveryHarness
          root={root}
          provider={provider}
          profile={profile}
          mode="prompt"
        />,
      )
      await settleEffects()
    })
    expect(text('candidates')).toBe('first,second')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="restore-first"]')?.click()
      await settleEffects()
    })

    expect(invoke).toHaveBeenCalledWith('terminal:record-recovery-decision', {
      root,
      restoredIds: ['first'],
      skippedIds: ['second'],
    })
    expect(text('sessions')).toBe('first')
    expect(text('candidates')).toBe('')
  })
})

function RecoveryHarness({
  root,
  provider,
  profile,
  mode = 'auto',
}: {
  readonly root: ReturnType<typeof hostPath>
  readonly provider: HarnessProviderDescriptor
  readonly profile: ReturnType<typeof builtInProfiles>[number]
  readonly mode?: 'auto' | 'prompt'
}) {
  const [model, dispatch] = useReducer(
    terminalWorkspaceReducer,
    initialTerminalWorkspaceModel,
  )
  const send = useCallback((action: TerminalWorkspaceAction) => dispatch(action), [])
  const recovery = useTerminalRecovery({
    root,
    available: true,
    visible: true,
    mode,
    model,
    providers: [provider],
    profiles: [profile],
    probes: [],
    splitLayout: { secondaryIds: [] },
    ports: {
      acceptCatalog: () => undefined,
      acceptProbes: () => undefined,
      resetAttention: () => undefined,
      send,
    },
  })
  return (
    <>
      <span data-testid="sessions">{model.sessions.map(({ id }) => id).join(',')}</span>
      <span data-testid="candidates">
        {recovery.candidates.map(({ id }) => id).join(',')}
      </span>
      <button type="button" onClick={() => void recovery.skip()}>
        Not now
      </button>
      <button
        data-testid="restore-first"
        type="button"
        onClick={() => {
          const id = recovery.candidates[0]?.id
          if (id) void recovery.resume(new Set([id]))
        }}
      >
        Restore first
      </button>
    </>
  )
}

function text(testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
