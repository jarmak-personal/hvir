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

  const railNavigationStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const railButtons = [...document.querySelectorAll('.rail-nav button')];
        const byLabel = (label) =>
          railButtons.find((node) => node.textContent?.trim().startsWith(label));
        const files = byLabel('Files');
        const sessions = document.querySelector('.sessions-destination');
        const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
          .find((node) => node.querySelector(':scope > .directory-row')
            ?.getAttribute('title')?.endsWith('/src'));
        if (!files || !(sessions instanceof HTMLButtonElement) || !directory) {
          return reject(new Error('stable rail navigation controls missing'));
        }
        const directoryRow = directory.querySelector(':scope > .directory-row');
        if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
        const tabsBefore = document.querySelectorAll('.viewer-tab').length;
        sessions.click();
        const waitForSessions = () => {
          const overview = document.querySelector('.sessions-overview');
          const workbench = document.querySelector('.workbench');
          if (
            sessions.disabled ||
            !sessions.classList.contains('active') ||
            sessions.getAttribute('aria-current') !== 'page' ||
            !overview ||
            !(workbench instanceof HTMLElement) ||
            !workbench.hidden
          ) {
            return setTimeout(waitForSessions, 25);
          }
          const project = document.querySelector('.project-tab-main');
          if (!(project instanceof HTMLButtonElement)) {
            return reject(new Error('project navigation control missing'));
          }
          project.click();
          const waitForFiles = () => {
            const currentFiles = [...document.querySelectorAll('.rail-nav button')]
              .find((node) => node.textContent?.trim().startsWith('Files'));
            const ready = directory.isConnected &&
              directoryRow?.getAttribute('aria-expanded') === 'true' &&
              document.querySelectorAll('.viewer-tab').length === tabsBefore &&
              currentFiles?.classList.contains('active') &&
              !sessions.disabled &&
              !document.querySelector('.sessions-overview');
            if (ready) {
              return resolve(
                'stable tabs · Files state preserved · Sessions full-page round trip'
              );
            }

            setTimeout(waitForFiles, 25);
          };
          waitForFiles();
        };
        waitForSessions();
      })
    `)) as string
  console.log(`[smoke] rail navigation OK (${railNavigationStatus})`)
}
