// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { TerminalWorkspace } from '../src/renderer/src/terminal/TerminalWorkspace'
import type { TerminalWorkspaceModel } from '../src/renderer/src/terminal/terminal-workspace-model'
import { localPath, type HarnessProviderDescriptor } from '../src/shared'

vi.mock('../src/renderer/src/terminal/TerminalDeck', () => ({
  TerminalDeck: ({
    onCreateDefault,
    sessions,
  }: {
    readonly onCreateDefault?: () => void
    readonly sessions: TerminalWorkspaceModel['sessions']
  }) => (
    <button type="button" data-testid="new" onClick={onCreateDefault}>
      New {sessions.length}
    </button>
  ),
}))

vi.mock('../src/renderer/src/terminal/TerminalWorkspaceControls', () => ({
  TerminalWorkspaceControls: ({
    model,
    commands,
  }: {
    readonly model: TerminalWorkspaceModel
    readonly commands: { readonly close: (id: string) => void }
  }) => (
    <button
      type="button"
      data-testid="close"
      onClick={() => model.activeId && commands.close(model.activeId)}
    >
      Close {model.sessions.length}
    </button>
  ),
}))

describe('terminal workspace materialization bridge', () => {
  it('retains a session owner across navigation and releases it after close-last', async () => {
    const profile = builtInProfiles()[0]!
    const provider = shellProvider(profile.providerId)
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn((channel: string) => {
          switch (channel) {
            case 'harness:catalog':
              return Promise.resolve([provider])
            case 'harness:profiles':
              return Promise.resolve([profile])
            case 'terminal:recovery':
              return Promise.resolve([])
            default:
              return Promise.resolve(undefined)
          }
        }),
        on: vi.fn(() => () => undefined),
        send: vi.fn(),
      },
    })
    const host = document.createElement('div')
    const root = createRoot(host)
    const onMaterializationChange = vi.fn()
    const props = {
      cwd: localPath('/repo'),
      workspaceId: 'workspace',
      connectionState: 'connected' as const,
      available: true,
      railCompact: false,
      onRailCompact: vi.fn(),
      label: 'repo',
      onRollup: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenWebLink: vi.fn(),
      preferences: {
        terminalTheme: 'app' as const,
        terminalLightThemeId: 'hvir-default-light',
        terminalDarkThemeId: 'hvir-default-dark',
        terminalTypography: { fontFamily: 'monospace', fontSize: 13 },
        terminalCursorDefaults: { shape: 'block', blink: 'terminal' } as const,
        terminalLigatures: true,
        composerSubmitMode: 'enter' as const,
        idleThresholdMs: 10_000,
        terminalRecoveryMode: 'prompt' as const,
      },
      onOpenSettings: vi.fn(),
      onOpenTerminalSettings: vi.fn(),
      onOpenHarnessSettings: vi.fn(),
      onAddHarness: vi.fn(),
      runtimes: { disposeSession: vi.fn() } as never,
      moveTargets: [],
      onMaterializationChange,
      onController: vi.fn(),
      onPrepareMoveTarget: vi.fn(() => Promise.resolve()),
      onReleaseMoveTarget: vi.fn(),
      onTerminalMoved: vi.fn(),
      onAcknowledgeMoveTargets: vi.fn(() => Promise.resolve()),
      onError: vi.fn(),
    }

    await act(async () => {
      root.render(<TerminalWorkspace {...props} visible />)
      await settleEffects()
    })
    onMaterializationChange.mockClear()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new"]')?.click()
      await settleEffects()
    })
    expect(onMaterializationChange).toHaveBeenLastCalledWith('workspace', true)

    await act(async () => {
      root.render(<TerminalWorkspace {...props} visible={false} />)
      await settleEffects()
    })
    expect(host.querySelector('[data-testid="close"]')).toBeNull()
    expect(onMaterializationChange).not.toHaveBeenCalledWith('workspace', false)

    await act(async () => {
      root.render(<TerminalWorkspace {...props} visible />)
      await settleEffects()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="close"]')?.click()
      await settleEffects()
    })
    expect(onMaterializationChange).toHaveBeenLastCalledWith('workspace', false)

    act(() => root.unmount())
  })
})

function shellProvider(id: HarnessProviderDescriptor['id']): HarnessProviderDescriptor {
  return {
    id,
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
    },
  }
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
