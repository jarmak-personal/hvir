import { app, type BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  type HarnessProviderId,
  type HostPath,
  type ProjectState,
  type SessionsObservationSnapshot,
  type TerminalRecoverySession,
} from '../../shared'
import { SessionsProjectionCoordinator } from '../../renderer/src/sessions/sessions-projection-coordinator'
import type { SessionsRendererSession } from '../../renderer/src/sessions/sessions-renderer-observation'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { PtySupervisor } from '../pty/pty-supervisor'

export async function verifySessionsProjectionSmoke(options: {
  readonly win: BrowserWindow
  readonly initialOwner: RendererOwner
  readonly resources: RendererResourceScopes
  readonly replacementReady: Promise<RendererOwner>
  readonly state: ProjectState
  readonly publishState: (state: ProjectState) => void
  readonly providerId: HarnessProviderId
  readonly roots: readonly [HostPath, HostPath, HostPath]
  readonly addRetained: (root: HostPath, session: TerminalRecoverySession) => void
  readonly supervisor: PtySupervisor
}): Promise<string> {
  const {
    win,
    initialOwner,
    resources,
    replacementReady,
    state,
    publishState,
    providerId,
    roots,
    addRetained,
    supervisor,
  } = options
  publishState(state)
  roots.forEach((root, index) =>
    addRetained(root, recovery(`smoke-sessions-${index + 1}`, root, providerId)),
  )

  const initial = (await win.webContents.executeJavaScript(`
    window.__hvirSessionsChangeCount = 0;
    window.__hvirSessionsStop = window.hvir.on('sessions:changed', () => {
      window.__hvirSessionsChangeCount += 1;
    });
    window.hvir.invoke('sessions:observe', { demandGeneration: 1 });
  `)) as unknown
  const initialSnapshot = assertSnapshot(initial, 3)
  assertContentFree(initial, [...roots, state.root])
  await assertRendererJoin(initialSnapshot)

  const reloaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )
  win.webContents.reload()
  const [, replacement] = await Promise.all([reloaded, replacementReady])
  if (
    replacement.id !== initialOwner.id ||
    replacement.generation <= initialOwner.generation ||
    !resources.isCurrent(replacement)
  ) {
    throw new Error('Sessions projection renderer generation did not roll forward')
  }

  const staleDemand = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('sessions:snapshot', { demandGeneration: 1 }).then(
      () => 'accepted',
      () => 'rejected'
    );
  `)) as string
  if (staleDemand !== 'rejected') {
    throw new Error('Sessions projection retained a stale renderer demand')
  }

  addRetained(roots[0], recovery('smoke-sessions-after-rollover', roots[0], providerId))
  const reopened = (await win.webContents.executeJavaScript(`
    window.__hvirSessionsChangeCount = 0;
    window.__hvirSessionsStop = window.hvir.on('sessions:changed', () => {
      window.__hvirSessionsChangeCount += 1;
    });
    window.hvir.invoke('sessions:observe', { demandGeneration: 2 });
  `)) as unknown
  const reopenedSnapshot = assertSnapshot(reopened, 4)
  assertContentFree(reopened, [...roots, state.root])
  const staleSession = reopenedSnapshot.sessions[0]
  const staleWorkspace = reopenedSnapshot.workspaces.find(
    (workspace) => workspace.workspaceId === staleSession?.workspaceId,
  )
  if (!staleSession || !staleWorkspace) {
    throw new Error('Sessions projection smoke lacked a stale Open fixture')
  }
  const staleOpen = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('sessions:open', ${JSON.stringify({
      demandGeneration: 2,
      sourceRevision: reopenedSnapshot.revision - 1,
      handle: staleSession.handle,
      projectId: staleWorkspace.projectId,
      workspaceId: staleWorkspace.workspaceId,
      workspaceQualifier: staleWorkspace.qualifier,
    })});
  `)) as { outcome: string; reason?: string }
  if (staleOpen.outcome !== 'unavailable' || staleOpen.reason !== 'stale-projection') {
    throw new Error('Sessions projection accepted a stale exact Open request')
  }

  await win.webContents.executeJavaScript(
    `window.hvir.invoke('sessions:release', { demandGeneration: 2 })`,
  )
  addRetained(roots[1], recovery('smoke-sessions-after-release', roots[1], providerId))
  const quiet = (await win.webContents.executeJavaScript(`
    Promise.all([
      Promise.resolve(window.__hvirSessionsChangeCount),
      window.hvir.invoke('sessions:snapshot', { demandGeneration: 2 }).then(
        () => 'accepted',
        () => 'rejected'
      )
    ]).then(([changes, stale]) => {
      window.__hvirSessionsStop?.();
      delete window.__hvirSessionsStop;
      delete window.__hvirSessionsChangeCount;
      return { changes, stale };
    });
  `)) as { changes: number; stale: string }
  if (quiet.changes !== 0 || quiet.stale !== 'rejected') {
    throw new Error('Sessions projection continued work after its last consumer released')
  }

  const terminalStatus = await ensureSessionsLiveTerminal(win, supervisor)
  app.focus({ steal: true })
  win.show()
  win.focus()
  win.webContents.focus()
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        if (document.hasFocus()) return resolve(true);
        if (Date.now() > deadline) return reject(new Error('Sessions smoke window did not focus'));
        setTimeout(poll, 25);
      };
      poll();
    });
  `)
  const overviewStatus = await verifySessionsOverview(win, [...roots, state.root])
  const releasedAfterReturn = (await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const poll = () => {
        window.hvir.invoke('sessions:snapshot', { demandGeneration: 1 }).then(
          () => setTimeout(poll, 25),
          () => resolve('released')
        );
      };
      poll();
    });
  `)) as string
  if (releasedAfterReturn !== 'released') {
    throw new Error('Sessions overview retained observation demand after Open returned')
  }
  const pickerStatus = await verifySessionsProjectPickerReturn(win)
  const hiddenStatus = await verifySessionsHiddenRelease(win)
  return `cross-project/worktree + disconnected SSH + renderer rollover + stale Open + quiet release + ${terminalStatus} + ${overviewStatus} + ${pickerStatus} + ${hiddenStatus}`
}

