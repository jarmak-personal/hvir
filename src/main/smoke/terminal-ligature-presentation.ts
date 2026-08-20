import { clipboard, type BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

const SHAPING_LINE = 'ffi -> !== === <= >='

/** Prove bounded shaping, cell selection, and live retained-pane updates in Chromium. */
export async function verifyTerminalLigaturePresentation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('ligature presentation check has no retained terminal')
  const originalInstanceId = terminal.instanceId

  clipboard.clear()
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `printf '\\033[2J\\033[H${SHAPING_LINE}\\n\\033[4;12H'; sleep 40\n`,
  )

  const presentation = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const expectedLine = ${JSON.stringify(SHAPING_LINE)};
        const fail = (message) => reject(new Error(message));
        const poll = () => {
          const surface = document.querySelector('.terminal-surface.active');
          const engine = surface?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const stats = engine?.__hvirTerminalPerformance;
          const cursor = engine?.__hvirTerminalCursor?.effective;
          if (
            engine instanceof HTMLElement &&
            canvas instanceof HTMLCanvasElement &&
            stats?.fontLigatures === true &&
            stats.lastFrame?.shapedRuns > 0 &&
            stats.lastFrame.shapedCells >= 2 &&
            stats.lastFrame.maxRunCells >= 2 &&
            stats.lastFrame.maxRunCells <= stats.cols &&
            cursor?.viewportX === 11 &&
            cursor?.viewportY === 3 &&
            document.fonts.check(stats.fontSize + 'px ' + stats.fontFamily)
          ) {
            canvas.__hvirLigatureCanvasIdentity = Object.freeze({});
            window.__hvirLigaturePresentation = {
              engine,
              canvas,
              cols: stats.cols,
              rows: stats.rows,
              fontFamily: stats.fontFamily,
              shapedRuns: stats.lastFrame.shapedRuns,
              shapedCells: stats.lastFrame.shapedCells,
              maxRunCells: stats.lastFrame.maxRunCells,
              cursor: {
                viewportX: cursor.viewportX,
                viewportY: cursor.viewportY,
                style: cursor.style
              }
            };

            const rect = canvas.getBoundingClientRect();
            const metrics = {
              width: rect.width / stats.cols,
              height: rect.height / stats.rows
            };
            const start = {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: 1,
              clientX: rect.left + metrics.width / 2,
              clientY: rect.top + metrics.height / 2
            };
            const end = {
              ...start,
              clientX: rect.left + metrics.width * (expectedLine.length - 0.5)
            };
            canvas.dispatchEvent(new MouseEvent('mousedown', start));
            canvas.dispatchEvent(new MouseEvent('mousemove', end));
            document.dispatchEvent(new MouseEvent('mouseup', { ...end, buttons: 0 }));
            engine.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ContextMenu',
              code: 'ContextMenu',
              bubbles: true,
              cancelable: true
            }));
            return waitForCopy();
          }

          setTimeout(poll, 20);
        };
        const waitForCopy = () => {
          const copy = [...document.querySelectorAll(
            '.terminal-context-menu [role="menuitem"]'
          )].find((entry) => entry.textContent?.trim() === 'Copy Selection');
          if (copy instanceof HTMLButtonElement && !copy.disabled) {
            copy.click();
            const retained = window.__hvirLigaturePresentation;
            return resolve({
              fontFamily: retained.fontFamily,
              shapedRuns: retained.shapedRuns,
              shapedCells: retained.shapedCells,
              maxRunCells: retained.maxRunCells
            });
          }

          setTimeout(waitForCopy, 20);
        };
        poll();
      })
    `)) as {
    readonly fontFamily: string
    readonly shapedRuns: number
    readonly shapedCells: number
    readonly maxRunCells: number
  }

  await waitForClipboard(SHAPING_LINE)
  await applyLigatureSetting(win, false)
  assertRetainedPty(supervisor, win, terminal.id, originalInstanceId)
  await applyLigatureSetting(win, true)
  assertRetainedPty(supervisor, win, terminal.id, originalInstanceId)
  supervisor.write(terminal.id, terminal.ownerId, '\u0003')

  return (
    `ligatures on/off · exact ${SHAPING_LINE.length}-cell pointer copy · ` +
    `${presentation.shapedRuns} shaped runs/${presentation.shapedCells} cells ` +
    `(max ${presentation.maxRunCells}) · ${presentation.fontFamily} · retained Canvas/PTY`
  )
}

async function applyLigatureSetting(win: BrowserWindow, enabled: boolean): Promise<void> {
  await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const enabled = ${JSON.stringify(enabled)};
        const fail = (message) => reject(new Error(message));
        const retained = window.__hvirLigaturePresentation;
        if (!retained) return fail('ligature retained presentation missing');
        const settings = document.querySelector('.settings-toggle');
        if (!(settings instanceof HTMLButtonElement)) {
          return fail('ligature settings button missing');
        }
        settings.click();
        const openTerminal = () => {
          const terminal = [...document.querySelectorAll('.settings-section-index button')]
            .find((button) => button.textContent?.trim() === 'Terminal');
          if (terminal instanceof HTMLButtonElement) {
            terminal.click();
            return edit();
          }

          setTimeout(openTerminal, 20);
        };
        const edit = () => {
          const control = document.querySelector('#settings-terminal-ligatures');
          const save = [...document.querySelectorAll('.settings-dialog button')]
            .find((button) => button.textContent?.trim() === 'Save app settings');
          if (
            control instanceof HTMLInputElement &&
            save instanceof HTMLButtonElement
          ) {
            if (control.checked !== enabled) control.click();
            save.click();
            return waitForApplied();
          }

          setTimeout(edit, 20);
        };
        const waitForApplied = () => {
          const stored = JSON.parse(localStorage.getItem('hvir:settings:v1') || 'null');
          const stats = retained.engine.__hvirTerminalPerformance;
          const cursor = retained.engine.__hvirTerminalCursor?.effective;
          const frameMatches = enabled
            ? stats?.lastFrame?.shapedRuns > 0 && stats.lastFrame.shapedCells >= 2
            : stats?.lastFrame?.shapedRuns === 0 && stats.lastFrame.shapedCells === 0;
          if (
            !document.querySelector('.settings-dialog') &&
            stored?.terminalLigatures === enabled &&
            stats?.fontLigatures === enabled &&
            frameMatches &&
            stats.cols === retained.cols &&
            stats.rows === retained.rows &&
            cursor?.viewportX === retained.cursor.viewportX &&
            cursor?.viewportY === retained.cursor.viewportY &&
            cursor?.style === retained.cursor.style &&
            retained.engine.isConnected &&
            retained.engine.querySelector('canvas') === retained.canvas &&
            retained.canvas.__hvirLigatureCanvasIdentity
          ) return resolve(undefined);

          setTimeout(waitForApplied, 20);
        };
        openTerminal();
      })
    `)
}

async function waitForClipboard(expected: string): Promise<void> {
  for (;;) {
    if (clipboard.readText() === expected) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

function assertRetainedPty(
  supervisor: PtySupervisor,
  win: BrowserWindow,
  id: string,
  instanceId: string,
): void {
  const retained = supervisor
    .list()
    .filter((candidate) => candidate.ownerId === win.webContents.id)
  if (
    retained.length !== 1 ||
    retained[0]?.id !== id ||
    retained[0]?.instanceId !== instanceId
  ) {
    throw new Error('ligature settings replaced or restarted the retained PTY')
  }
}
