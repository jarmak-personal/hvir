import type { BrowserWindow } from 'electron'

import { plainShellProvider } from '../harness/harness-provider'
import {
  ProjectCoordinator,
  type ProjectCleanupPort,
  type ProjectRegistryPort,
  type ProjectWorkspacePort,
} from '../project-coordinator'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  asHarnessProfileId,
  type HostPath,
  type ProjectState,
  type RegisteredProjectState,
  type TerminalRecoverySession,
} from '../../shared'

export function workspaceCloseSmokeCommands({
  host,
  getState,
  setState,
  cleanup,
}: {
  readonly host: ProjectHost
  readonly getState: () => ProjectState
  readonly setState: (state: ProjectState) => void
  readonly cleanup: ProjectCleanupPort
}) {
  const registry = {
    get active() {
      const state = getState()
      return {
        host,
        root: state.root,
        projectId: state.activeProjectId,
        workspaceId: state.activeWorkspaceId,
      }
    },
    state: getState,
    projectById: (projectId: string) =>
      getState().projects.find((project) => project.id === projectId),
    closeWorkspace: (projectId: string, workspaceId: string) => {
      const state = updateWorkspace(getState(), projectId, workspaceId, (workspace) => ({
        ...workspace,
        closed: true,
      }))
      setState(state)
      return Promise.resolve(state)
    },
    reopenWorkspace: (projectId: string, workspaceId: string) => {
      const reopened = updateWorkspace(
        getState(),
        projectId,
        workspaceId,
        (workspace) => ({ ...workspace, closed: false }),
      )
      const project = reopened.projects.find((candidate) => candidate.id === projectId)!
      const workspace = project.workspaces.find(
        (candidate) => candidate.id === workspaceId,
      )!
      const state = {
        ...reopened,
        root: workspace.root,
        activeProjectId: projectId,
        activeWorkspaceId: workspaceId,
        projects: reopened.projects.map((candidate) =>
          candidate.id === projectId
            ? { ...candidate, activeWorkspaceId: workspaceId }
            : candidate,
        ),
      }
      setState(state)
      return Promise.resolve(state)
    },
  } as unknown as ProjectRegistryPort
  const workspaces: ProjectWorkspacePort = {
    serialize: (operation) => operation(),
    refresh: () => Promise.resolve(getState()),
    replaceWatch: () => Promise.resolve(),
    invalidateProject: () => undefined,
    settleProject: () => Promise.resolve(),
  }
  const coordinator = new ProjectCoordinator({ registry, workspaces, cleanup })
  return {
    planWorkspaceClose: (projectId: string, workspaceId: string) =>
      Promise.resolve(coordinator.planWorkspaceClose(projectId, workspaceId)),
    closeWorkspace: (
      projectId: string,
      workspaceId: string,
      expectedTerminalCount: number,
      terminateTerminals: boolean,
    ) =>
      coordinator.closeWorkspace(
        projectId,
        workspaceId,
        expectedTerminalCount,
        terminateTerminals,
      ),
    reopenWorkspace: (projectId: string, workspaceId: string) =>
      coordinator.reopenWorkspace(projectId, workspaceId),
  }
}

export async function verifyWorkspaceCloseSmoke({
  win,
  host,
  supervisor,
  resources,
  activeRoot,
  closeRoot,
  getState,
  setState,
  emitState,
  recovery,
}: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly activeRoot: HostPath
  readonly closeRoot: HostPath
  readonly getState: () => ProjectState
  readonly setState: (state: ProjectState) => void
  readonly emitState: (state: ProjectState) => void
  readonly recovery: {
    readonly add: (root: HostPath, session: TerminalRecoverySession) => void
    readonly has: (root: HostPath, sessionId: string) => boolean
  }
}): Promise<string> {
  const owner = resources.currentOwner(win.webContents.id)
  const sessionId = 'workspace-close-smoke-terminal'
  const workspaceId = 'smoke-closeable-workspace'
  const projectId = getState().activeProjectId
  const state = getState()
  const project = state.projects.find((candidate) => candidate.id === projectId)!
  setState({
    ...state,
    projects: state.projects.map((candidate) =>
      candidate.id === projectId
        ? {
            ...candidate,
            workspaces: [
              ...candidate.workspaces,
              {
                id: workspaceId,
                root: closeRoot,
                name: 'Closeable',
                main: false,
                closed: false,
                missing: false,
                repository: true,
                changedFiles: 0,
              },
            ],
          }
        : candidate,
    ),
  })
  recovery.add(closeRoot, {
    id: sessionId,
    providerId: plainShellProvider.manifest.id,
    profileId: asHarnessProfileId('smoke-workspace-close'),
    launchRevision: 1,
    recoverySkipCount: 0,
    hostId: host.hostId,
    cwd: closeRoot,
    title: 'Workspace close smoke',
    position: 0,
    active: true,
    updatedAt: Date.now(),
  })
  await withTimeout(
    supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: closeRoot,
      workspaceRoot: closeRoot,
      ownerId: owner.id,
      ownerGeneration: owner.generation,
      sessionId,
    }),
    'workspace close PTY setup timed out',
  )
  let resourceReleased = false
  resources.register(
    owner,
    {
      lifetime: 'workspace',
      type: 'html-preview',
      root: closeRoot,
      id: 'workspace-close-smoke-resource',
    },
    () => {
      resourceReleased = true
    },
  )
  emitState(getState())

  await runCloseDialog(win, 'Cancel')
  if (
    !supervisor.get(sessionId) ||
    !recovery.has(closeRoot, sessionId) ||
    resourceReleased
  ) {
    throw new Error('cancelling workspace close changed owned resources')
  }

  const unaffectedBefore = [...supervisor.workspaceSessionIds(activeRoot)].sort()
  await runCloseDialog(win, 'Close workspace')
  if (supervisor.get(sessionId)) throw new Error('workspace close retained its live PTY')
  if (recovery.has(closeRoot, sessionId)) {
    throw new Error('workspace close retained its recovery record')
  }
  if (!resourceReleased) throw new Error('workspace close retained renderer resources')
  if (
    JSON.stringify([...supervisor.workspaceSessionIds(activeRoot)].sort()) !==
    JSON.stringify(unaffectedBefore)
  ) {
    throw new Error('workspace close affected another workspace terminal')
  }
  const closed = getState()
    .projects.find((candidate) => candidate.id === project.id)
    ?.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!closed?.closed || closed.missing) {
    throw new Error('workspace close did not retain a present catalog record')
  }
  setState(state)
  emitState(state)
  return 'cancel-safe · live PTY ended · recovery forgotten · renderer resource revoked'
}