async function verifySessionsProjectPickerReturn(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const wait = (next, stage) => {
        if (Date.now() <= deadline) return setTimeout(next, 25);
        reject(new Error('Sessions project-picker return timed out at ' + stage));
      };
      const button = (label, root = document) => [...root.querySelectorAll('button')]
        .find((candidate) =>
          candidate.getAttribute('aria-label') === label ||
          candidate.textContent?.trim() === label
        );
      document.querySelector('.sessions-destination')?.click();
      const openPicker = () => {
        if (!document.querySelector('.sessions-overview')) return wait(openPicker, 'overview');
        const register = button('Register project');
        if (!(register instanceof HTMLButtonElement) || register.disabled) {
          return wait(openPicker, 'register control');
        }
        register.click();
        const chooseHost = () => {
          const dialog = document.querySelector('.session-dialog');
          const choose = dialog ? button('Choose folder', dialog) : undefined;
          if (!(choose instanceof HTMLButtonElement) || choose.disabled) {
            return wait(chooseHost, 'host choice');
          }
          choose.click();
          const useFolder = () => {
            const currentDialog = document.querySelector('.session-dialog');
            const use = currentDialog ? button('Use this folder', currentDialog) : undefined;
            if (!(use instanceof HTMLButtonElement) || use.disabled) {
              return wait(useFolder, 'folder readiness');
            }
            use.click();
            const returned = () => {
              const workbench = document.querySelector('.workbench');
              if (
                document.querySelector('.session-dialog') ||
                document.querySelector('.sessions-overview') ||
                !(workbench instanceof HTMLElement) ||
                workbench.hidden
              ) {
                return wait(returned, 'workspace return');
              }
              resolve('successful project open returns to workspace');
            };
            returned();
          };
          useFolder();
        };
        chooseHost();
      };
      openPicker();
    });
  `)) as string
}

async function verifySessionsHiddenRelease(win: BrowserWindow): Promise<string> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      document.querySelector('.sessions-destination')?.click();
      const poll = () => {
        if (document.querySelectorAll('.sessions-overview .session-card').length > 0) {
          return resolve(true);
        }
        if (Date.now() > deadline) return reject(new Error('Sessions hidden-release check lacked overview'));
        setTimeout(poll, 25);
      };
      poll();
    });
  `)
  win.hide()
  const released = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        if (document.visibilityState === 'hidden' || !document.hasFocus()) {
          return window.hvir.invoke('sessions:snapshot', { demandGeneration: 1 }).then(
            () => reject(new Error('hidden Sessions retained demand')),
            () => resolve('released')
          );
        }
        if (Date.now() > deadline) return reject(new Error('Sessions did not become hidden or unfocused'));
        setTimeout(poll, 25);
      };
      poll();
    });
  `)) as string
  return `re-enter + window hide ${released}`
}

async function ensureSessionsLiveTerminal(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const status = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      let menuOpened = false;
      const deadline = Date.now() + 15_000;
      const poll = () => {
        const live = [...document.querySelectorAll('.terminal-surface')].find((surface) =>
          (surface.getAttribute('data-terminal-status') || '').startsWith('pid ')
        );
        if (live) return resolve(live.getAttribute('data-terminal-status'));
        if (Date.now() > deadline) {
          return reject(new Error('Sessions live terminal timed out: ' + JSON.stringify({
            rows: document.querySelectorAll('.terminal-list-row').length,
            surfaces: document.querySelectorAll('.terminal-surface').length,
            menu: Boolean(document.querySelector('.terminal-new-menu')),
            add: Boolean(document.querySelector('button[aria-label="New terminal"]'))
          })));
        }
        const failure = document.querySelector('.terminal-recovery-status')?.textContent?.trim();
        const add = document.querySelector('button[aria-label="New terminal"]');
        if (!menuOpened && add instanceof HTMLButtonElement && !add.disabled) {
          add.click();
          menuOpened = true;
        }
        const shell = [...document.querySelectorAll('.terminal-new-menu button')]
          .find((button) => button.querySelector('strong')?.textContent?.trim() === 'Shell');
        if (menuOpened && shell instanceof HTMLButtonElement) {
          shell.click();
          menuOpened = false;
        } else if (failure && !document.querySelector('.terminal-new-menu')) {
          return reject(new Error('Sessions live terminal failed: ' + failure));
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  `)) as string
  if (supervisor.list().length < 1 || !status.startsWith('pid ')) {
    throw new Error(`Sessions overview lacked one supervised live PTY (${status})`)
  }
  return `live PTY ${status}`
}

