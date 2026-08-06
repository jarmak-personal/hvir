import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

/** Prove semantic navigation through the production Ghostty canvas and retained PTY. */
export async function verifyTerminalSemanticNavigation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('semantic navigation has no live terminal')
  const instanceId = terminal.instanceId
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `i=0; while [ "$i" -lt 40 ]; do printf 'semantic-fill-%02d\\r\\n' "$i"; i=$((i+1)); done; ` +
      `printf '\\033]133;A'; sleep 0.05; printf '\\007prompt\\r\\n'; ` +
      `printf '\\033]133;B\\007command\\r\\n'; ` +
      `printf '\\033]133;C'; sleep 0.05; printf '\\007output\\r\\n'; ` +
      `printf '\\033]133;D;0\\007'\n`,
  )

  const result = (await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const fail = (message) => reject(new Error(message));
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface.active[data-terminal-session=${JSON.stringify(terminal.id)}]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const container = surface?.querySelector('.terminal-container');
          const navigation = surface?.querySelector('.terminal-semantic-navigation');
          const previous = navigation?.querySelector(
            'button[aria-label="Previous transcript region"]'
          );
          const next = navigation?.querySelector(
            'button[aria-label="Next transcript region"]'
          );
          if (
            engine instanceof HTMLElement &&
            canvas instanceof HTMLCanvasElement &&
            container instanceof HTMLElement &&
            navigation instanceof HTMLElement &&
            previous instanceof HTMLButtonElement &&
            next instanceof HTMLButtonElement &&
            container.dataset.terminalSemanticRegions === '3' &&
            getComputedStyle(surface).visibility === 'visible'
          ) {
            const acceptedThemes = ['dark', 'light'];
            const root = document.documentElement;
            const priorTheme = root.dataset.theme;
            const presentations = [];
            for (const theme of acceptedThemes) {
              root.dataset.theme = theme;
              const style = getComputedStyle(navigation);
              if (
                style.color === style.backgroundColor ||
                style.color === 'transparent' ||
                style.backgroundColor === 'transparent' ||
                style.borderColor === 'transparent'
              ) {
                if (priorTheme === undefined) delete root.dataset.theme;
                else root.dataset.theme = priorTheme;
                return fail('semantic navigation lost readable theme presentation');
              }
              presentations.push(theme + ':' + style.color + '/' + style.backgroundColor);
            }
            if (priorTheme === undefined) delete root.dataset.theme;
            else root.dataset.theme = priorTheme;

            engine.focus();
            const focused = document.activeElement;
            const selection = document.getSelection()?.toString() || '';
            previous.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true
            }));
            previous.click();
            const waitForOutput = () => {
              const label = navigation.querySelector('.terminal-semantic-region')
                ?.textContent?.trim();
              if (label === 'Output 3 of 3') {
                previous.click();
                const waitForCommand = () => {
                  const command = navigation.querySelector('.terminal-semantic-region')
                    ?.textContent?.trim();
                  if (command === 'Command 2 of 3') {
                    next.click();
                    const waitForNext = () => {
                      const output = navigation.querySelector('.terminal-semantic-region')
                        ?.textContent?.trim();
                      if (output === 'Output 3 of 3') {
                        if (
                          surface.querySelector('.terminal-engine-host') !== engine ||
                          engine.querySelector('canvas') !== canvas ||
                          document.activeElement !== focused ||
                          (document.getSelection()?.toString() || '') !== selection ||
                          document.querySelectorAll('.terminal-semantic-navigation').length !== 1
                        ) {
                          return fail(
                            'semantic navigation replaced canvas, focus, selection, or scope'
                          );
                        }
                        return resolve(
                          'previous/output + previous/command + next/output · ' +
                          presentations.join(' · ')
                        );
                      }
                      if (Date.now() > deadline) return fail('next region did not navigate');
                      requestAnimationFrame(waitForNext);
                    };
                    return waitForNext();
                  }
                  if (Date.now() > deadline) return fail('previous region did not navigate');
                  requestAnimationFrame(waitForCommand);
                };
                return waitForCommand();
              }
              if (Date.now() > deadline) return fail('latest region did not navigate');
              requestAnimationFrame(waitForOutput);
            };
            return waitForOutput();
          }
          if (Date.now() > deadline) {
            return fail(
              'semantic navigation fixtures did not settle: regions=' +
              container?.dataset.terminalSemanticRegions
            );
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'semantic transcript navigation timed out',
    10_000,
  )) as string

  const retained = supervisor.list().find((candidate) => candidate.id === terminal.id)
  if (!retained || retained.instanceId !== instanceId) {
    throw new Error('semantic navigation replaced the supervised PTY')
  }
  return `${result} · retained Canvas and PTY`
}
