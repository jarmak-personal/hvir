import type { BrowserWindow } from 'electron'

export async function verifyWorkbenchChrome(win: BrowserWindow): Promise<void> {
  const themeStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const initial = document.documentElement.dataset.theme;
        const canvas = document.querySelector('.terminal-container canvas');
        const terminal = canvas?.closest('.terminal-container');
        const engine = terminal?.querySelector('.terminal-engine-host');
        const toggle = document.querySelector('.theme-toggle');
        const shell = document.querySelector('.app-shell');
        if (!canvas || !terminal || !engine || !toggle || !shell) return reject(new Error('theme smoke controls missing'));
        const terminalBackgroundMatches = () => {
          const expected = terminal.getAttribute('data-terminal-theme') === 'light'
            ? 'rgb(236, 236, 231)'
            : 'rgb(17, 19, 24)';
          return getComputedStyle(terminal).backgroundColor === expected;
        };
        const before = getComputedStyle(shell).backgroundColor;
        const terminalBefore = getComputedStyle(canvas).filter;
        const paletteBefore = engine.__hvirTerminalPerformance?.palette?.background;
        if (terminalBefore !== 'none' || !paletteBefore) {
          return reject(new Error('terminal Canvas still uses a color filter'));
        }
        if (!terminalBackgroundMatches()) {
          return reject(new Error('terminal host background does not match its palette'));
        }
        toggle.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const current = document.documentElement.dataset.theme;
          const after = getComputedStyle(shell).backgroundColor;
          const terminalAfter = getComputedStyle(canvas).filter;
          const paletteAfter = engine.__hvirTerminalPerformance?.palette?.background;
          if (current === initial || before === after) {
            return reject(new Error('chrome theme did not change'));
          }
          if (
            terminalAfter !== 'none' ||
            !paletteAfter ||
            paletteBefore === paletteAfter
          ) {
            return reject(new Error('live terminal palette did not change'));
          }
          if (!terminalBackgroundMatches()) {
            return reject(new Error('terminal host background diverged from its palette'));
          }
          if (!canvas.isConnected || document.querySelector('.terminal-container canvas') !== canvas) {
            return reject(new Error('theme switch remounted terminal'));
          }
          toggle.click();
          requestAnimationFrame(() => {
            if (
              document.documentElement.dataset.theme !== initial ||
              engine.__hvirTerminalPerformance?.palette?.background !== paletteBefore
            ) {
              return reject(new Error('theme did not restore'));
            }
            resolve(initial + '→' + current + '→' + initial + ' · PTY canvas retained');
          });
        }));
      })
    `)) as string
  console.log(`[smoke] synchronized theme switch OK (${themeStatus})`)
}