function updateWorkspace(
  state: ProjectState,
  projectId: string,
  workspaceId: string,
  update: (
    workspace: RegisteredProjectState['workspaces'][number],
  ) => RegisteredProjectState['workspaces'][number],
): ProjectState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            workspaces: project.workspaces.map((workspace) =>
              workspace.id === workspaceId ? update(workspace) : workspace,
            ),
          }
        : project,
    ),
  }
}

async function runCloseDialog(
  win: BrowserWindow,
  action: 'Cancel' | 'Close workspace',
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const waitForControl = () => {
          const close = document.querySelector(
            '[aria-label="Close workspace Closeable"]'
          );
          if (!close) {
            if (Date.now() > deadline) {
              const labels = [...document.querySelectorAll('.workspace-tab button')]
                .map((button) => button.getAttribute('aria-label') || button.textContent?.trim());
              const projects = [...document.querySelectorAll('.project-tab')]
                .map((tab) => tab.textContent?.trim());
              const fatal = document.querySelector('.fatal-error')?.textContent || '';
              const bar = document.querySelector('.workspaces-bar')?.outerHTML || '';
              return reject(new Error(
                'workspace close control missing: labels=' + JSON.stringify(labels) +
                ' projects=' + JSON.stringify(projects) + ' fatal=' + fatal +
                ' bar=' + bar.slice(0, 4000)
              ));
            }
            return setTimeout(waitForControl, 25);
          }
          if (close.disabled) return reject(new Error('inactive workspace close is disabled'));
          if (document.querySelector('[aria-label="Closeable terminal workspace"]')) {
            return reject(new Error('inactive retained record materialized a workspace view'));
          }
          close.click();
          const waitForDialog = () => {
            const dialog = document.querySelector('.close-workspace-dialog');
            if (!dialog) {
              if (Date.now() > deadline) return reject(new Error('workspace close dialog missing'));
              return setTimeout(waitForDialog, 25);
            }
            const text = dialog.textContent || '';
            if (!text.includes('1 hvir terminal will be terminated') ||
                !text.includes('forget its recovery record')) {
              return reject(new Error('workspace close confirmation count or recovery warning missing'));
            }
            [...dialog.querySelectorAll('button')]
              .find((button) => button.textContent?.trim() === ${JSON.stringify(action)})
              ?.click();
            const waitForResult = () => {
              const dialogClosed = !document.querySelector('.close-workspace-dialog');
              const tab = document.querySelector('[aria-label="Close workspace Closeable"]');
              const catalog = [...document.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === 'Worktrees 1');
              const terminalWorkspace = document.querySelector(
                '[aria-label="Closeable terminal workspace"]'
              );
              const done = ${JSON.stringify(action)} === 'Cancel'
                ? dialogClosed && Boolean(tab) && !terminalWorkspace
                : dialogClosed && !tab && Boolean(catalog) && !terminalWorkspace;
              if (done) return resolve(true);
              if (Date.now() > deadline) return reject(new Error('workspace close result did not settle'));
              setTimeout(waitForResult, 25);
            };
            waitForResult();
          };
          waitForDialog();
        };
        waitForControl();
      })
    `),
    'workspace close UI timed out',
  )
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
