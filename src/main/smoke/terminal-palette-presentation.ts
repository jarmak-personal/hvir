import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

const ANSI_BACKGROUND_CODES = [
  40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107,
] as const

/** Prove hvir palettes reach native state and unfiltered Canvas presentation. */
export async function verifyTerminalPalettePresentation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('palette presentation check has no retained terminal')
  const sequence = paletteFixtureSequence()
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `stty -echo; printf '${printfEscaped(sequence)}'; IFS= read -r hvir_palette; stty echo\n`,
  )
  try {
    const status = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const ansiKeys = [
            'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
            'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
            'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
          ];
          const initialTheme = document.documentElement.dataset.theme;
          const alternateTheme = initialTheme === 'light' ? 'dark' : 'light';
          const toggle = document.querySelector('.theme-toggle');
          const surface = document.querySelector('.terminal-surface.active');
          const container = surface?.querySelector('.terminal-container');
          const engine = surface?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          if (
            (initialTheme !== 'dark' && initialTheme !== 'light') ||
            !(toggle instanceof HTMLButtonElement) ||
            !(surface instanceof HTMLElement) ||
            !(container instanceof HTMLElement) ||
            !(engine instanceof HTMLElement) ||
            !(canvas instanceof HTMLCanvasElement)
          ) return reject(new Error('palette presentation fixtures missing'));
          const context = canvas.getContext('2d');
          if (!context) return reject(new Error('palette Canvas context missing'));
          const originalCanvas = canvas;
          const fail = (message) => reject(new Error(message));
          const hexRgb = (hex) => ({
            r: Number.parseInt(hex.slice(1, 3), 16),
            g: Number.parseInt(hex.slice(3, 5), 16),
            b: Number.parseInt(hex.slice(5, 7), 16)
          });
          const sameRgb = (left, right, tolerance = 0) =>
            left && right &&
            Math.abs(left.r - right.r) <= tolerance &&
            Math.abs(left.g - right.g) <= tolerance &&
            Math.abs(left.b - right.b) <= tolerance;
          const pixel = (x, y) => {
            const value = context.getImageData(x, y, 1, 1).data;
            return { r: value[0], g: value[1], b: value[2] };
          };
          const cellBounds = (stats, row, column) => {
            const width = canvas.width / stats.cols;
            const height = canvas.height / stats.rows;
            return {
              left: Math.floor(column * width),
              top: Math.floor(row * height),
              right: Math.max(Math.floor((column + 1) * width), 1),
              bottom: Math.max(Math.floor((row + 1) * height), 1)
            };
          };
          const centerPixel = (stats, row, column) => {
            const bounds = cellBounds(stats, row, column);
            return pixel(
              Math.min(canvas.width - 1, Math.floor((bounds.left + bounds.right) / 2)),
              Math.min(canvas.height - 1, Math.floor((bounds.top + bounds.bottom) / 2))
            );
          };
          const countCellColor = (stats, row, column, expected, tolerance = 4) => {
            const bounds = cellBounds(stats, row, column);
            let matches = 0;
            for (let y = bounds.top; y < bounds.bottom; y++) {
              for (let x = bounds.left; x < bounds.right; x++) {
                if (sameRgb(pixel(x, y), expected, tolerance)) matches++;
              }
            }
            return matches;
          };
          const read = () => {
            const stats = engine.__hvirTerminalPerformance;
            return { stats, palette: stats?.palette, native: stats?.effectiveColors };
          };
          const nativeMatches = (current) => {
            if (!current.palette || !current.native || current.native.palette.length !== 16) {
              return false;
            }
            if (
              !sameRgb(current.native.background, hexRgb(current.palette.background)) ||
              !sameRgb(current.native.foreground, hexRgb(current.palette.foreground)) ||
              !sameRgb(current.native.cursor, hexRgb(current.palette.cursor))
            ) return false;
            return ansiKeys.every((key, index) =>
              sameRgb(current.native.palette[index], hexRgb(current.palette[key]))
            );
          };
          const ansiCanvasMatches = (current) => ansiKeys.every((key, index) =>
            sameRgb(
              centerPixel(current.stats, 0, index * 3),
              hexRgb(current.palette[key]),
              1
            )
          );
          const cursorCanvasMatches = (current) => {
            const cursor = hexRgb(current.palette.cursor);
            const cursorText = hexRgb(current.palette.cursorText);
            const bounds = cellBounds(current.stats, 2, 0);
            const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
            return countCellColor(current.stats, 2, 0, cursor, 4) > area / 3 &&
              countCellColor(current.stats, 2, 0, cursorText, 12) > 0;
          };
          const baseMatches = (theme) => {
            const current = read();
            return document.documentElement.dataset.theme === theme &&
              container.dataset.terminalTheme === theme &&
              getComputedStyle(canvas).filter === 'none' &&
              canvas === originalCanvas && canvas.isConnected &&
              current.stats && !current.stats.paused && !current.stats.pendingFrame &&
              nativeMatches(current) && ansiCanvasMatches(current) &&
              cursorCanvasMatches(current);
          };
          const waitForBase = (theme, next) => {
            if (baseMatches(theme)) return next();
            if (Date.now() > deadline) {
              return fail('palette did not reach native state and Canvas for ' + theme + ': ' +
                JSON.stringify(read()));
            }
            setTimeout(() => waitForBase(theme, next), 25);
          };
          const openSelection = (theme, next) => {
            canvas.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              buttons: 2,
              clientX: canvas.getBoundingClientRect().left + 20,
              clientY: canvas.getBoundingClientRect().top + 20
            }));
            const waitForMenu = () => {
              const selectAll = [...document.querySelectorAll('.terminal-context-menu button')]
                .find((button) => button.textContent?.trim() === 'Select All');
              if (selectAll instanceof HTMLButtonElement) {
                selectAll.click();
                return waitForSelection(theme, next);
              }
              if (Date.now() > deadline) return fail('palette Select All action missing');
              setTimeout(waitForMenu, 25);
            };
            waitForMenu();
          };
          const selectionMatches = (theme) => {
            const current = read();
            if (
              document.documentElement.dataset.theme !== theme ||
              !current.stats || !current.palette || canvas !== originalCanvas
            ) return false;
            const background = hexRgb(current.palette.selectionBackground);
            const foreground = hexRgb(current.palette.selectionForeground);
            const bounds = cellBounds(current.stats, 3, 0);
            const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
            return countCellColor(current.stats, 3, 0, background, 4) > area / 3 &&
              countCellColor(current.stats, 3, 0, foreground, 12) > 0;
          };
          const waitForSelection = (theme, next) => {
            if (selectionMatches(theme)) return next();
            if (Date.now() > deadline) {
              return fail('selection palette did not paint for ' + theme + ': ' +
                JSON.stringify(read()));
            }
            setTimeout(() => waitForSelection(theme, next), 25);
          };
          const waitForFixture = () => {
            const title = document.querySelector('.terminal-list-row.active .terminal-list-title')
              ?.textContent?.trim();
            if (title === 'Palette ready') {
              return waitForBase(initialTheme, () => {
                toggle.click();
                waitForBase(alternateTheme, () => {
                  openSelection(alternateTheme, () => {
                    toggle.click();
                    waitForSelection(initialTheme, () => {
                      canvas.dispatchEvent(new MouseEvent('mousedown', {
                        bubbles: true,
                        cancelable: true,
                        button: 0,
                        buttons: 1,
                        clientX: canvas.getBoundingClientRect().left + 2,
                        clientY: canvas.getBoundingClientRect().top + 2
                      }));
                      document.dispatchEvent(new MouseEvent('mouseup', {
                        bubbles: true,
                        button: 0,
                        buttons: 0
                      }));
                      resolve(
                        initialTheme + '↔' + alternateTheme +
                        ' · native fg/bg/cursor + ANSI 0–15 · cursor text + selection · unfiltered Canvas retained'
                      );
                    });
                  });
                });
              });
            }
            if (Date.now() > deadline) return fail('palette fixture did not settle');
            setTimeout(waitForFixture, 25);
          };
          waitForFixture();
        })
      `),
      'terminal palette presentation timed out',
      12_000,
    )) as string
    const retained = supervisor
      .list()
      .filter((candidate) => candidate.ownerId === win.webContents.id)
    if (retained.length !== 1 || retained[0]?.instanceId !== terminal.instanceId) {
      throw new Error('palette presentation replaced the retained PTY')
    }
    return `${status} · retained PTY`
  } finally {
    supervisor.write(terminal.id, terminal.ownerId, '\n')
  }
}

function paletteFixtureSequence(): string {
  let sequence = '\u001b[2J\u001b[H\u001b[?25l'
  ANSI_BACKGROUND_CODES.forEach((code, index) => {
    sequence += `\u001b[1;${index * 3 + 1}H\u001b[${code}m  \u001b[0m`
  })
  sequence += '\u001b[3;1HMMMM\u001b[4;1HSELECT\u001b[3;1H\u001b[?25h'
  sequence += '\u001b]0;Palette ready\u0007'
  return sequence
}

function printfEscaped(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "'\\''")
    .replaceAll('\u001b', '\\033')
    .replaceAll('\u0007', '\\007')
}
