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
  win.show()
  const focusDeadline = Date.now() + 5_000
  while (!((await win.webContents.executeJavaScript(`document.hasFocus()`)) as boolean)) {
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    if (Date.now() > focusDeadline) {
      throw new Error('Sessions detail smoke window did not regain focus')
    }
    await delay(25)
  }
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
  const overviewStatus = await verifySessionsOverview(
    win,
    [...roots, state.root],
    supervisor,
  )
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
  const hiddenTerminalStatus = await ensureSessionsLiveTerminal(win, supervisor)
  const hiddenStatus = await verifySessionsHiddenRelease(win)
  return `cross-project/worktree + disconnected SSH + renderer rollover + stale Open + quiet release + ${terminalStatus} + ${overviewStatus} + ${pickerStatus} + hidden ${hiddenTerminalStatus} + ${hiddenStatus}`
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
      const workspaceSurface = [...document.querySelectorAll('.workbench .terminal-surface')]
        .find((surface) =>
          surface.querySelector('.terminal-engine-host') &&
          (surface.getAttribute('data-terminal-status') || '').startsWith('pid ')
        );
      const title = workspaceSurface?.getAttribute('aria-label');
      if (!title) return reject(new Error('Sessions hidden-release check lacked a live terminal'));
      document.querySelector('.sessions-destination')?.click();
      const poll = () => {
        const overview = document.querySelector('.sessions-overview');
        const card = overview
          ? [...overview.querySelectorAll('.session-card')]
            .find((candidate) => candidate.querySelector('h3')?.textContent?.trim() === title)
          : undefined;
        const interact = card
          ? [...card.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Interact')
          : undefined;
        if (interact instanceof HTMLButtonElement) {
          interact.click();
          return detail();
        }
        if (Date.now() > deadline) return reject(new Error('Sessions hidden-release check lacked overview'));
        setTimeout(poll, 25);
      };
      const detail = () => {
        const input = document.querySelector('.sessions-detail-terminal-container');
        if (
          input?.querySelector('.terminal-engine-host') &&
          input.__hvirTerminalDelivery?.presentation === 'visible'
        ) {
          return resolve(true);
        }
        if (Date.now() > deadline) {
          return reject(new Error('Sessions hidden-release check lacked exact detail'));
        }
        setTimeout(detail, 25);
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
          const detail = document.querySelector('.sessions-terminal-detail');
          const input = detail?.querySelector('.sessions-detail-terminal-container');
          if (
            !(detail instanceof HTMLElement) ||
            input?.querySelector('.terminal-engine-host') ||
            input?.__hvirTerminalDelivery?.presentation !== 'hidden'
          ) {
            if (Date.now() > deadline) {
              return reject(new Error('hidden Sessions retained a presented detail surface'));
            }
            return setTimeout(poll, 25);
          }
          return window.hvir.invoke('sessions:snapshot', { demandGeneration: 1 }).then(
            () => reject(new Error('hidden Sessions retained demand')),
            () => resolve('detail surface and demand released')
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
  supervisor: PtySupervisor,
): Promise<string> {
  const verification = win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const wait = (next, stage) => {
        if (Date.now() <= deadline) return setTimeout(next, 25);
        const overview = document.querySelector('.sessions-overview');
        const detail = document.querySelector('.sessions-terminal-detail');
        const detailInput = detail?.querySelector('.sessions-detail-terminal-container');
        reject(new Error('Sessions overview timed out at ' + stage + ': ' + JSON.stringify({
          overview: Boolean(overview),
          detail: detail?.textContent?.trim(),
          detailEngines: detail?.querySelectorAll('.terminal-engine-host').length ?? 0,
          globalEngines: document.querySelectorAll('.terminal-engine-host').length,
          detailPresentation: detailInput?.__hvirTerminalDelivery?.presentation,
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
                const enterDetail = () => {
                  const currentOverview = document.querySelector('.sessions-overview');
                  const filteredCards = currentOverview
                    ? [...currentOverview.querySelectorAll('.session-card')]
                    : [];
                  const live = filteredCards.find((card) =>
                    fact(card, 'Lifecycle') === 'Live' && button('Interact', card)
                  );
                  if (!(live instanceof HTMLElement)) return wait(enterDetail, 'live card');
                  const liveTitle = live.querySelector('h3')?.textContent?.trim();
                  const workspaceSurface = [...document.querySelectorAll('.workbench .terminal-surface')]
                    .find((surface) =>
                      surface.getAttribute('aria-label') === liveTitle &&
                      surface.querySelector('.terminal-engine-host')
                    );
                  const workspaceInput = workspaceSurface?.querySelector('.terminal-container');
                  const workspaceEngine = workspaceInput?.querySelector('.terminal-engine-host');
                  const engineCount = document.querySelectorAll('.terminal-engine-host').length;
                  if (
                    !(workspaceInput instanceof HTMLElement) ||
                    !(workspaceEngine instanceof HTMLElement)
                  ) {
                    return reject(new Error('live card lacked its exact workspace terminal surface'));
                  }
                  const sessionId = workspaceSurface?.getAttribute('data-terminal-session');
                  if (!sessionId) {
                    return reject(new Error('live terminal surface lacked its existing session identity'));
                  }
                  button('Interact', live)?.click();
                  const attached = () => {
                    const detail = document.querySelector('.sessions-terminal-detail');
                    const input = detail?.querySelector('.sessions-detail-terminal-container');
                    const engine = input?.querySelector('.terminal-engine-host');
                    const delivery = input?.__hvirTerminalDelivery;
                    const performance = engine?.__hvirTerminalPerformance;
                    if (
                      !(detail instanceof HTMLElement) ||
                      !(input instanceof HTMLElement) ||
                      !(engine instanceof HTMLElement) ||
                      engine !== workspaceEngine ||
                      document.querySelectorAll('.terminal-engine-host').length !== engineCount ||
                      delivery?.presentation !== 'visible' ||
                      performance?.paused ||
                      !(document.activeElement === engine || engine.contains(document.activeElement))
                    ) {
                      return wait(attached, 'exact detail attachment');
                    }
                    window.__hvirSessionsDetailProbe = { sessionId };
                    const proof = () => {
                      if (window.__hvirSessionsDetailProbeFailure) {
                        return reject(new Error(window.__hvirSessionsDetailProbeFailure));
                      }
                      if (!window.__hvirSessionsDetailProbeComplete) {
                        return wait(proof, 'exact detail input and resize proof');
                      }
                      delete window.__hvirSessionsDetailProbe;
                      delete window.__hvirSessionsDetailProbeComplete;
                      delete window.__hvirSessionsDetailProbeFailure;
                      button('Back to Sessions', detail)?.click();
                      restored();
                    };
                    const restored = () => {
                      const returnedOverview = document.querySelector('.sessions-overview');
                      const restoredEngine = workspaceInput.querySelector('.terminal-engine-host');
                      if (
                        !(returnedOverview instanceof HTMLElement) ||
                        restoredEngine !== workspaceEngine ||
                        workspaceInput.__hvirTerminalDelivery?.presentation !== 'hidden' ||
                        !restoredEngine.__hvirTerminalPerformance?.paused ||
                        document.querySelectorAll('.terminal-engine-host').length !== engineCount
                      ) {
                        return wait(restored, 'workspace surface restoration');
                      }
                      const currentLive = [...returnedOverview.querySelectorAll('.session-card')]
                        .find((card) => fact(card, 'Lifecycle') === 'Live');
                      if (!(currentLive instanceof HTMLElement)) {
                        return wait(restored, 'restored live card');
                      }
                      button('Open', currentLive)?.click();
                      focused();
                    };
                    proof();
                  };
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
                    resolve('full-page overview + bounded accessible Usage lifecycle + filters + retained refusal + one exact interactive detail/input/restore + exact live Open/focus');
                  };
                  attached();
                };
                enterDetail();
              };
              filtered();
            };
            refused();
          };
          const verifyUsage = () => {
            button('Usage', overview)?.click();
            const usageReady = () => {
              const ranking = overview.querySelector('.sessions-usage-ranking');
              const rows = ranking ? [...ranking.querySelectorAll(':scope > li')] : [];
              if (!ranking || rows.length < 5) return wait(usageReady, 'Usage ranking readiness');
              const usageText = overview.textContent || '';
              if (
                !usageText.includes('Recent') ||
                !usageText.includes('Session total') ||
                !usageText.includes('Token categories') ||
                rows.length > 40 ||
                privatePaths.some((path) => overview.innerHTML.includes(path)) ||
                overview.querySelector('.terminal-surface')
              ) {
                return reject(new Error('Sessions Usage production shape was unsafe or unbounded'));
              }
              button('Session total', overview)?.click();
              button('Recent', overview)?.click();
              button('1 minute', overview)?.click();
              button('Overview', overview)?.click();
              const released = () => {
                if (!overview.querySelector('.session-card')) {
                  return wait(released, 'Overview return after Usage');
                }
                window.hvir.invoke('sessions:usage-snapshot', { demandGeneration: 1 }).then(
                  () => reject(new Error('Usage demand remained active after leaving its lens')),
                  () => interact()
                );
              };
              released();
            };
            usageReady();
          };
          verifyUsage();
        } catch (error) {
          reject(error);
        }
      };
      ready();
    });
  `) as Promise<string>
  try {
    const sessionId = await Promise.race([
      waitForSessionsDetailProbe(win),
      verification.then(() => {
        throw new Error('Sessions overview completed before its detail proof target was exposed')
      }),
    ])
    const proof = await verifySessionsDetailInputAndResize(win, supervisor, sessionId)
    await win.webContents.executeJavaScript(
      `window.__hvirSessionsDetailProbeComplete = true`,
    )
    return `${await verification} + ${proof}`
  } catch (error) {
    await win.webContents
      .executeJavaScript(
        `window.__hvirSessionsDetailProbeFailure = 'Sessions detail production proof failed'`,
      )
      .catch(() => undefined)
    await verification.catch(() => undefined)
    throw error
  }
}

async function waitForSessionsDetailProbe(win: BrowserWindow): Promise<string> {
  // Let the renderer-owned staged proof report its exact bounded failure before
  // this cross-process guard supplies a last-resort missing-probe diagnostic.
  const deadline = Date.now() + 25_000
  while (Date.now() <= deadline) {
    const sessionId = (await win.webContents.executeJavaScript(
      `window.__hvirSessionsDetailProbe?.sessionId`,
    )) as string | undefined
    if (sessionId) return sessionId
    await delay(25)
  }
  throw new Error('Sessions detail did not expose its smoke-only production proof target')
}

async function verifySessionsDetailInputAndResize(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  sessionId: string,
): Promise<string> {
  const terminal = supervisor.get(sessionId)
  if (!terminal) throw new Error('Sessions detail proof target no longer had a live PTY')
  let output = ''
  let exited = false
  const detach = supervisor.attach(
    terminal.id,
    terminal.ownerId,
    {
      onData: (data) => {
        output = (output + data).slice(-32_768)
      },
      onExit: () => {
        exited = true
      },
    },
    terminal.ownerGeneration,
  )
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `printf '\\r\\nsessions-detail-size-a:'; stty size\n`,
      terminal.ownerGeneration,
    )
    const initial = await waitForTerminalSize(
      () => output,
      () => exited,
      'sessions-detail-size-a',
    )
    await win.webContents.executeJavaScript(`
      (() => {
        const detail = document.querySelector('.sessions-detail-terminal');
        if (!(detail instanceof HTMLElement)) throw new Error('Sessions detail disappeared');
        detail.style.width = '430px';
        detail.style.height = '280px';
        detail.style.justifySelf = 'start';
      })()
    `)
    await delay(250)
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `printf '\\r\\nsessions-detail-size-b:'; stty size; stty -echo; printf '\\r\\nsessions-detail-input-awaiting\\r\\n'; IFS= read -r hvir_input; stty echo; printf '\\r\\nsessions-detail-input:%s\\r\\n' "$hvir_input"\n`,
      terminal.ownerGeneration,
    )
    const resized = await waitForTerminalSize(
      () => output,
      () => exited,
      'sessions-detail-size-b',
    )
    if (initial.rows === resized.rows && initial.cols === resized.cols) {
      throw new Error(
        `Sessions detail resize did not reach the exact PTY (${initial.rows}x${initial.cols})`,
      )
    }
    await waitForTerminalOutput(
      () => output.includes('sessions-detail-input-awaiting'),
      () => exited,
      'Sessions detail PTY did not become input-ready',
    )
    for (const keyCode of ['H', 'V', 'I', 'R']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitForTerminalOutput(
      () => output.includes('sessions-detail-input:hvir'),
      () => exited,
      'Sessions detail input did not reach the exact PTY',
    )
    return `trusted input + exact PTY resize ${initial.rows}x${initial.cols}→${resized.rows}x${resized.cols}`
  } finally {
    void detach()
  }
}

async function waitForTerminalSize(
  output: () => string,
  exited: () => boolean,
  marker: string,
): Promise<{ readonly rows: number; readonly cols: number }> {
  let match: RegExpMatchArray | null = null
  await waitForTerminalOutput(
    () => {
      match = output().match(new RegExp(`${marker}:(\\d+)\\s+(\\d+)`))
      return match !== null
    },
    exited,
    `Sessions detail PTY omitted ${marker}`,
  )
  return { rows: Number(match![1]), cols: Number(match![2]) }
}

async function waitForTerminalOutput(
  ready: () => boolean,
  exited: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ready()) {
    if (exited()) throw new Error(`${message}; PTY exited`)
    if (Date.now() > deadline) throw new Error(message)
    await delay(25)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
