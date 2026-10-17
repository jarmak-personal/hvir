import { app, type BrowserWindow } from 'electron'
import { hostPathEquals } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { TerminalMoveSmokeHarness } from './terminal-move'

/** Real Sessions launch, transfer, and borrowed-canvas lifecycle over the existing PTY fixture. */
export async function verifySessionsTerminalCommands({
  win,
  supervisor,
  harness,
  emitState,
}: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly harness: TerminalMoveSmokeHarness
  readonly emitState: Parameters<
    typeof import('./terminal-move').verifyTerminalMoveSmoke
  >[0]['emitState']
}): Promise<string> {
  app.focus({ steal: true })
  win.show()
  win.focus()
  win.webContents.focus()
  emitState(harness.introduceTarget())
  const baseline = new Set(supervisor.list().map((pty) => pty.id))
  await rendererStep(
    win,
    `
    await waitFor(() => document.hasFocus(), 'foreground');
    document.querySelector('.sessions-destination').click();
    await waitFor(() => button('New session', document.querySelector('.sessions-project-header')), 'project-header');
    button('New session', document.querySelector('.sessions-project-header')).click();
    await waitFor(() => button('Shell', document.querySelector('.sessions-launch-dialog')), 'shell-choice');
    button('Cancel', document.querySelector('.sessions-launch-dialog')).click();
    await waitFor(() => !document.querySelector('.sessions-launch-dialog'));
  `,
  )
  if (supervisor.list().length !== baseline.size)
    throw new Error('Sessions launch cancellation started a process')
  await rendererStep(
    win,
    `
    button('New session', document.querySelector('.sessions-project-header')).click();
    await waitFor(() => button('Shell', document.querySelector('.sessions-launch-dialog')), 'shell-choice');
    button('Shell', document.querySelector('.sessions-launch-dialog')).click();
    await waitFor(() => document.querySelector('.sessions-detail-terminal.ready .terminal-engine-host canvas'), 'launched-surface');
    window.__hvirSessionsCommandCanvas = document.querySelector('.sessions-detail-terminal canvas');
    if (document.querySelector('.sessions-destination').getAttribute('aria-current') !== 'page') throw new Error('Launch left Sessions');
  `,
  )
  const created = supervisor.list().filter((pty) => !baseline.has(pty.id))
  const session = created[0]
  if (
    created.length !== 1 ||
    !session ||
    !hostPathEquals(session.cwd, harness.sourceRoot) ||
    !hostPathEquals(session.workspaceRoot, harness.sourceRoot)
  )
    throw new Error(
      'Sessions launch did not create exactly one session at the registered root',
    )
  await rendererStep(
    win,
    `
    button('Change workspace', document.querySelector('.sessions-terminal-detail')).click();
    await waitFor(() => button('smoke-move-target', document.querySelector('.sessions-change-workspace')), 'move-choice');
    button('smoke-move-target', document.querySelector('.sessions-change-workspace')).click();
    const dialog = await waitFor(() => document.querySelector('.terminal-move-dialog'), 'move-confirmation');
    if (!dialog.textContent.includes('original launch directory does not change')) throw new Error('Move hid launch-directory continuity');
    button('Cancel', dialog).click();
    await waitFor(() => !document.querySelector('.terminal-move-dialog'));
  `,
  )
  if (!hostPathEquals(supervisor.get(session.id)!.workspaceRoot, harness.sourceRoot))
    throw new Error('Cancelled Sessions move changed workspace')
  await rendererStep(
    win,
    `
    button('Change workspace', document.querySelector('.sessions-terminal-detail')).click();
    await waitFor(() => button('smoke-move-target', document.querySelector('.sessions-change-workspace')), 'move-choice');
    button('smoke-move-target', document.querySelector('.sessions-change-workspace')).click();
    const dialog = await waitFor(() => document.querySelector('.terminal-move-dialog'), 'move-confirmation');
    button('Change workspace', dialog).click();
    await waitFor(() => !document.querySelector('.terminal-move-dialog') && document.querySelector('.sessions-terminal-detail header p')?.textContent.includes('smoke-move-target') && document.querySelector('.sessions-detail-terminal.ready canvas') === window.__hvirSessionsCommandCanvas, 'transferred-surface');
    if (document.querySelector('.sessions-destination').getAttribute('aria-current') !== 'page') throw new Error('Move left Sessions');
    button('Close', document.querySelector('.sessions-terminal-detail')).click();
    await waitFor(() => !document.querySelector('.sessions-terminal-detail'));
    if (window.__hvirSessionsCommandCanvas.closest('.sessions-terminal-detail')) throw new Error('Closed Interact retained its canvas');
    delete window.__hvirSessionsCommandCanvas;
  `,
  )
  const moved = supervisor.get(session.id)
  if (
    !moved ||
    moved.pid !== session.pid ||
    moved.instanceId !== session.instanceId ||
    !hostPathEquals(moved.cwd, harness.sourceRoot) ||
    !hostPathEquals(moved.workspaceRoot, harness.targetRoot) ||
    supervisor.list().length !== baseline.size + 1
  )
    throw new Error(
      'Sessions transfer replaced its process or changed its launch directory',
    )
  return 'Sessions cancellation + one root launch + same PTY/pid/canvas move + current Interact workspace + surface release'
}

async function rendererStep(win: BrowserWindow, action: string): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const button = (label, container = document) => container && [...container.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === label && !candidate.disabled);
    const waitFor = (check, stage) => new Promise((resolve, reject) => {
      let observer;
      let deadline;
      const stop = () => { observer?.disconnect(); clearTimeout(deadline); window.removeEventListener('focus', inspect, true); };
      const inspect = () => { try { const value = check(); if (value) { stop(); resolve(value); } } catch (error) { stop(); reject(error); } };
      observer = new MutationObserver(inspect);
      window.addEventListener('focus', inspect, true);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      deadline = setTimeout(() => {
        stop();
        const boundary = stage === 'transferred-surface' ? {
          dialogAbsent: !document.querySelector('.terminal-move-dialog'),
          workspaceMatches: document.querySelector('.sessions-terminal-detail header p')?.textContent.includes('smoke-move-target') === true,
          readyCanvasPresent: !!document.querySelector('.sessions-detail-terminal.ready canvas'),
          canvasMatches: document.querySelector('.sessions-detail-terminal.ready canvas') === window.__hvirSessionsCommandCanvas,
          sessionsSelected: document.querySelector('.sessions-destination')?.getAttribute('aria-current') === 'page',
          documentFocused: document.hasFocus(),
        } : undefined;
        reject(new Error('Sessions command semantic readiness timed out: ' + stage + (boundary ? ' ' + JSON.stringify(boundary) : '')));
      }, 15000);
      inspect();
    });
    ${action}
  })()`)
}
