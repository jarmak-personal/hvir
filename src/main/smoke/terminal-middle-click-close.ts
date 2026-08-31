import { clipboard, type BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

const SELECTION_TEXT = '__HVIR_PRIMARY_SELECTION_INPUT__'
const READY_MARKER = '__HVIR_MIDDLE_CLICK_READY__'
const PASTE_MARKER = '__HVIR_MIDDLE_CLICK_PASTE_OK__'
const GUARDED_MARKER = '__HVIR_MIDDLE_CLICK_GUARD_OK__'
const GUARD_COMPLETE_INPUT = '__HVIR_MIDDLE_CLICK_GUARD_COMPLETE__'
const FAILURE_MARKER = '__HVIR_MIDDLE_CLICK_FAIL__'
const CLOSED_MARKER = '__HVIR_MIDDLE_CLICK_CLOSED__'
const SHELL_READY_MARKER = '__HVIR_MIDDLE_CLICK_SHELL_READY__'

const PRIMARY_SELECTION_PROBE_SOURCE = `
const expected = Buffer.from(process.argv[2], 'base64');
const mode = process.argv[3];
const guardComplete = Buffer.from(process.argv[4], 'base64');
let buffered = Buffer.alloc(0);
let finished = false;
const finish = (marker) => {
  if (finished) return;
  finished = true;
  process.stdin.pause();
  try { process.stdin.setRawMode(false); } catch { marker = '${FAILURE_MARKER}:tty-restore'; }
  process.stdout.write('\\r\\n' + marker + '\\r\\n${CLOSED_MARKER}\\r\\n', () => process.exit(0));
  setTimeout(() => process.exit(2), 100);
};
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  finish('${FAILURE_MARKER}:stdin-not-tty');
} else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(3)) return finish('${FAILURE_MARKER}:aborted');
    buffered = Buffer.concat([buffered, chunk]);
    if (mode === 'guard') {
      const compared = Math.min(buffered.length, guardComplete.length);
      if (!buffered.subarray(0, compared).equals(guardComplete.subarray(0, compared))) {
        return finish('${FAILURE_MARKER}:unexpected-input');
      }
      if (buffered.length > guardComplete.length) {
        return finish('${FAILURE_MARKER}:duplicate-input');
      }
      if (buffered.length === guardComplete.length) return finish('${GUARDED_MARKER}');
      return;
    }
    if (buffered.includes(expected)) return finish('${PASTE_MARKER}');
  });
  process.stdout.write('${READY_MARKER}\\r\\n');
}
`

/** Prove Linux primary-selection routing through real Chromium, Ghostty, and PTY input. */
export async function verifyTerminalMiddleClickCloseGuard(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  root: HostPath,
): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  const terminal = requireSoleTerminal(supervisor, win.webContents.id)
  const restoreSelection = captureSelectionRestore()

  try {
    clipboard.writeText(SELECTION_TEXT, 'selection')
    if (clipboard.readText('selection') !== SELECTION_TEXT) {
      throw new Error('Linux primary selection did not retain the smoke fixture')
    }

    await runProbe(supervisor, terminal, 'paste', () =>
      middleClick(win, terminalPointScript(terminal.id)),
    )
    await runProbe(supervisor, terminal, 'guard', async () => {
      const path = joinHostPath(root, 'package.json').path
      await middleClick(win, viewerTabPointScript(terminal.id, path))
      const closed = (await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const path = ${JSON.stringify(path)};
          const poll = () => {
            const open = [...document.querySelectorAll('.viewer-tab .tab-main')]
              .some((tab) => tab.getAttribute('title') === path);
            if (!open) return resolve(true);
            setTimeout(poll, 25);
          };
          poll();
        })
      `)) as boolean
      if (!closed) throw new Error('middle-click did not close the viewer tab')
    })
  } finally {
    restoreSelection()
  }

  return 'Linux primary-selection terminal paste + guarded viewer close with zero PTY input'
}

async function runProbe(
  supervisor: PtySupervisor,
  terminal: ManagedPty,
  mode: 'paste' | 'guard',
  act: () => Promise<void>,
): Promise<void> {
  let output = ''
  let exit: string | undefined
  let failure: Error | undefined
  let probeStarted = false
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-4_096)
    },
    onExit: (event) => {
      exit = event.signal ? `signal ${event.signal}` : `code ${event.exitCode}`
    },
  })
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      probeLaunchCommand(mode),
    )
    probeStarted = true
    await waitForMarker(() => output, () => exit, READY_MARKER)
    await act()
    if (mode === 'guard') {
      supervisor.write(terminal.id, terminal.ownerId, GUARD_COMPLETE_INPUT)
    }
    await waitForMarker(
      () => output,
      () => exit,
      mode === 'paste' ? PASTE_MARKER : GUARDED_MARKER,
    )
    await waitForMarker(() => output, () => exit, CLOSED_MARKER)
    await waitForMarker(() => output, () => exit, SHELL_READY_MARKER)
    if (output.includes(FAILURE_MARKER)) {
      throw new Error(`middle-click ${mode} probe reported failure`)
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (probeStarted && !output.includes(SHELL_READY_MARKER)) {
      if (!output.includes(CLOSED_MARKER)) {
        try {
          const retained = supervisor.get(terminal.id)
          if (retained?.instanceId === terminal.instanceId) {
            supervisor.write(terminal.id, terminal.ownerId, '\x03')
          }
        } catch {
          // Preserve the original failure; scenario teardown owns an unresponsive PTY.
        }
      }
      try {
        await waitForMarker(() => output, () => exit, SHELL_READY_MARKER)
      } catch {
        // Preserve the original failure; scenario teardown owns an unresponsive PTY.
      }
    }
    await detach()
  }
  if (failure) throw failure
  const retained = supervisor.get(terminal.id)
  if (retained?.instanceId !== terminal.instanceId) {
    throw new Error(`middle-click ${mode} probe replaced the owning PTY`)
  }
}

function probeLaunchCommand(mode: 'paste' | 'guard'): string {
  const source = Buffer.from(PRIMARY_SELECTION_PROBE_SOURCE).toString('base64')
  const expected = Buffer.from(SELECTION_TEXT).toString('base64')
  const guardComplete = Buffer.from(GUARD_COMPLETE_INPUT).toString('base64')
  return `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${source}' '${expected}' '${mode}' '${guardComplete}'; printf '\n%s%s\n' '__HVIR_MIDDLE_CLICK_' 'SHELL_READY__'\n`
}

function captureSelectionRestore(): () => void {
  const previous = {
    text: clipboard.readText('selection'),
    html: clipboard.readHTML('selection'),
    rtf: clipboard.readRTF('selection'),
    image: clipboard.readImage('selection'),
  }
  return () => {
    const data: Parameters<typeof clipboard.write>[0] = {}
    if (previous.text) data.text = previous.text
    if (previous.html) data.html = previous.html
    if (previous.rtf) data.rtf = previous.rtf
    if (!previous.image.isEmpty()) data.image = previous.image
    if (Object.keys(data).length > 0) clipboard.write(data, 'selection')
    else clipboard.clear('selection')
  }
}

async function middleClick(win: BrowserWindow, pointScript: string): Promise<void> {
  win.focus()
  win.webContents.focus()
  const point = (await win.webContents.executeJavaScript(pointScript)) as {
    readonly x: number
    readonly y: number
  }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'middle',
    clickCount: 1,
    x: point.x,
    y: point.y,
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'middle',
    clickCount: 1,
    x: point.x,
    y: point.y,
  })
}