async function verifySessionsOverview(
  win: BrowserWindow,
  privateRoots: readonly HostPath[],
): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const wait = (next, stage) => {
        if (Date.now() <= deadline) return setTimeout(next, 25);
        const overview = document.querySelector('.sessions-overview');
        reject(new Error('Sessions overview timed out at ' + stage + ': ' + JSON.stringify({
          overview: Boolean(overview),
          cards: overview?.querySelectorAll('.session-card').length ?? 0,
          notice: overview?.querySelector('.sessions-notice')?.textContent?.trim(),
          feedback: overview?.querySelector('.sessions-feedback')?.textContent?.trim(),
          focused: document.hasFocus(),
          destination: document.querySelector('.sessions-destination')?.getAttribute('aria-current')
        })));
      };
      const privatePaths = ${JSON.stringify(privateRoots.map((root) => root.path))};
      const button = (text, root = document) => [...root.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === text);
      const fact = (card, label) => [...card.querySelectorAll('dt')]
        .find((term) => term.textContent?.trim() === label)?.nextElementSibling
        ?.textContent?.trim();
      const destination = document.querySelector('.sessions-destination');
      if (!(destination instanceof HTMLButtonElement)) {
        return reject(new Error('permanent Sessions destination missing'));
      }
      destination.click();
      const ready = () => {
        const overview = document.querySelector('.sessions-overview');
        const cards = overview ? [...overview.querySelectorAll('.session-card')] : [];
        if (!overview || cards.length < 5) return wait(ready, 'overview readiness');
        try {
          const text = overview.textContent || '';
          const workbench = document.querySelector('.workbench');
          if (!(workbench instanceof HTMLElement) || !workbench.hidden) {
            throw new Error('Sessions did not replace the workbench as a full-page view');
          }
          if (destination.getAttribute('aria-current') !== 'page') {
            throw new Error('Sessions destination did not expose current navigation state');
          }
          if (
            !text.includes('Primary project') ||
            !text.includes('Secondary project') ||
            !text.includes('Disconnected project')
          ) {
            throw new Error('Sessions overview omitted cross-project or disconnected rows');
          }
          if (
            privatePaths.some((path) => overview.innerHTML.includes(path)) ||
            overview.innerHTML.includes('workspace:') ||
            overview.innerHTML.includes('sessions-workspace-')
          ) {
            throw new Error('Sessions overview rendered a private path or opaque handle');
          }
          if (overview.querySelector('.terminal-surface')) {
            throw new Error('Sessions cards materialized a preview terminal');
          }
          const harnessRail = [...document.querySelectorAll('.rail-nav button')]
            .some((candidate) => candidate.textContent?.trim() === 'Harness');
          if (harnessRail) throw new Error('legacy Harness rail placeholder remained');

          const interact = () => {
            const currentCards = [...overview.querySelectorAll('.session-card')];
            const retained = currentCards.find((card) =>
              fact(card, 'Lifecycle') === 'Retained' &&
              fact(card, 'Host')?.split(' · ').at(-1) === 'Connected'
            );
            if (!(retained instanceof HTMLElement)) {
              return reject(new Error('Sessions overview lacked a retained session row'));
            }
            button('Open', retained)?.click();
            const refused = () => {
              const feedback = overview.querySelector('.sessions-feedback')?.textContent || '';
              if (!feedback.includes('does not have the same live terminal')) {
                return wait(refused, 'retained Open refusal');
              }
              button('Harnesses', overview)?.click();
              const filtered = () => {
                if (!overview.textContent?.includes('No sessions match')) {
                  return wait(filtered, 'Harnesses filter');
                }
                button('Reset filters', overview)?.click();
                const openLive = () => {
                  const filteredCards = [...overview.querySelectorAll('.session-card')];
                  const live = filteredCards.find((card) => fact(card, 'Lifecycle') === 'Live');
                  if (!(live instanceof HTMLElement)) return wait(openLive, 'live card');
                  button('Open', live)?.click();
                  const focused = () => {
                    if (document.querySelector('.sessions-overview')) {
                      return wait(focused, 'Open navigation');
                    }
                    const active = document.querySelector('.terminal-surface.active');
                    const engine = active?.querySelector('.terminal-engine-host');
                    if (
                      !(active instanceof HTMLElement) ||
                      !(engine instanceof HTMLElement) ||
                      !((active.getAttribute('data-terminal-status') || '').startsWith('pid ')) ||
                      !(document.activeElement === engine || engine.contains(document.activeElement))
                    ) {
                      return wait(focused, 'exact terminal focus');
                    }
                    resolve('full-page overview + filters + retained refusal + exact live Open/focus');
                  };
                  focused();
                };
                openLive();
              };
              filtered();
            };
            refused();
          };
          interact();
        } catch (error) {
          reject(error);
        }
      };
      ready();
    });
  `)) as string
}

function recovery(
  id: string,
  root: HostPath,
  providerId: HarnessProviderId,
): TerminalRecoverySession {
  return {
    id,
    providerId,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    hostId: root.hostId,
    cwd: root,
    title: 'Retained smoke session',
    position: 0,
    active: true,
    updatedAt: Date.now(),
  }
}

function assertSnapshot(
  value: unknown,
  expectedRows: number,
): SessionsObservationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sessions projection preload returned no snapshot')
  }
  const snapshot = value as Record<string, unknown>
  const keys = Object.keys(snapshot).sort()
  const expectedKeys = [
    'demandGeneration',
    'providers',
    'revision',
    'sessions',
    'version',
    'workspaces',
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Sessions projection returned unexpected IPC keys: ${keys.join(', ')}`,
    )
  }
  if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length !== expectedRows) {
    throw new Error(
      `Sessions projection expected ${expectedRows} sessions, received ${Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0}`,
    )
  }
  if (!Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.providers)) {
    throw new Error('Sessions projection omitted production workspace/provider catalogs')
  }
  for (const workspace of snapshot.workspaces as Array<Record<string, unknown>>) {
    if (
      typeof workspace.projectId !== 'string' ||
      !workspace.projectId.startsWith('sessions-project-') ||
      typeof workspace.workspaceId !== 'string' ||
      !workspace.workspaceId.startsWith('sessions-workspace-') ||
      typeof workspace.qualifier !== 'string'
    ) {
      throw new Error('Sessions projection returned a non-opaque workspace identity')
    }
  }
  return value as SessionsObservationSnapshot
}

