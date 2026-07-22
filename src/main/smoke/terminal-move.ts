import type { BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  hostPathEquals,
  type HostPath,
  type ProjectState,
} from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { TerminalMoveSessionStore } from '../terminal/session-registry'
import { TerminalWorkspaceMoveCoordinator } from '../terminal/terminal-workspace-move-coordinator'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'

const TARGET_WORKSPACE_ID = 'smoke-move-target'

export interface TerminalMoveSmokeHarness {
  readonly coordinator: TerminalWorkspaceMoveCoordinator
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly sourceRoot: HostPath
  readonly targetRoot: HostPath
  introduceTarget(): ProjectState
  reset(): ProjectState
}

export function createTerminalMoveSmokeHarness({
  sourceState,
  targetRoot,
  supervisor,
  resources,
  webPanes,
  onState,
}: {
  readonly sourceState: () => ProjectState
  readonly targetRoot: HostPath
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly webPanes: WebPaneRouteRegistry
  readonly onState: (state: ProjectState) => void
}): TerminalMoveSmokeHarness {
  const baseline = sourceState()
  const sourceProject = baseline.projects[0]!
  const sourceWorkspace = sourceProject.workspaces[0]!
  let state = baseline
  const associations = new Map<string, HostPath>()
  const sessions: TerminalMoveSessionStore = {
    get: (id) => {
      const terminal = supervisor.get(id)
      if (!terminal) return undefined
      const workspaceRoot = associations.get(id) ?? terminal.workspaceRoot
      associations.set(id, workspaceRoot)
      return {
        id,
        providerId: terminal.providerId,
        profileId: asHarnessProfileId('plain-shell-default'),
        launchRevision: 1,
        harnessSessionId: terminal.harnessSessionId,
        hostId: terminal.hostId,
        workspaceRoot,
        cwd: terminal.cwd,
        title: 'Smoke live terminal',
        position: 0,
        active: true,
        updatedAt: Date.now(),
      }
    },
    move: (request) => {
      const current = sessions.get(request.id)
      if (!current || !hostPathEquals(current.workspaceRoot, request.sourceRoot)) {
        return Promise.reject(new Error('Smoke terminal association is stale'))
      }
      associations.set(request.id, request.targetRoot)
      const { workspaceRoot: _workspaceRoot, ...recovery } = current
      return Promise.resolve(recovery)
    },
  }
  const projects = {
    get active() {
      return {
        projectId: state.activeProjectId,
        workspaceId: state.activeWorkspaceId,
      }
    },
    state: () => state,
    projectById: (id: string) => state.projects.find((project) => project.id === id),
    activate: (_projectId: string, workspaceId: string) => {
      const workspace = state.projects[0]?.workspaces.find(
        (candidate) => candidate.id === workspaceId,
      )
      if (!workspace) return Promise.reject(new Error('Unknown smoke move workspace'))
      state = {
        ...state,
        root: workspace.root,
        activeWorkspaceId: workspace.id,
        projects: state.projects.map((project) => ({
          ...project,
          activeWorkspaceId: workspace.id,
          workspaces: project.workspaces.map((candidate) =>
            candidate.id === workspace.id
              ? { ...candidate, newlyDiscovered: false }
              : candidate,
          ),
        })),
      }
      onState(state)
      return Promise.resolve(state)
    },
  }
  const coordinator = new TerminalWorkspaceMoveCoordinator({
    projects,
    workspaces: {
      serialize: <T>(operation: () => Promise<T>) => operation(),
      replaceWatch: () => Promise.resolve(),
    },
    sessions,
    ptys: supervisor,
    resources,
    webPanes,
  })
  return {
    coordinator,
    sourceWorkspaceId: sourceWorkspace.id,
    targetWorkspaceId: TARGET_WORKSPACE_ID,
    sourceRoot: sourceWorkspace.root,
    targetRoot,
    introduceTarget: () => {
      state = {
        ...sourceState(),
        projects: [
          {
            ...sourceProject,
            workspaces: [
              sourceWorkspace,
              {
                id: TARGET_WORKSPACE_ID,
                root: targetRoot,
                name: 'smoke-move-target',
                branch: 'smoke/move-target',
                main: false,
                missing: false,
                repository: true,
                changedFiles: 0,
                newlyDiscovered: true,
              },
            ],
          },
        ],
      }
      onState(state)
      return state
    },
    reset: () => {
      state = sourceState()
      onState(state)
      return state
    },
  }
}

export async function verifyTerminalMoveSmoke({
  win,
  supervisor,
  harness,
  emitState,
}: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly harness: TerminalMoveSmokeHarness
  readonly emitState: (state: ProjectState) => void
}): Promise<string> {
  const terminal = supervisor.list()[0]
  if (!terminal) throw new Error('terminal move smoke requires a live terminal')
  const originalCount = supervisor.list().length
  emitState(harness.introduceTarget())
  await runMoveInteraction(
    win,
    harness.targetRoot.path,
    'smoke-move-target terminal workspace',
    true,
  )
  assertSameTerminal(
    supervisor,
    terminal.id,
    terminal.pid,
    originalCount,
    harness.targetRoot,
  )

  supervisor.write(
    terminal.id,
    terminal.ownerId,
    "printf '\\033]0;Moved smoke terminal\\007moved-output-marker\\n'; sleep 5\n",
    terminal.ownerGeneration,
  )
  await runMoveInteraction(
    win,
    harness.sourceRoot.path,
    'hvir terminal workspace',
    false,
    'Moved smoke terminal',
  )
  assertSameTerminal(
    supervisor,
    terminal.id,
    terminal.pid,
    originalCount,
    harness.sourceRoot,
  )
  emitState(harness.reset())
  return `same pid ${terminal.pid} · same canvas/surface · ${originalCount} supervised`
}

