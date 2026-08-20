import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

interface SavedThemePair {
  readonly darkId: string
  readonly lightId: string
}

/** Prove bounded data previews, paired save/cancel, live retention, and restart persistence. */
export async function verifyTerminalThemeGalleryPresentation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('terminal theme gallery check has no retained terminal')

  const saved = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const fail = (message) => reject(new Error(message));
        const surface = document.querySelector('.terminal-surface.active');
        const container = surface?.querySelector('.terminal-container');
        const engine = surface?.querySelector('.terminal-engine-host');
        const canvas = engine?.querySelector('canvas');
        const settingsButton = document.querySelector('.settings-toggle');
        const appTheme = document.documentElement.dataset.theme;
        const before = engine?.__hvirTerminalPerformance;
        if (
          (appTheme !== 'dark' && appTheme !== 'light') ||
          !(container instanceof HTMLElement) ||
          !(engine instanceof HTMLElement) ||
          !(canvas instanceof HTMLCanvasElement) ||
          !(settingsButton instanceof HTMLButtonElement) ||
          !before?.palette
        ) return fail('terminal theme gallery fixtures missing');
        const originalCanvas = canvas;
        const originalSettings = localStorage.getItem('hvir:settings:v1');
        const originalPalette = JSON.stringify(before.palette);
        const openedThemeGalleries = new WeakSet();
        const setSearch = (input, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          )?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const waitForDialog = (next) => {
          const gallery = document.querySelector('.terminal-theme-gallery');
          if (gallery instanceof HTMLDetailsElement && !gallery.open) {
            const summary = gallery.querySelector('summary');
            if (!(summary instanceof HTMLElement)) {
              return fail('collapsed Ghostty theme gallery summary missing');
            }
            openedThemeGalleries.add(gallery);
            summary.click();
            return setTimeout(() => waitForDialog(next), 25);
          }
          if (
            gallery instanceof HTMLDetailsElement &&
            gallery.open &&
            !openedThemeGalleries.has(gallery)
          ) return fail('Ghostty theme gallery was not collapsed by default');
          const search = gallery?.querySelector('#settings-terminal-theme-search');
          const results = gallery?.querySelectorAll('.terminal-theme-results > button');
          if (
            gallery instanceof HTMLDetailsElement && gallery.open &&
            openedThemeGalleries.has(gallery) &&
            search instanceof HTMLInputElement &&
            results && results.length > 0 && results.length <= 48
          ) {
            if (gallery.querySelector('canvas')) {
              return fail('theme gallery created a live terminal preview');
            }
            return next(gallery, search);
          }
          setTimeout(() => waitForDialog(next), 25);
        };
        const chooseTarget = (target, gallery, next) => {
          const radio = gallery.querySelector(
            'input[name="terminal-theme-target"][value="' + target + '"]'
          );
          if (!(radio instanceof HTMLInputElement)) {
            throw new Error('terminal theme target missing: ' + target);
          }
          const previous = gallery.querySelector(
            '.terminal-theme-current .terminal-theme-preview-heading strong'
          )?.textContent?.trim();
          const alreadySelected = radio.checked;
          radio.click();
          const waitForTarget = () => {
            const current = gallery.querySelector(
              '.terminal-theme-current .terminal-theme-preview-heading strong'
            )?.textContent?.trim();
            if (radio.checked && (alreadySelected || current !== previous)) return next();
            setTimeout(waitForTarget, 25);
          };
          waitForTarget();
        };
        const chooseTheme = (target, name, gallery, search, next) => {
          chooseTarget(target, gallery, () => {
            setSearch(search, name);
            const waitForTheme = () => {
              const button = [...gallery.querySelectorAll('.terminal-theme-results > button')]
                .find((candidate) =>
                  candidate.querySelector('strong')?.textContent?.trim() === name
                );
              if (button instanceof HTMLButtonElement) {
                const screen = button.querySelector('.terminal-theme-preview-screen');
                const id = button.dataset.terminalThemeId;
                const background = screen instanceof HTMLElement
                  ? screen.style.getPropertyValue('--theme-background')
                  : '';
                if (!id || !background) return fail('theme preview metadata missing: ' + name);
                button.click();
                const waitForSelection = () => {
                  const current = gallery.querySelector(
                    '.terminal-theme-current .terminal-theme-preview-heading strong'
                  )?.textContent?.trim();
                  const selected = gallery.querySelector(
                    '.terminal-theme-results > button[aria-pressed="true"]'
                  );
                  if (
                    current === name &&
                    selected instanceof HTMLButtonElement &&
                    selected.dataset.terminalThemeId === id
                  ) return next({ id, background });

                  setTimeout(waitForSelection, 25);
                };
                waitForSelection();
                return;
              }
              setTimeout(waitForTheme, 25);
            };
            waitForTheme();
          });
        };
        const closeSettings = (label, next) => {
          const button = [...document.querySelectorAll('.settings-dialog button')]
            .find((candidate) => candidate.textContent?.trim() === label);
          if (!(button instanceof HTMLButtonElement)) {
            return fail('settings action missing: ' + label);
          }
          button.click();
          const waitForClose = () => {
            if (!document.querySelector('.settings-dialog')) return next();
            setTimeout(waitForClose, 25);
          };
          waitForClose();
        };
        const makeSelections = (next) => {
          waitForDialog((gallery, search) => {
            chooseTheme('dark', 'Catppuccin Mocha', gallery, search, (dark) => {
              chooseTheme('light', 'Alabaster', gallery, search, (light) => {
                next({ dark, light });
              });
            });
          });
        };
        settingsButton.click();
        makeSelections(() => {
          closeSettings('Close settings', () => {
            const current = engine.__hvirTerminalPerformance;
            if (
              localStorage.getItem('hvir:settings:v1') !== originalSettings ||
              JSON.stringify(current?.palette) !== originalPalette ||
              engine.querySelector('canvas') !== originalCanvas
            ) return fail('cancel changed persisted or live terminal theme state');
            settingsButton.click();
            makeSelections((selections) => {
              closeSettings('Save app settings', () => {
                const expected = appTheme === 'light' ? selections.light : selections.dark;
                const waitForApplied = () => {
                  const currentSettings = JSON.parse(
                    localStorage.getItem('hvir:settings:v1') || 'null'
                  );
                  const stats = engine.__hvirTerminalPerformance;
                  if (
                    currentSettings?.terminalDarkThemeId === selections.dark.id &&
                    currentSettings?.terminalLightThemeId === selections.light.id &&
                    stats?.palette?.background === expected.background &&
                    container.dataset.terminalTheme === appTheme &&
                    engine.querySelector('canvas') === originalCanvas &&
                    originalCanvas.isConnected
                  ) {
                    return resolve({
                      darkId: selections.dark.id,
                      lightId: selections.light.id
                    });
                  }

                  setTimeout(waitForApplied, 25);
                };
                waitForApplied();
              });
            });
          });
        });
      })
    `)) as SavedThemePair

  const retained = supervisor
    .list()
    .filter((candidate) => candidate.ownerId === win.webContents.id)
  if (retained.length !== 1 || retained[0]?.instanceId !== terminal.instanceId) {
    throw new Error('terminal theme save replaced or restarted the retained PTY')
  }

  await new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => {
      resolve()
    })
    win.webContents.reload()
  })

  const restarted = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const expected = ${JSON.stringify(saved)};
        const fail = (message) => reject(new Error(message));
        const open = () => {
          const stored = JSON.parse(localStorage.getItem('hvir:settings:v1') || 'null');
          const button = document.querySelector('.settings-toggle');
          if (
            stored?.terminalDarkThemeId === expected.darkId &&
            stored?.terminalLightThemeId === expected.lightId &&
            button instanceof HTMLButtonElement
          ) {
            button.click();
            return inspectDark();
          }
          setTimeout(open, 25);
        };
        const currentName = () => document.querySelector(
          '.terminal-theme-current .terminal-theme-preview-heading strong'
        )?.textContent?.trim();
        const inspectDark = () => {
          const gallery = document.querySelector('.terminal-theme-gallery');
          if (gallery instanceof HTMLDetailsElement && !gallery.open) {
            gallery.querySelector('summary')?.click();
            return setTimeout(inspectDark, 25);
          }
          if (gallery instanceof HTMLDetailsElement && currentName() === 'Catppuccin Mocha') {
            const light = gallery.querySelector(
              'input[name="terminal-theme-target"][value="light"]'
            );
            if (!(light instanceof HTMLInputElement)) {
              return fail('light theme target missing after restart');
            }
            light.click();
            return inspectLight();
          }
          setTimeout(inspectDark, 25);
        };
        const inspectLight = () => {
          if (currentName() === 'Alabaster') {
            const close = [...document.querySelectorAll('.settings-dialog button')]
              .find((button) => button.textContent?.trim() === 'Close settings');
            close?.click();
            return resolve('Catppuccin Mocha + Alabaster');
          }
          setTimeout(inspectLight, 25);
        };
        open();
      })
    `)) as string

  return `collapsed-by-default bounded data previews + paired save/cancel + retained Canvas/PTY + ${restarted} restart persistence`
}