async function assertRendererJoin(snapshot: SessionsObservationSnapshot): Promise<void> {
  const observed = snapshot.sessions[0]
  const workspace = snapshot.workspaces.find(
    (candidate) => candidate.workspaceId === observed?.workspaceId,
  )
  if (!observed || !workspace || observed.profile.status !== 'available') {
    throw new Error('Sessions projection smoke lacked one joinable retained session')
  }
  const rendererSession: SessionsRendererSession = {
    handle: observed.handle,
    workspaceQualifier: workspace.qualifier,
    providerId: observed.providerId,
    profileId: observed.profile.value.id,
    title: 'Renderer joined smoke session',
    dormant: false,
    resumeOnStart: false,
    exited: false,
    recoveryUnavailable: false,
    attention: 'bell',
  }
  let released = false
  const coordinator = new SessionsProjectionCoordinator(
    {
      observe: (demandGeneration) => Promise.resolve({ ...snapshot, demandGeneration }),
      snapshot: (demandGeneration) => Promise.resolve({ ...snapshot, demandGeneration }),
      release: () => {
        released = true
        return Promise.resolve()
      },
      subscribe: () => () => undefined,
    },
    {
      snapshot: () => [rendererSession],
      subscribe: () => () => undefined,
    },
  )
  const release = coordinator.acquire()
  await Promise.resolve()
  await Promise.resolve()
  const joined = coordinator.snapshot()
  const row = joined.rows.find((candidate) => candidate.handle === observed.handle)
  if (
    joined.status !== 'available' ||
    row?.title !== rendererSession.title ||
    row.attention.status !== 'available' ||
    row.attention.value !== 'bell' ||
    row.workspace.id !== workspace.workspaceId
  ) {
    throw new Error('Sessions projection coordinator did not join the renderer row')
  }
  release()
  await Promise.resolve()
  coordinator.dispose()
  if (!released) throw new Error('Sessions projection coordinator did not release demand')
}

function assertContentFree(value: unknown, roots: readonly HostPath[]): void {
  const serialized = JSON.stringify(value)
  if (
    roots.some((root) => serialized.includes(root.path)) ||
    serialized.includes('costUsd') ||
    serialized.includes('harnessSessionId')
  ) {
    throw new Error('Sessions projection crossed a private path, identity, or cost field')
  }
}