function terminalPointScript(terminalId: string): string {
  return `
    (() => {
      const surface = document.querySelector(
        '.terminal-surface[data-terminal-session="' +
          CSS.escape(${JSON.stringify(terminalId)}) + '"]'
      );
      const engine = surface?.querySelector('.terminal-engine-host');
      const textarea = engine?.querySelector('textarea');
      const canvas = engine?.querySelector('canvas');
      if (!(textarea instanceof HTMLTextAreaElement) || !(canvas instanceof HTMLElement)) {
        throw new Error('terminal primary-selection fixtures missing');
      }
      textarea.focus();
      if (document.activeElement !== textarea) {
        throw new Error('terminal primary-selection input did not focus');
      }
      const bounds = canvas.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2) };
    })()
  `
}

function viewerTabPointScript(terminalId: string, path: string): string {
  return `
    new Promise((resolve, reject) => {
      const path = ${JSON.stringify(path)};
      const waitForFile = () => {
        const file = [...document.querySelectorAll('.file-row')]
          .find((row) => row.getAttribute('title') === path);
        if (!(file instanceof HTMLElement)) return setTimeout(waitForFile, 25);
        file.click();
        const waitForTab = () => {
          const tab = [...document.querySelectorAll('.viewer-tab')]
            .find((candidate) => candidate.querySelector('.tab-main')
              ?.getAttribute('title') === path);
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' +
              CSS.escape(${JSON.stringify(terminalId)}) + '"]'
          );
          const textarea = surface?.querySelector('.terminal-engine-host textarea');
          if (!(tab instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
            return setTimeout(waitForTab, 25);
          }
          textarea.focus();
          if (document.activeElement !== textarea) {
            return reject(new Error('terminal input did not focus before tab close'));
          }
          const bounds = tab.getBoundingClientRect();
          resolve({ x: Math.round(bounds.left + bounds.width / 2),
            y: Math.round(bounds.top + bounds.height / 2) });
        };
        waitForTab();
      };
      waitForFile();
    })
  `
}

function requireSoleTerminal(supervisor: PtySupervisor, ownerId: number): ManagedPty {
  const owned = supervisor.list().filter((terminal) => terminal.ownerId === ownerId)
  if (owned.length !== 1) {
    throw new Error(`middle-click guard requires one live terminal, found ${owned.length}`)
  }
  return owned[0]!
}

async function waitForMarker(
  readOutput: () => string,
  readExit: () => string | undefined,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const output = readOutput()
    if (output.includes(marker)) return
    if (output.includes(FAILURE_MARKER)) {
      throw new Error(`middle-click probe failed before ${marker}`)
    }
    const exit = readExit()
    if (exit) throw new Error(`middle-click probe PTY exited with ${exit}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`middle-click probe timed out before ${marker}`)
}
