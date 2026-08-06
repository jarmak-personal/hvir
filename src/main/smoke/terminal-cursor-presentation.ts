import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

type CursorShape = 'block' | 'hollow-block' | 'bar' | 'underline'
type CursorBlink = 'terminal' | 'blinking' | 'steady'

interface CursorExpectation {
  readonly shape: 'block' | 'block_hollow' | 'bar' | 'underline'
  readonly blinking: boolean
  readonly default: boolean
  readonly canvasShape?: CursorShape
}

/** Prove saved defaults, application authority, native state, and Canvas identity. */
export async function verifyTerminalCursorPresentation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('cursor presentation check has no retained terminal')
  const originalInstanceId = terminal.instanceId

  await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      (() => {
        const surface = document.querySelector('.terminal-surface.active');
        const engine = surface?.querySelector('.terminal-engine-host');
        const canvas = engine?.querySelector('canvas');
        if (
          !(surface instanceof HTMLElement) ||
          !(engine instanceof HTMLElement) ||
          !(canvas instanceof HTMLCanvasElement)
        ) throw new Error('cursor presentation fixtures missing');
        canvas.__hvirCursorCanvasIdentity = Object.freeze({});
      })()
    `),
    'cursor presentation setup timed out',
  )

  const shapes = [
    ['block', 'block'],
    ['hollow-block', 'block_hollow'],
    ['bar', 'bar'],
    ['underline', 'underline'],
  ] as const
  for (const [shape, nativeShape] of shapes) {
    writeCursorControl(supervisor, terminal, '\u001b[2J\u001b[H\u001b[5;5H\u001b[0 q')
    await applyCursorSettings(win, shape, 'steady')
    await waitForCursor(win, {
      shape: nativeShape,
      blinking: false,
      default: true,
      canvasShape: shape,
    })
    assertRetainedPty(supervisor, win, terminal.id, originalInstanceId)
  }

  writeCursorControl(supervisor, terminal, '\u001b[6 q')
  await waitForCursor(win, {
    shape: 'bar',
    blinking: false,
    default: false,
    canvasShape: 'bar',
  })
  await applyCursorSettings(win, 'underline', 'blinking')
  await waitForCursor(win, {
    shape: 'bar',
    blinking: false,
    default: false,
    canvasShape: 'bar',
  })
  writeCursorControl(supervisor, terminal, '\u001b[0 q')
  await waitForCursor(win, { shape: 'underline', blinking: true, default: true })

  await applyCursorSettings(win, 'block', 'terminal')
  writeCursorControl(supervisor, terminal, '\u001b[0 q\u001b[?12h')
  await waitForCursor(win, { shape: 'block', blinking: true, default: true })
  writeCursorControl(supervisor, terminal, '\u001b[?12l')
  await waitForCursor(win, { shape: 'block', blinking: false, default: true })

  await applyCursorSettings(win, 'block', 'blinking')
  writeCursorControl(supervisor, terminal, '\u001b[?12l')
  await waitForCursor(win, { shape: 'block', blinking: true, default: true })

  await applyCursorSettings(win, 'block', 'steady')
  writeCursorControl(supervisor, terminal, '\u001b[?12h')
  await waitForCursor(win, { shape: 'block', blinking: false, default: true })
  assertRetainedPty(supervisor, win, terminal.id, originalInstanceId)

  return '4 cursor defaults + DEC tri-state + DECSCUSR authority + retained Canvas/PTY'
}

async function applyCursorSettings(
  win: BrowserWindow,
  shape: CursorShape,
  blink: CursorBlink,
): Promise<void> {
  await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const expectedShape = ${JSON.stringify(shape)};
        const expectedBlink = ${JSON.stringify(blink)};
        const fail = (message) => reject(new Error(message));
        const settings = document.querySelector('.settings-toggle');
        if (!(settings instanceof HTMLButtonElement)) {
          return fail('cursor settings button missing');
        }
        settings.click();
        const openTerminal = () => {
          const terminal = [...document.querySelectorAll('.settings-section-index button')]
            .find((button) => button.textContent?.trim() === 'Terminal');
          if (terminal instanceof HTMLButtonElement) {
            terminal.click();
            return edit();
          }
          if (Date.now() > deadline) return fail('Terminal settings did not open');
          setTimeout(openTerminal, 20);
        };
        const setSelect = (control, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            'value'
          )?.set;
          setter?.call(control, value);
          control.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const edit = () => {
          const shape = document.querySelector('#settings-terminal-cursor-shape');
          const blink = document.querySelector('#settings-terminal-cursor-blink');
          if (
            shape instanceof HTMLSelectElement &&
            blink instanceof HTMLSelectElement
          ) {
            setSelect(shape, expectedShape);
            setSelect(blink, expectedBlink);
            const save = [...document.querySelectorAll('.settings-dialog button')]
              .find((button) => button.textContent?.trim() === 'Save app settings');
            if (!(save instanceof HTMLButtonElement)) {
              return fail('cursor settings save action missing');
            }
            save.click();
            return waitForApplied();
          }
          if (Date.now() > deadline) return fail('cursor settings controls missing');
          setTimeout(edit, 20);
        };
        const waitForApplied = () => {
          const stored = JSON.parse(localStorage.getItem('hvir:settings:v1') || 'null');
          const engine = document.querySelector(
            '.terminal-surface.active .terminal-engine-host'
          );
          const canvas = engine?.querySelector('canvas');
          const defaults = engine?.__hvirTerminalCursor?.defaults;
          if (
            !document.querySelector('.settings-dialog') &&
            stored?.terminalCursorShape === expectedShape &&
            stored?.terminalCursorBlink === expectedBlink &&
            defaults?.shape === expectedShape &&
            defaults?.blink === expectedBlink &&
            canvas instanceof HTMLCanvasElement &&
            canvas.__hvirCursorCanvasIdentity
          ) return resolve(undefined);
          if (Date.now() > deadline) {
            return fail('cursor settings did not update retained pane: ' + JSON.stringify({
              stored,
              defaults,
              canvasRetained: Boolean(canvas?.__hvirCursorCanvasIdentity)
            }));
          }
          setTimeout(waitForApplied, 20);
        };
        openTerminal();
      })
    `),
    `cursor settings ${shape}/${blink} timed out`,
    10_000,
  )
}

