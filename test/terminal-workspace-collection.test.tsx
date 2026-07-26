// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { TerminalWorkspaceCollection } from '../src/renderer/src/terminal/TerminalWorkspaceCollection'
import { localPath, type ProjectState } from '../src/shared'

vi.mock('../src/renderer/src/terminal/TerminalWorkspace', () => ({
  TerminalWorkspace: ({ workspaceId }: { readonly workspaceId: string }) => (
    <div data-mounted-workspace={workspaceId} />
  ),
}))

describe('terminal workspace collection', () => {
  it('mounts no renderer terminal runtime for 20 closed worktrees', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const state = projectStateWithClosedWorktrees(20)

    act(() => {
      root.render(
        <TerminalWorkspaceCollection
          state={state}
          runtime={{ moveProps: vi.fn(() => ({})) } as never}
          railCompact={false}
          onRailCompact={vi.fn()}
          onRollup={vi.fn()}
          onOpenPath={vi.fn()}
          onOpenWebLink={vi.fn()}
          preferences={{
            terminalTheme: 'app',
            composerSubmitMode: 'enter',
            idleThresholdMs: 10_000,
            terminalRecoveryMode: 'prompt',
          }}
          onOpenSettings={vi.fn()}
          onOpenHarnessSettings={vi.fn()}
          onAddHarness={vi.fn()}
        />,
      )
    })

    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(1)
    expect(host.querySelector('[data-mounted-workspace="workspace-open"]')).not.toBeNull()
    act(() => root.unmount())
  })
})

function projectStateWithClosedWorktrees(count: number): ProjectState {
  const root = localPath('/repo')
  const open = {
    id: 'workspace-open',
    root,
    name: 'main',
    main: true,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
  return {
    root,
    activeProjectId: 'project',
    activeWorkspaceId: open.id,
    connectionState: 'connected',
    watchTier: 'native',
    projects: [
      {
        id: 'project',
        registeredRoot: root,
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: open.id,
        workspaces: [
          open,
          ...Array.from({ length: count }, (_, index) => ({
            ...open,
            id: `workspace-closed-${index}`,
            root: localPath(`/repo/closed-${index}`),
            name: `closed-${index}`,
            main: false,
            closed: true,
          })),
        ],
      },
    ],
  }
}
