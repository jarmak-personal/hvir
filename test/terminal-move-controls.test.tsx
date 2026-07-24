// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalMoveDialog } from '../src/renderer/src/terminal/TerminalMoveDialog'
import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type TerminalMovePlan,
  type WorkspaceState,
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
  vi.restoreAllMocks()
})

describe('terminal workspace move controls', () => {
  it('exposes a distinct new-worktree move action and its exact target', () => {
    const onPlanMove = vi.fn()
    const onDismissNewTargets = vi.fn()
    const target = targetWorkspace()
    act(() => {
      root.render(
        <TerminalRail
          label="main"
          visible
          terminalTheme="app"
          recoveryReady
          available
          menuOpen={false}
          moveMenuOpen
          moveTargets={[target]}
          launchMenuEntries={[]}
          checkingHiddenProfiles={false}
          split={false}
          sessions={[session()]}
          activeId="terminal-1"
          providers={[]}
          profiles={[]}
          onSplit={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleMenu={vi.fn()}
          onToggleMoveMenu={vi.fn()}
          onPlanMove={onPlanMove}
          onDismissNewTargets={onDismissNewTargets}
          onAddSession={vi.fn()}
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

    const move = host.querySelector<HTMLButtonElement>('.terminal-workspace-move-button')
    expect(move?.getAttribute('aria-label')).toBe('Move terminal, new worktree available')
    expect(move?.querySelector('.terminal-new-worktree-badge')?.textContent).toBe('new')
    expect(host.querySelector('.terminal-move-menu')?.textContent).toContain(
      'Move Investigate #140 from main',
    )
    const targetButton = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes('/repo-feature'))
    expect(targetButton?.textContent).toContain('featureNew')

    act(() => targetButton?.click())
    expect(onPlanMove).toHaveBeenCalledWith(target)
    const dismiss = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes('Dismiss new-worktree'))
    act(() => dismiss?.click())
    expect(onDismissNewTargets).toHaveBeenCalledOnce()

    act(() => {
      root.render(
        <TerminalRail
          label="main"
          visible
          terminalTheme="app"
          recoveryReady
          available
          menuOpen={false}
          moveMenuOpen
          moveTargets={[{ ...target, newlyDiscovered: false }]}
          launchMenuEntries={[]}
          checkingHiddenProfiles={false}
          split={false}
          sessions={[session()]}
          activeId="terminal-1"
          providers={[]}
          profiles={[]}
          onSplit={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleMenu={vi.fn()}
          onToggleMoveMenu={vi.fn()}
          onPlanMove={onPlanMove}
          onDismissNewTargets={onDismissNewTargets}
          onAddSession={vi.fn()}
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
    expect(host.querySelector('.terminal-workspace-move-button')).not.toBeNull()
    expect(host.querySelector('.terminal-new-worktree-badge')).toBeNull()
    expect(host.querySelector('.terminal-move-menu')?.textContent).toContain(
      '/repo-feature',
    )
  })

  it('offers a counted bulk action while keeping dormant rows distinct', () => {
    const onResumeAll = vi.fn()
    const dormant = { ...session(), dormant: true, status: 'Ready to start' }
    act(() => {
      root.render(
        <TerminalRail
          label="main"
          visible
          terminalTheme="app"
          recoveryReady
          available
          menuOpen={false}
          moveMenuOpen={false}
          moveTargets={[]}
          launchMenuEntries={[]}
          checkingHiddenProfiles={false}
          split={false}
          sessions={[dormant]}
          activeId={dormant.id}
          providers={[]}
          profiles={[]}
          onSplit={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleMenu={vi.fn()}
          onToggleMoveMenu={vi.fn()}
          onPlanMove={vi.fn()}
          onDismissNewTargets={vi.fn()}
          onAddSession={vi.fn()}
          onAddHarness={vi.fn()}
          onRefreshProbes={vi.fn()}
          onOpenHarnessSettings={vi.fn()}
          onResumeAll={onResumeAll}
          onFocusSession={vi.fn()}
          onMoveSession={vi.fn()}
          onCloseSession={vi.fn()}
        />,
      )
    })

    const resumeAll = host.querySelector<HTMLButtonElement>('.terminal-resume-all-button')
    expect(resumeAll?.textContent).toContain('Resume all now · 1')
    expect(host.querySelector('.terminal-list-row.dormant')).not.toBeNull()
    act(() => resumeAll?.click())
    expect(onResumeAll).toHaveBeenCalledOnce()
  })

  it('shows exact move consequences and traps keyboard focus in confirmation', () => {
    const onCancel = vi.fn()
    act(() => {
      root.render(
        <TerminalMoveDialog
          plan={movePlan()}
          onCancel={onCancel}
          onMove={() => Promise.resolve()}
        />,
      )
    })
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')]
    for (const button of buttons) {
      Object.defineProperty(button, 'offsetParent', {
        configurable: true,
        value: dialog,
      })
    }
    expect(dialog?.textContent).toContain('Investigate #140')
    expect(dialog?.textContent).toContain('/repo')
    expect(dialog?.textContent).toContain('/repo-feature')
    expect(dialog?.textContent).toContain('1 workspace-authorized web pane will close')
    expect(dialog?.textContent).toContain('Process and conversation stay live')
    expect(
      dialog?.querySelector('.terminal-move-location-target')?.textContent,
    ).toContain('feature')
    expect(dialog?.querySelector('.terminal-move-session')?.textContent).toContain(
      'running',
    )

    buttons.at(-1)?.focus()
    act(() => {
      buttons
        .at(-1)
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[0])
    buttons[0]?.focus()
    act(() => {
      buttons[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(buttons.at(-1))
    act(() => {
      buttons[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('blocks repeated terminal moves and dismissal while the move is busy', async () => {
    const onCancel = vi.fn()
    let finishMove = (): void => undefined
    const onMove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishMove = resolve
        }),
    )
    act(() => {
      root.render(
        <TerminalMoveDialog plan={movePlan()} onCancel={onCancel} onMove={onMove} />,
      )
    })
    const move = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Move terminal here and open',
    )!

    act(() => {
      move.click()
      move.click()
    })
    expect(onMove).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].every(
        (button) => button.disabled,
      ),
    ).toBe(true)

    act(() => {
      move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => {
      finishMove()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(move.disabled).toBe(false)
  })
})

function session(): TerminalSession {
  return {
    id: 'terminal-1',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    riskAcknowledged: false,
    capabilities: {
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'none',
    },
    fallbackTitle: 'Codex · repo',
    title: 'Investigate #140',
    status: 'pid 140',
    identityStatus: 'identified',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
  }
}

function targetWorkspace(): WorkspaceState {
  return {
    id: 'workspace:local:/repo-feature',
    root: localPath('/repo-feature'),
    name: 'feature',
    branch: 'feature',
    main: false,
    missing: false,
    repository: true,
    changedFiles: 0,
    newlyDiscovered: true,
  }
}

function movePlan(): TerminalMovePlan {
  return {
    terminalId: 'terminal-1',
    terminalTitle: 'Investigate #140',
    sourceProjectId: 'project:local:/repo',
    sourceWorkspaceId: 'workspace:local:/repo',
    sourceWorkspaceName: 'main',
    sourceRoot: localPath('/repo'),
    targetWorkspaceId: 'workspace:local:/repo-feature',
    targetWorkspaceName: 'feature',
    targetRoot: localPath('/repo-feature'),
    webPaneIds: ['web-a'],
  }
}