async function waitForCursor(
  win: BrowserWindow,
  expected: CursorExpectation,
): Promise<void> {
  await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const expected = ${JSON.stringify(expected)};
        const fail = (message) => reject(new Error(message));
        const sameRgb = (left, right, tolerance = 4) =>
          left && right &&
          Math.abs(left.r - right.r) <= tolerance &&
          Math.abs(left.g - right.g) <= tolerance &&
          Math.abs(left.b - right.b) <= tolerance;
        const hexRgb = (hex) => ({
          r: Number.parseInt(hex.slice(1, 3), 16),
          g: Number.parseInt(hex.slice(3, 5), 16),
          b: Number.parseInt(hex.slice(5, 7), 16)
        });
        const canvasMatches = (canvas, stats) => {
          if (!expected.canvasShape) return true;
          const context = canvas.getContext('2d');
          const cursor = stats.effectiveCursor;
          const color = stats.palette?.cursor;
          if (!context || !cursor || !color) return false;
          const width = canvas.width / stats.cols;
          const height = canvas.height / stats.rows;
          const left = Math.floor(cursor.viewportX * width);
          const top = Math.floor(cursor.viewportY * height);
          const right = Math.max(left + 1, Math.floor((cursor.viewportX + 1) * width));
          const bottom = Math.max(top + 1, Math.floor((cursor.viewportY + 1) * height));
          const expectedRgb = hexRgb(color);
          const rows = Array.from({ length: bottom - top }, () => 0);
          const columns = Array.from({ length: right - left }, () => 0);
          let total = 0;
          for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
              const pixel = context.getImageData(x, y, 1, 1).data;
              if (sameRgb({ r: pixel[0], g: pixel[1], b: pixel[2] }, expectedRgb)) {
                total++;
                rows[y - top]++;
                columns[x - left]++;
              }
            }
          }
          const area = rows.length * columns.length;
          const maxRow = Math.max(0, ...rows);
          const maxColumn = Math.max(0, ...columns);
          if (expected.canvasShape === 'block') return total > area * 0.65;
          if (expected.canvasShape === 'hollow-block') {
            const center = context.getImageData(
              Math.floor((left + right) / 2),
              Math.floor((top + bottom) / 2),
              1,
              1
            ).data;
            return total < area * 0.5 &&
              !sameRgb({ r: center[0], g: center[1], b: center[2] }, expectedRgb) &&
              maxRow > columns.length * 0.7 && maxColumn > rows.length * 0.7;
          }
          if (expected.canvasShape === 'bar') {
            return total < area * 0.5 &&
              maxColumn > rows.length * 0.7 && maxRow < columns.length * 0.6;
          }
          return total < area * 0.5 &&
            maxRow > columns.length * 0.7 && maxColumn < rows.length * 0.6;
        };
        const poll = () => {
          const engine = document.querySelector(
            '.terminal-surface.active .terminal-engine-host'
          );
          const canvas = engine?.querySelector('canvas');
          const stats = engine?.__hvirTerminalPerformance;
          const cursor = engine?.__hvirTerminalCursor?.effective;
          if (
            engine instanceof HTMLElement &&
            canvas instanceof HTMLCanvasElement &&
            canvas.__hvirCursorCanvasIdentity &&
            stats && !stats.paused && !stats.pendingFrame &&
            cursor?.visible && cursor.style === expected.shape &&
            cursor.blinking === expected.blinking &&
            cursor.default === expected.default &&
            canvasMatches(canvas, { ...stats, effectiveCursor: cursor })
          ) return resolve(undefined);
          if (Date.now() > deadline) {
            return fail('cursor state or Canvas did not settle: ' + JSON.stringify({
              cursor,
              paused: stats?.paused,
              pendingFrame: stats?.pendingFrame,
              canvasRetained: Boolean(canvas?.__hvirCursorCanvasIdentity)
            }));
          }
          setTimeout(poll, 20);
        };
        poll();
      })
    `),
    `cursor state ${expected.shape}/${expected.blinking}/${expected.default} timed out`,
    7_000,
  )
}

function writeCursorControl(
  supervisor: PtySupervisor,
  terminal: Readonly<{ id: string; ownerId: number }>,
  sequence: string,
): void {
  supervisor.write(terminal.id, terminal.ownerId, `printf '${printfEscaped(sequence)}'\n`)
}

function printfEscaped(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "'\\''")
    .replaceAll('\u001b', '\\033')
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
    throw new Error('cursor settings replaced or restarted the retained PTY')
  }
}
