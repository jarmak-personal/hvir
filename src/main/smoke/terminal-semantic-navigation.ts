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
        const deadline = Date.now() + 30000;
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
          const inputLayer = engine?.querySelector(
            '.terminal-submitted-input-decoration-layer'
          );
          const searchLayer = engine?.querySelector(
            '.terminal-search-match-highlight-layer'
          );
          if (
            engine instanceof HTMLElement &&
            canvas instanceof HTMLCanvasElement &&
            container instanceof HTMLElement &&
            navigation instanceof HTMLElement &&
            previous instanceof HTMLButtonElement &&
            next instanceof HTMLButtonElement &&
            inputLayer instanceof HTMLElement &&
            inputLayer.childElementCount > 0 &&
            searchLayer instanceof HTMLElement &&
            container.dataset.terminalSemanticRegions === '3' &&
            getComputedStyle(surface).visibility === 'visible'
          ) {
            const acceptedThemes = ['dark', 'light'];
            const root = document.documentElement;
            const priorTheme = root.dataset.theme;
            const presentations = [];
            const themeToggle = document.querySelector('.theme-toggle');
            const settingsButton = document.querySelector('.settings-toggle');
            if (
              !acceptedThemes.includes(priorTheme) ||
              !(themeToggle instanceof HTMLButtonElement) ||
              !(settingsButton instanceof HTMLButtonElement)
            ) return fail('submitted-input presentation controls missing');
            const presentationMatches = (theme) => {
              const style = getComputedStyle(navigation);
              const segment = inputLayer.querySelector(
                '.terminal-submitted-input-decoration'
              );
              const segmentStyle = segment ? getComputedStyle(segment) : undefined;
              const stats = engine.__hvirTerminalPerformance;
              const inputZ = Number(getComputedStyle(inputLayer).zIndex);
              const searchZ = Number(getComputedStyle(searchLayer).zIndex);
              return root.dataset.theme === theme &&
                container.dataset.terminalTheme === theme &&
                canvas === engine.querySelector('canvas') &&
                getComputedStyle(canvas).filter === 'none' &&
                style.color !== style.backgroundColor &&
                style.color !== 'transparent' &&
                style.backgroundColor !== 'transparent' &&
                style.borderColor !== 'transparent' &&
                stats?.palette && stats.cursorVisible &&
                inputLayer.style.getPropertyValue('--terminal-input-background') ===
                  stats.palette.background &&
                inputLayer.style.getPropertyValue('--terminal-input-foreground') ===
                  stats.palette.foreground &&
                segmentStyle &&
                segmentStyle.backgroundColor !== 'transparent' &&
                segmentStyle.borderLeftStyle !== 'none' &&
                Number.parseFloat(segmentStyle.borderLeftWidth) > 0 &&
                inputZ < searchZ;
            };
            const waitForPresentation = (theme, nextStep) => {
              if (presentationMatches(theme)) {
                const segment = inputLayer.querySelector(
                  '.terminal-submitted-input-decoration'
                );
                const style = getComputedStyle(segment);
                presentations.push(
                  theme + ':' + style.backgroundColor + '/' + style.borderLeftColor
                );
                return nextStep();
              }
              if (Date.now() > deadline) {
                return fail('submitted-input treatment lost theme or precedence: ' + theme);
              }
              setTimeout(() => waitForPresentation(theme, nextStep), 25);
            };
            const setHighlight = (enabled, nextStep) => {
              settingsButton.click();
              const openTerminalSettings = () => {
                const terminalSection = [...document.querySelectorAll(
                  '.settings-section-index button'
                )].find((button) => button.textContent?.trim() === 'Terminal');
                if (terminalSection instanceof HTMLButtonElement) {
                  terminalSection.click();
                  return editSetting();
                }
                if (Date.now() > deadline) return fail('Terminal settings did not open');
                setTimeout(openTerminalSettings, 25);
              };
              const editSetting = () => {
                const control = document.querySelector(
                  '#settings-highlight-submitted-input'
                );
                const save = [...document.querySelectorAll('.settings-dialog button')]
                  .find((button) => button.textContent?.trim() === 'Save app settings');
                if (
                  control instanceof HTMLInputElement &&
                  save instanceof HTMLButtonElement
                ) {
                  if (control.checked !== enabled) control.click();
                  save.click();
                  return waitForSetting();
                }
                if (Date.now() > deadline) return fail('submitted-input setting missing');
                setTimeout(editSetting, 25);
              };
              const waitForSetting = () => {
                const stored = JSON.parse(
                  localStorage.getItem('hvir:settings:v1') || 'null'
                );
                const decorations = engine.querySelectorAll(
                  '.terminal-submitted-input-decoration'
                ).length;
                if (
                  !document.querySelector('.settings-dialog') &&
                  stored?.highlightSubmittedInput === enabled &&
                  (enabled ? decorations > 0 : decorations === 0) &&
                  engine.querySelector('canvas') === canvas
                ) return nextStep();
                if (Date.now() > deadline) {
                  return fail('submitted-input setting did not update the retained pane');
                }
                setTimeout(waitForSetting, 25);
              };
              openTerminalSettings();
            };
            const verifyHiddenReveal = (nextStep) => {
              const originalSession = surface.dataset.terminalSession;
              const add = document.querySelector('button[aria-label="New terminal"]');
              if (!originalSession || !(add instanceof HTMLButtonElement)) {
                return fail('submitted-input hidden/reveal controls missing');
              }
              add.click();
              const launchShell = () => {
                const shell = [...document.querySelectorAll(
                  '.terminal-new-menu button'
                )].find((button) =>
                  button.querySelector('strong')?.textContent?.trim() === 'Shell'
                );
                if (shell instanceof HTMLButtonElement) {
                  shell.click();
                  return waitForSecond();
                }
                if (Date.now() > deadline) return fail('second terminal menu missing');
                setTimeout(launchShell, 25);
              };
              const waitForSecond = () => {
                const rows = [...document.querySelectorAll('.terminal-list-row')];
                const extraRow = rows.find((row) =>
                  row.querySelector('.terminal-list-main')?.getAttribute(
                    'data-terminal-session'
                  ) !== originalSession
                );
                const extraId = extraRow?.querySelector('.terminal-list-main')
                  ?.getAttribute('data-terminal-session');
                const extraSurface = extraId ? document.querySelector(
                  '.terminal-surface[data-terminal-session="' +
                    CSS.escape(extraId) + '"]'
                ) : undefined;
                const extraStatus = extraSurface?.getAttribute('data-terminal-status') || '';
                if (
                  rows.length === 2 &&
                  extraRow instanceof HTMLElement &&
                  extraSurface instanceof HTMLElement &&
                  extraStatus.startsWith('pid ')
                ) {
                  extraRow.querySelector('.terminal-list-main')?.click();
                  return waitForHidden(extraRow);
                }
                if (Date.now() > deadline) return fail('second terminal did not start');
                setTimeout(waitForSecond, 25);
              };
              const waitForHidden = (extraRow) => {
                const stats = engine.__hvirTerminalPerformance;
                if (
                  getComputedStyle(surface).visibility === 'hidden' &&
                  stats?.paused &&
                  stats.submittedInputDecorationSegments === 0
                ) {
                  const hiddenPaints = stats.submittedInputDecorationPaints;
                  const originalRow = [...document.querySelectorAll(
                    '.terminal-list-row'
                  )].find((row) =>
                    row.querySelector('.terminal-list-main')?.getAttribute(
                      'data-terminal-session'
                    ) === originalSession
                  );
                  originalRow?.querySelector('.terminal-list-main')?.click();
                  return waitForReveal(extraRow, hiddenPaints);
                }
                if (Date.now() > deadline) {
                  return fail('submitted-input hidden pane still painted');
                }
                setTimeout(() => waitForHidden(extraRow), 25);
              };
              const waitForReveal = (extraRow, hiddenPaints) => {
                const stats = engine.__hvirTerminalPerformance;
                if (
                  getComputedStyle(surface).visibility === 'visible' &&
                  !stats?.paused &&
                  stats.submittedInputDecorationSegments > 0 &&
                  stats.submittedInputDecorationPaints > hiddenPaints &&
                  engine.querySelector('canvas') === canvas
                ) {
                  extraRow.querySelector('.terminal-close-button')?.click();
                  return waitForClose();
                }
                if (Date.now() > deadline) {
                  return fail('submitted-input treatment did not return on reveal');
                }
                setTimeout(() => waitForReveal(extraRow, hiddenPaints), 25);
              };
              const waitForClose = () => {
                if (document.querySelectorAll('.terminal-list-row').length === 1) {
                  return nextStep();
                }
                if (Date.now() > deadline) return fail('second terminal did not close');
                setTimeout(waitForClose, 25);
              };
              launchShell();
            };

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
                        const alternateTheme = priorTheme === 'light' ? 'dark' : 'light';
                        return waitForPresentation(priorTheme, () => {
                          themeToggle.click();
                          waitForPresentation(alternateTheme, () => {
                            themeToggle.click();
                            waitForPresentation(priorTheme, () => {
                              setHighlight(false, () => {
                                setHighlight(true, () => verifyHiddenReveal(() => resolve(
                                  'previous/output + previous/command + next/output · ' +
                                  'live setting off/on · hidden/reveal paint isolation · ' +
                                  'Canvas cursor/selection retained · search precedence · ' +
                                  presentations.join(' · ')
                                )));
                              });
                            });
                          });
                        });
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
    32_000,
  )) as string

  const retained = supervisor.list().find((candidate) => candidate.id === terminal.id)
  if (!retained || retained.instanceId !== instanceId) {
    throw new Error('semantic navigation replaced the supervised PTY')
  }
  return `${result} · retained Canvas and PTY`
}
