import { clipboard, type BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

const READY = '__HVIR_MENU_READY__'
const ACTIONS_READY = '__HVIR_MENU_ACTIONS_READY__'
const LEAK = '__HVIR_MENU_LEAK__'
const INPUT = '__HVIR_MENU_INPUT__:hvir-context-menu-paste:END'

/** Prove the host-owned menu against a real Ghostty Canvas and PTY. */
export async function verifyTerminalContextMenu(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  await waitForTerminalCount(supervisor, win.webContents.id, 1)
  const terminals = supervisor
    .list()
    .filter((candidate) => candidate.ownerId === win.webContents.id)
  const terminal = terminals.length === 1 ? terminals[0] : undefined
  if (!terminal) throw new Error('terminal context menu requires one live terminal')

  let output = ''
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-16_384)
    },
  })
  clipboard.clear()
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      "stty -echo -icanon min 0 time 50; printf '\n__HVIR_MENU_READY__\n'; hvir_menu_leak=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty icanon min 1 time 0; if [ -n \"$hvir_menu_leak\" ]; then printf '\n__HVIR_MENU_LEAK__:%s\n' \"$hvir_menu_leak\"; fi; printf '\n__HVIR_MENU_ACTIONS_READY__\n'; IFS= read -r hvir_menu_input; printf '\n__HVIR_MENU_INPUT__:%s:END\n' \"$hvir_menu_input\"; stty echo\n",
    )
    await waitForOutput(
      () => containsOutputLine(output, READY),
      'terminal menu probe did not start',
    )
    output = ''

    const pointerAndKeyboard = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 4500;
          const fail = (message) => reject(new Error(message));
          const findAction = (label) => [...document.querySelectorAll(
            '.terminal-context-menu [role="menuitem"]'
          )].find((entry) => entry.textContent?.trim() === label);
          const waitForMenu = (check) => {
            const menu = document.querySelector('.terminal-context-menu');
            if (menu instanceof HTMLElement && getComputedStyle(menu).visibility === 'visible') {
              return check(menu);
            }
            if (Date.now() > deadline) return fail('terminal context menu did not open');
            setTimeout(() => waitForMenu(check), 20);
          };
          const openPointer = (engine, check) => {
            const init = {
              bubbles: true,
              cancelable: true,
              clientX: window.innerWidth - 2,
              clientY: window.innerHeight - 2,
              button: 2,
              buttons: 2
            };
            engine.dispatchEvent(new MouseEvent('mousedown', init));
            engine.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
            engine.dispatchEvent(new MouseEvent('contextmenu', init));
            waitForMenu(check);
          };
          const waitForDismissal = (next) => {
            if (!document.querySelector('.terminal-context-menu')) return next();
            if (Date.now() > deadline) return fail('terminal context menu did not dismiss');
            setTimeout(() => waitForDismissal(next), 20);
          };
          const surface = document.querySelector('.terminal-surface.active');
          const engine = surface?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const textarea = engine?.querySelector('textarea');
          if (
            !(surface instanceof HTMLElement) ||
            !(engine instanceof HTMLElement) ||
            !(canvas instanceof HTMLCanvasElement) ||
            !(textarea instanceof HTMLTextAreaElement)
          ) {
            return fail('terminal menu fixtures missing');
          }
          const textareaState = {
            style: textarea.style.cssText,
            value: textarea.value
          };
          window.__hvirSmokeContextMenu = {
            sessionId: surface.dataset.terminalSession,
            engine,
            canvas
          };
          openPointer(engine, (menu) => {
            const bounds = menu.getBoundingClientRect();
            if (
              bounds.left < 7 || bounds.top < 7 ||
              bounds.right > window.innerWidth - 7 ||
              bounds.bottom > window.innerHeight - 7
            ) {
              return fail('pointer terminal menu escaped viewport bounds');
            }
            const selectAll = findAction('Select All');
            if (!(selectAll instanceof HTMLButtonElement)) {
              return fail('Select All action missing');
            }
            selectAll.click();
            waitForDismissal(() => {
              engine.focus();
              const shiftF10 = new KeyboardEvent('keydown', {
                key: 'F10',
                code: 'F10',
                shiftKey: true,
                bubbles: true,
                cancelable: true
              });
              engine.dispatchEvent(shiftF10);
              if (!shiftF10.defaultPrevented) {
                return fail('Shift+F10 was not captured before terminal input');
              }
              waitForMenu(() => {
                const copy = findAction('Copy Selection');
                if (
                  !(copy instanceof HTMLButtonElement) ||
                  copy.disabled ||
                  document.activeElement !== copy
                ) {
                  return fail(
                    'keyboard menu did not focus enabled Copy Selection: copy=' +
                    (copy instanceof HTMLButtonElement) +
                    ' disabled=' + (copy instanceof HTMLButtonElement && copy.disabled) +
                    ' active=' + document.activeElement?.textContent?.trim()
                  );
                }
                copy.click();
                waitForDismissal(() => {
                  engine.focus();
                  const contextKey = new KeyboardEvent('keydown', {
                    key: 'ContextMenu',
                    code: 'ContextMenu',
                    bubbles: true,
                    cancelable: true
                  });
                  engine.dispatchEvent(contextKey);
                  if (!contextKey.defaultPrevented) {
                    return fail('Context Menu key was not captured before terminal input');
                  }
                  waitForMenu(() => {
                    const clear = findAction('Clear Screen and Scrollback');
                    if (!(clear instanceof HTMLButtonElement)) {
                      return fail('Clear action missing');
                    }
                    clear.click();
                    waitForDismissal(() => {
                      openPointer(engine, () => {
                        const reset = findAction('Reset Terminal');
                        if (!(reset instanceof HTMLButtonElement)) {
                          return fail('Reset action missing');
                        }
                        reset.click();
                        waitForDismissal(() => {
                          const retained = window.__hvirSmokeContextMenu;
                          if (
                            retained.engine !== engine ||
                            retained.canvas !== canvas ||
                            engine.querySelector('canvas') !== canvas ||
                            textarea.style.cssText !== textareaState.style ||
                            textarea.value !== textareaState.value ||
                            document.activeElement === textarea
                          ) {
                            return fail(
                              'terminal actions replaced presentation or mutated hidden textarea'
                            );
                          }
                          resolve('pointer + Shift+F10 + Context Menu key');
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        })
      `),
      'terminal pointer and keyboard menu proof timed out',
      6_000,
    )) as string

    await waitForOutput(
      () => containsOutputLine(output, ACTIONS_READY),
      'terminal menu non-interference probe did not settle',
      7_000,
    )
    if (output.includes(LEAK)) {
      throw new Error(
        `opening or invoking terminal menu actions wrote PTY input: ${JSON.stringify(output)}`,
      )
    }
    await waitForClipboard(
      (value) => value.includes(READY),
      'Copy Selection did not reach the application clipboard',
    )

    const settings = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(
        menuActionScript(
          'Terminal Settings…',
          `
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const heading = document.querySelector('#settings-terminal-title');
            const active = document.querySelector(
              '.settings-section-index button[aria-current="page"]'
            );
            if (
              heading instanceof HTMLElement &&
              heading.textContent?.trim() === 'Terminal' &&
              active?.textContent?.trim() === 'Terminal' &&
              document.activeElement === heading
            ) {
              const close = [...document.querySelectorAll('.settings-dialog button')].find(
                (button) => button.textContent?.trim() === 'Close settings'
              );
              if (!(close instanceof HTMLButtonElement)) {
                return reject(new Error('Settings close action missing'));
              }
              close.click();
              return resolve('Terminal Settings section');
            }
            if (Date.now() > deadline) {
              return reject(new Error(
                'Terminal Settings did not open the Terminal section'
              ));
            }
            setTimeout(poll, 20);
          };
          poll();
        });
      `,
        ),
      ),
      'terminal Settings menu action timed out',
    )) as string

    clipboard.writeText('hvir-context-menu-paste')
    const paste = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(
        menuActionScript(
          'Paste',
          `
        return 'explicit plain-text Paste';
      `,
        ),
      ),
      'terminal Paste menu action timed out',
    )) as string
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    if (output.includes('__HVIR_MENU_INPUT__:')) {
      throw new Error('terminal context Paste submitted an additional newline')
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitForOutput(
      () => output.includes(INPUT),
      'terminal context Paste did not preserve exact plain text',
    )

    const split = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(
        menuActionScript(
          'Split Terminal',
          `
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const retained = window.__hvirSmokeContextMenu;
          const poll = () => {
            const surfaces = [...document.querySelectorAll('.terminal-surface')];
            const successor = surfaces.find(
              (surface) => surface.dataset.terminalSession !== retained.sessionId
            );
            const canvas = retained.engine.querySelector('canvas');
            if (
              surfaces.length === 2 &&
              successor instanceof HTMLElement &&
              canvas === retained.canvas &&
              retained.canvas.isConnected
            ) {
              const row = document.querySelector(
                '.terminal-list-main[data-terminal-session="' +
                  CSS.escape(successor.dataset.terminalSession) + '"]'
              )?.closest('.terminal-list-row');
              const close = row?.querySelector('.terminal-close-button');
              if (!(close instanceof HTMLButtonElement)) {
                return reject(new Error('split terminal close action missing'));
              }
              close.click();
              return resolve('existing split owner');
            }
            if (Date.now() > deadline) {
              return reject(new Error('Split Terminal did not create the other pane'));
            }
            setTimeout(poll, 25);
          };
          poll();
        });
      `,
        ),
      ),
      'terminal Split menu action timed out',
      7_000,
    )) as string
    await waitForTerminalCount(supervisor, win.webContents.id, 1)

    const retained = supervisor
      .list()
      .filter((candidate) => candidate.ownerId === win.webContents.id)
    if (
      retained.length !== 1 ||
      retained[0]?.id !== terminal.id ||
      retained[0]?.instanceId !== terminal.instanceId
    ) {
      throw new Error('terminal menu actions replaced or restarted the owning PTY')
    }

    return `${pointerAndKeyboard} · no PTY menu bytes · ${settings} · ${paste} · ${split} · retained Canvas and PTY`
  } finally {
    void detach()
  }
}

function menuActionScript(label: string, accepted: string): string {
  return `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 6000;
      const retained = window.__hvirSmokeContextMenu;
      const engine = retained?.engine;
      if (!(engine instanceof HTMLElement)) {
        return reject(new Error('retained terminal menu owner missing'));
      }
      engine.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 24,
        button: 2
      }));
      const poll = () => {
        const action = [...document.querySelectorAll(
          '.terminal-context-menu [role="menuitem"]'
        )].find((entry) => entry.textContent?.trim() === ${JSON.stringify(label)});
        if (action instanceof HTMLButtonElement && !action.disabled) {
          action.click();
          const awaitDismissal = () => {
            if (document.querySelector('.terminal-context-menu')) {
              if (Date.now() > deadline) {
                return reject(new Error(
                  ${JSON.stringify(label)} + ' menu action did not settle'
                ));
              }
              setTimeout(awaitDismissal, 20);
              return;
            }
            try {
              Promise.resolve((() => { ${accepted} })()).then(resolve, reject);
            } catch (error) {
              reject(error);
            }
          };
          awaitDismissal();
          return;
        }
        if (Date.now() > deadline) {
          return reject(new Error(${JSON.stringify(label)} + ' menu action unavailable'));
        }
        setTimeout(poll, 20);
      };
      poll();
    })
  `
}

function containsOutputLine(output: string, marker: string): boolean {
  return output.replaceAll('\r', '').split('\n').includes(marker)
}

async function waitForOutput(
  predicate: () => boolean,
  failure: string,
  timeoutMs = 5_000,
): Promise<void> {
  await withTerminalSmokeTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (predicate()) return resolve()
        setTimeout(poll, 25)
      }
      poll()
    }),
    failure,
    timeoutMs,
  )
}

async function waitForClipboard(
  predicate: (value: string) => boolean,
  failure: string,
): Promise<void> {
  await withTerminalSmokeTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (predicate(clipboard.readText())) return resolve()
        setTimeout(poll, 25)
      }
      poll()
    }),
    failure,
  )
}

async function waitForTerminalCount(
  supervisor: PtySupervisor,
  ownerId: number,
  expected: number,
): Promise<void> {
  await withTerminalSmokeTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (
          supervisor.list().filter((candidate) => candidate.ownerId === ownerId)
            .length === expected
        ) {
          return resolve()
        }
        setTimeout(poll, 25)
      }
      poll()
    }),
    `terminal count did not return to ${expected}`,
  )
}