async function runMoveInteraction(
  win: BrowserWindow,
  targetPath: string,
  targetDeckLabel: string,
  expectNew: boolean,
  waitForTitle?: string,
): Promise<void> {
  const result: unknown = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const fail = (reason, details = {}) => resolve({ ok: false, reason, ...details });
      if (!window.__hvirSmokeMoveCanvas) {
        window.__hvirSmokeMoveContainer = document.querySelector(
          '.terminal-deck:not([hidden]) .terminal-container'
        );
        window.__hvirSmokeMoveSurface = window.__hvirSmokeMoveContainer?.querySelector(
          ':scope > .terminal-engine-host'
        );
        window.__hvirSmokeMoveCanvas = window.__hvirSmokeMoveSurface?.querySelector('canvas');
      }
      const poll = () => {
        const visibleRail = document.querySelector('.terminal-rail:not([hidden])');
        const title = visibleRail?.querySelector('.terminal-list-title')?.textContent?.trim();
        if (${JSON.stringify(waitForTitle)} && title !== ${JSON.stringify(waitForTitle)}) {
          if (Date.now() <= deadline) return setTimeout(poll, 25);
          return fail('moved terminal output title missing', { title });
        }
        const move = visibleRail?.querySelector('.terminal-workspace-move-button');
        if (!(move instanceof HTMLButtonElement) || move.disabled) {
          if (Date.now() <= deadline) return setTimeout(poll, 25);
          return fail('move-terminal control unavailable');
        }
        if (${expectNew} && !move.getAttribute('aria-label')?.includes('new worktree')) {
          return fail('new-worktree move indicator missing');
        }
        move.click();
        waitForTarget();
      };
      const waitForTarget = () => {
        const target = [...document.querySelectorAll('.terminal-move-menu [role="menuitem"]')]
          .find((button) => button.textContent?.includes(${JSON.stringify(targetPath)}));
        if (target instanceof HTMLButtonElement) {
          target.click();
          return waitForDialog();
        }
        if (Date.now() <= deadline) return setTimeout(waitForTarget, 25);
        fail('terminal move target missing');
      };
      const waitForDialog = () => {
        const dialog = document.querySelector('.terminal-move-dialog');
        const confirm = [...(dialog?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.includes('Move terminal here and open'));
        if (dialog?.textContent?.includes('Smoke live terminal') && confirm) {
          confirm.click();
          return waitForMove();
        }
        if (Date.now() <= deadline) return setTimeout(waitForDialog, 25);
        fail('terminal move confirmation missing exact terminal');
      };
      const waitForMove = () => {
        const deck = document.querySelector('.terminal-deck:not([hidden])');
        const container = deck?.querySelector('.terminal-container');
        const surface = container?.querySelector(':scope > .terminal-engine-host');
        const canvas = surface?.querySelector('canvas');
        const rows = document.querySelectorAll(
          '.terminal-rail:not([hidden]) .terminal-list-row'
        );
        if (
          deck?.getAttribute('aria-label') === ${JSON.stringify(targetDeckLabel)} &&
          canvas === window.__hvirSmokeMoveCanvas &&
          surface === window.__hvirSmokeMoveSurface &&
          surface?.parentElement === container &&
          container !== window.__hvirSmokeMoveContainer &&
          !window.__hvirSmokeMoveContainer?.isConnected &&
          rows.length === 1
        ) return resolve(true);
        if (Date.now() <= deadline) return setTimeout(waitForMove, 25);
        fail('terminal did not reparent one adapter surface into the new React container', {
          deckLabel: deck?.getAttribute('aria-label'),
          sameCanvas: canvas === window.__hvirSmokeMoveCanvas,
          sameSurface: surface === window.__hvirSmokeMoveSurface,
          surfaceOwnedByContainer: surface?.parentElement === container,
          replacedContainer: container !== window.__hvirSmokeMoveContainer,
          oldContainerConnected: window.__hvirSmokeMoveContainer?.isConnected,
          rowCount: rows.length,
        });
      };
      poll();
    })
  `)
  if (result !== true) {
    throw new Error(`Terminal move renderer check failed: ${JSON.stringify(result)}`)
  }
}

function assertSameTerminal(
  supervisor: PtySupervisor,
  id: string,
  pid: number,
  count: number,
  root: HostPath,
): void {
  const current = supervisor.get(id)
  if (
    !current ||
    current.pid !== pid ||
    !hostPathEquals(current.workspaceRoot, root) ||
    supervisor.list().length !== count
  ) {
    throw new Error('terminal move restarted, duplicated, or mis-associated the PTY')
  }
}
