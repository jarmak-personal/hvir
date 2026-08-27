// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import type { SessionsRendererSession } from '../src/renderer/src/sessions/sessions-renderer-observation'
import { TerminalWorkspace } from '../src/renderer/src/terminal/TerminalWorkspace'
import type { TerminalWorkspaceModel } from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  localPath,
  sessionsWorkspaceQualifier,
  type HarnessProviderDescriptor,
} from '../src/shared'

vi.mock('../src/renderer/src/terminal/TerminalDeck', () => ({
  TerminalDeck: ({
    onCreateDefault,
    onResetPrimaryWidth,
    onUpdateSession,
    sessions,
  }: {
    readonly onCreateDefault?: () => void
    readonly onResetPrimaryWidth: () => void
    readonly onUpdateSession: (
      id: string,
      update: (
        session: TerminalWorkspaceModel['sessions'][number],
      ) => TerminalWorkspaceModel['sessions'][number],
    ) => void
    readonly sessions: TerminalWorkspaceModel['sessions']
  }) => (
    <>
      <button type="button" data-testid="new" onClick={onCreateDefault}>
        New {sessions.length}
      </button>
      <button type="button" data-testid="resize-reset" onClick={onResetPrimaryWidth}>
        Reset split
      </button>
      {sessions[0] ? (
        <button
          type="button"
          data-testid="private-title"
          onClick={() =>
            onUpdateSession(sessions[0]!.id, (session) => ({
              ...session,
              title: `Working in ${session.cwd.path}`,
            }))
          }
        >
          Private title
        </button>
      ) : null}
    </>
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
  it('retains a session owner, filters its exact live cwd title, and releases after close-last', async () => {
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
    const onSessionsChanged = vi.fn()
    const onSessionsSource =
      vi.fn<
        (
          workspaceId: string,
          source: (() => readonly SessionsRendererSession[]) | undefined,
        ) => void
      >()
    const props = {
      cwd: localPath('/repo'),
      workspaceId: 'workspace',
      sessionsWorkspaceQualifier: sessionsWorkspaceQualifier(1, 0, 0),
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
      runtimes: {
        disposeSession: vi.fn(),
        sessionSnapshot: vi.fn(() => undefined),
      } as never,
      moveTargets: [],
      onMaterializationChange,
      onSessionsSource,
      onSessionsChanged,
      onController: vi.fn(),
      onPrepareMoveTarget: vi.fn(() => Promise.resolve()),
      onReleaseMoveTarget: vi.fn(),
      onTerminalMoved: vi.fn(),
      onAcknowledgeMoveTargets: vi.fn(() => Promise.resolve()),
      onError: vi.fn(),
    }

    await act(async () => {
      root.render(<TerminalWorkspace {...props} visible presentationVisible />)
      await settleEffects()
    })
    onMaterializationChange.mockClear()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new"]')?.click()
      await settleEffects()
    })
    expect(onMaterializationChange).toHaveBeenLastCalledWith('workspace', true)
    expect(onSessionsChanged).toHaveBeenCalled()
    const sessionsSource = [...props.onSessionsSource.mock.calls]
      .reverse()
      .find(([, source]) => typeof source === 'function')?.[1]
    expect(sessionsSource).toBeTypeOf('function')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="private-title"]')?.click()
      await settleEffects()
    })
    expect(sessionsSource?.()).toMatchObject([{ title: 'Shell · repo' }])
    expect(sessionsSource?.()[0]?.title).not.toContain('/repo')

    onSessionsChanged.mockClear()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="resize-reset"]')?.click()
      await settleEffects()
    })
    expect(onSessionsChanged).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        <TerminalWorkspace {...props} visible={false} presentationVisible={false} />,
      )
      await settleEffects()
    })
    expect(host.querySelector('[data-testid="close"]')).toBeNull()
    expect(onMaterializationChange).not.toHaveBeenCalledWith('workspace', false)

    await act(async () => {
      root.render(<TerminalWorkspace {...props} visible presentationVisible />)
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
