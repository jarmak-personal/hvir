import type { BrowserWindow } from 'electron'

import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { HostPath, ProjectState, TerminalRecoverySession } from '../../shared'
import { verifyWorkspaceCloseSmoke } from './workspace-close'

interface FolderSelection {
  readonly hostId: string
  readonly path: string
}

/** Exercise project/workspace transitions and remote presentation without prior scenarios. */
export async function verifyWorkspaceRemoteWorkflow(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly activeRoot: HostPath
  readonly closeRoot: HostPath
  readonly baseState: () => ProjectState
  readonly remoteState: () => ProjectState
  readonly getState: () => ProjectState
  readonly setState: (state: ProjectState) => ProjectState
  readonly emitState: (state: ProjectState) => void
  readonly emitHostKeyPrompt: () => void
  readonly openedFolderSelections: readonly FolderSelection[]
  readonly recovery: {
    readonly add: (root: HostPath, session: TerminalRecoverySession) => void
    readonly has: (root: HostPath, sessionId: string) => boolean
  }
}): Promise<string> {
  const {
    win,
    host,
    supervisor,
    resources,
    activeRoot,
    closeRoot,
    baseState,
    remoteState,
    getState,
    setState,
    emitState,
    emitHostKeyPrompt,
    openedFolderSelections,
    recovery,
  } = options
  const publish = (state: ProjectState): void => {
    emitState(setState(state))
  }

  try {
    const workspaceClose = await verifyWorkspaceCloseSmoke({
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
    })

    const containedError = (await win.webContents.executeJavaScript(`
      window.hvir.invoke('project:browse-host', {
        hostId: 'local',
        path: '/tmp/hvir-smoke.missing'
      }).then((result) => !result.ok && result.error)
    `)) as string
    if (!containedError.includes('Folder not found')) {
      throw new Error(
        `project browse error escaped its result envelope: ${containedError}`,
      )
    }

    publish(baseStateWithMissing(baseState()))
    const missingWorkspace = (await rendererValue(
      win,
      `(() => {
        const notices = [...document.querySelectorAll('.workspace-missing-notice')];
        const git = [...document.querySelectorAll('.rail-nav button')]
          .find((button) => button.textContent?.trim().startsWith('Git'));
        const terminal = document.querySelector('.terminal-surface');
        const newTerminal = document.querySelector('[aria-label="New terminal"]');
        const splitTerminal = document.querySelector('[aria-label="Split terminal"]');
        if (
          notices.length >= 2 && !git && !terminal &&
          newTerminal?.disabled && splitTerminal?.disabled
        ) {
          if (notices.some((notice) => notice.textContent?.includes('ENOENT'))) {
            throw new Error('missing workspace exposes a raw filesystem error');
          }
          return notices.length + ' notices · Git/new PTYs suppressed · no PTY materialized';
        }
      })()`,
      'missing workspace state did not settle',
    )) as string
    publish(baseState())
    await rendererWait(
      win,
      `!document.querySelector('.workspace-missing-notice')`,
      'workspace did not recover',
    )

    publish(remoteState())
    const remoteConnection = (await rendererValue(
      win,
      `(() => {
        const trigger = document.querySelector(
          '.project-tab.active .project-connection-trigger'
        );
        if (!(trigger instanceof HTMLButtonElement)) return undefined;
        if (!document.querySelector('.project-connection-menu')) trigger.click();
        const menu = document.querySelector('.project-connection-menu');
        const text = menu?.textContent || '';
        if (
          menu && text.includes('ssh:smoke-remote') && text.includes('Connected') &&
          text.includes('File watching: polling') && text.includes('Change') &&
          text.includes('Disconnect')
        ) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          return 'badge→status + controls';
        }
      })()`,
      'SSH connection menu content did not settle',
    )) as string
    await rendererWait(
      win,
      `!document.querySelector('.project-connection-menu')`,
      'SSH connection menu ignored Escape',
    )

    publish(baseState())
    await rendererWait(
      win,
      `(() => {
        const active = document.querySelector('.project-tab.active');
        return active && !active.querySelector('.remote-connection-badge');
      })()`,
      'local project did not reactivate without a remote badge',
    )

    emitHostKeyPrompt()
    const hostKeyPrompt = (await rendererValue(
      win,
      `(() => {
        const dialog = document.querySelector('.project-dialog');
        const fingerprint = document.querySelector('.ssh-host-fingerprint');
        const trust = [...document.querySelectorAll('.project-dialog button')]
          .find((node) => node.textContent?.trim() === 'Trust Host');
        if (dialog && fingerprint && trust) {
          if (dialog.scrollWidth > dialog.clientWidth) {
            throw new Error('host fingerprint overflowed its dialog');
          }
          trust.click();
          return 'wrapped fingerprint · explicit trust';
        }
      })()`,
      'host-key prompt did not settle',
    )) as string

    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    const projectRegistration = (await rendererValue(
      win,
      `(() => {
        if (document.querySelector('.session-bar')) {
          throw new Error('legacy host/session strip is still mounted');
        }
        const activeProject = document.querySelector('.project-tab.active');
        if (activeProject?.querySelector('.remote-connection-badge')) {
          throw new Error('local project shows a remote connection badge');
        }
        const projectMain = activeProject?.querySelector('.project-tab-main');
        if (!window.__hvirSmokeRegistrationStarted) {
          projectMain?.focus({ focusVisible: true });
          if (!projectMain || getComputedStyle(projectMain).boxShadow === 'none') {
            throw new Error('project tab focus ring is missing');
          }
          if (document.querySelector('.workspaces-bar')) {
            throw new Error('single-checkout project should hide the workspaces bar');
          }
          const addProject = document.querySelector('.project-add');
          if (!(addProject instanceof HTMLButtonElement)) {
            throw new Error('project registration control is missing');
          }
          addProject.click();
          window.__hvirSmokeRegistrationStarted = true;
          return undefined;
        }
        const local = [...document.querySelectorAll('.session-host-option')]
          .find((node) => node.textContent?.includes('Local'));
        const choose = [...document.querySelectorAll('.project-dialog button')]
          .find((node) => node.textContent?.trim() === 'Choose folder');
        if (!window.__hvirSmokeHostChosen) {
          if (!local || !choose) return undefined;
          if (local.querySelector('.remote-connection-badge')) {
            throw new Error('local host option shows a remote connection badge');
          }
          local.click();
          choose.click();
          window.__hvirSmokeHostChosen = true;
          return undefined;
        }
        if (
          window.__hvirSmokeFolderSubmitted &&
          !document.querySelector('.project-dialog')
        ) {
          return 'Local→invalid→reveal→use ' +
            ${JSON.stringify(`${activeRoot.path}/docs`)};
        }
        const input = document.querySelector('.folder-path-form input');
        const selected = document.querySelector('.folder-selection code')?.textContent || '';
        const selectedRow = document.querySelector('.folder-browser .directory-row.selected');
        const browser = document.querySelector('.folder-browser');
        const show = [...document.querySelectorAll('.project-dialog button')]
          .find((node) => node.textContent?.trim() === 'Show in tree');
        const use = [...document.querySelectorAll('.project-dialog button')]
          .find((node) => node.textContent?.trim() === 'Use this folder');
        if (!(input instanceof HTMLInputElement) || !browser || !show || !use) {
          return undefined;
        }
        const setPath = (value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            .set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        if (!window.__hvirSmokeInvalidSubmitted) {
          const bounds = browser.getBoundingClientRect();
          const row = selectedRow?.getBoundingClientRect();
          if (!input.value || selected !== input.value || !row ||
              row.top < bounds.top || row.bottom > bounds.bottom) return undefined;
          if (input.form !== show.closest('form') || input.form !== use.closest('form')) {
            throw new Error('folder actions are not adjacent to the path field');
          }
          setPath('/tmp/hvir-smoke.missing');
          input.form.requestSubmit();
          window.__hvirSmokeInvalidSubmitted = true;
          return undefined;
        }
        const error = document.querySelector('.dialog-error')?.textContent || '';
        if (!window.__hvirSmokeRevealStarted) {
          if (!error.includes('Folder not found') || !use.disabled ||
              document.activeElement !== input) return undefined;
          const target = ${JSON.stringify(`${activeRoot.path}/docs`)};
          setPath(target);
          browser.scrollTop = browser.scrollHeight;
          show.click();
          window.__hvirSmokeRevealStarted = true;
          return undefined;
        }
        const target = ${JSON.stringify(`${activeRoot.path}/docs`)};
        const row = [...document.querySelectorAll('.folder-browser .directory-row')]
          .find((node) => node.getAttribute('title') === target);
        const bounds = browser.getBoundingClientRect();
        const rect = row?.getBoundingClientRect();
        if (
          row?.classList.contains('selected') && rect &&
          rect.top >= bounds.top && rect.bottom <= bounds.bottom &&
          !use.disabled && document.activeElement === input
        ) {
          use.click();
          window.__hvirSmokeFolderSubmitted = true;
          return undefined;
        }
      })()`,
      'project registration flow did not settle',
      12_000,
    )) as string
    if (
      openedFolderSelections.length !== 1 ||
      openedFolderSelections[0]?.hostId !== activeRoot.hostId ||
      openedFolderSelections[0]?.path !== `${activeRoot.path}/docs`
    ) {
      throw new Error(
        `folder selection opened an unexpected target: ${JSON.stringify(openedFolderSelections)}`,
      )
    }

    const closeableState = baseState()
    publish({
      ...closeableState,
      projects: [
        ...closeableState.projects,
        {
          id: 'smoke-closeable-project',
          registeredRoot: closeRoot,
          displayName: 'Close me',
          connectionState: host.connectionState,
          watchTier: host.watchTier,
          activeWorkspaceId: 'smoke-closeable-workspace',
          workspaces: [
            {
              id: 'smoke-closeable-workspace',
              root: closeRoot,
              name: 'Close me',
              main: true,
              closed: false,
              missing: true,
              repository: false,
              changedFiles: 0,
            },
          ],
        },
      ],
    })
    const projectClose = (await rendererValue(
      win,
      `(() => {
        const close = document.querySelector('[aria-label="Close project Close me"]');
        if (!window.__hvirSmokeProjectCloseStarted) {
          if (!(close instanceof HTMLButtonElement)) return undefined;
          if (close.disabled) throw new Error('secondary project close is disabled');
          close.click();
          window.__hvirSmokeProjectCloseStarted = true;
          return undefined;
        }
        const dialog = document.querySelector('.close-project-dialog');
        if (!window.__hvirSmokeProjectCloseConfirmed) {
          if (!dialog) return undefined;
          if (!dialog.textContent?.includes(
            'Files, Git branches, and worktrees are not changed'
          )) throw new Error('project close confirmation incomplete');
          const confirm = [...dialog.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Close project');
          if (!confirm) throw new Error('project close confirmation action missing');
          confirm.click();
          window.__hvirSmokeProjectCloseConfirmed = true;
          return undefined;
        }
        const removed = document.querySelector('[aria-label="Close project Close me"]');
        const remaining = document.querySelector('[aria-label="Close project hvir"]');
        if (!removed && remaining?.disabled) {
          return 'confirmed unregister · final project protected';
        }
      })()`,
      'project close flow did not settle',
    )) as string

    return [
      workspaceClose,
      'contained browse error',
      missingWorkspace,
      remoteConnection,
      hostKeyPrompt,
      projectRegistration,
      projectClose,
    ].join(' · ')
  } catch (error) {
    const state = await readWorkspaceRemoteState(win, getState, openedFolderSelections)
    throw new Error(
      `Workspace/remote workflow failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  }
}

function baseStateWithMissing(state: ProjectState): ProjectState {
  return {
    ...state,
    projects: state.projects.map((project) => ({
      ...project,
      workspaces: project.workspaces.map((workspace) => ({
        ...workspace,
        missing: workspace.id === state.activeWorkspaceId,
      })),
    })),
  }
}

async function readWorkspaceRemoteState(
  win: BrowserWindow,
  getState: () => ProjectState,
  openedFolderSelections: readonly FolderSelection[],
): Promise<unknown> {
  let renderer: unknown = { unavailable: true }
  try {
    if (!win.isDestroyed()) {
      renderer = await win.webContents.executeJavaScript(`
        (() => ({
          activeProject: document.querySelector('.project-tab.active')
            ?.textContent?.trim().slice(0, 160),
          connection: document.querySelector('.project-connection-menu')
            ?.textContent?.trim().slice(0, 200),
          missing: [...document.querySelectorAll('.workspace-missing-notice')]
            .map((node) => node.textContent?.trim().slice(0, 120)),
          dialog: document.querySelector('.project-dialog')
            ?.textContent?.trim().slice(0, 240)
        }))()
      `)
    }
  } catch {
    // Preserve the original failure when the renderer is unavailable.
  }
  return {
    renderer,
    project: {
      root: getState().root,
      activeProjectId: getState().activeProjectId,
      activeWorkspaceId: getState().activeWorkspaceId,
      projectIds: getState().projects.map((project) => project.id),
    },
    openedFolderSelections,
  }
}

function rendererWait(
  win: BrowserWindow,
  expression: string,
  message: string,
): Promise<unknown> {
  return rendererValue(win, `(${expression}) ? true : undefined`, message)
}

function rendererValue(
  win: BrowserWindow,
  expression: string,
  message: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const poll = () => {
        try {
          const value = ${expression};
          if (value) return resolve(value);
        } catch (error) {
          return reject(error);
        }
        if (Date.now() > deadline) return reject(new Error(${JSON.stringify(message)}));
        setTimeout(poll, 25);
      };
      poll();
    })
  `) as Promise<unknown>
}
