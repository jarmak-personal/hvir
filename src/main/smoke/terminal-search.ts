import { clipboard, type BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

const READY = '__HVIR_SEARCH_READY__'
const MATCH = 'hvir-search-match'

/** Prove selected-terminal search and exact copy against the real Canvas and PTY. */
export async function verifyTerminalSearch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const sessionId = (await win.webContents.executeJavaScript(`
    document.querySelector('.terminal-surface.active')?.dataset.terminalSession || ''
  `)) as string
  const terminal = supervisor
    .list()
    .find(
      (candidate) =>
        candidate.id === sessionId && candidate.ownerId === win.webContents.id,
    )
  if (!terminal) throw new Error('terminal search has no selected live PTY')
  const instanceId = terminal.instanceId
  let output = ''
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-32_768)
    },
  })
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `hvir_search_ready='__HVIR_SEARCH_''READY__'; ` +
        `hvir_search_match='hvir-search-''match'; ` +
        `printf '\\n%s\\n%s\\n%s\\n%s\\n' "$hvir_search_match" ` +
        `"$hvir_search_match" "$hvir_search_match" "$hvir_search_ready"\n`,
    )
    await waitFor(() => output.includes(READY), 'terminal search fixture did not settle')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    clipboard.clear()
    win.focus()
    win.webContents.focus()
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    const result = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 8000;
          const fail = (message) => reject(new Error(message));
          const poll = (predicate, message, next) => {
            const value = predicate();
            if (value) return next(value);
            if (Date.now() > deadline) return fail(message);
            setTimeout(() => poll(predicate, message, next), 20);
          };
          const surface = document.querySelector(
            '.terminal-surface.active[data-terminal-session=' + JSON.stringify(${JSON.stringify(
              sessionId,
            )}) + ']'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const container = surface?.querySelector('.terminal-container');
          if (
            !(surface instanceof HTMLElement) ||
            !(engine instanceof HTMLElement) ||
            !(canvas instanceof HTMLCanvasElement) ||
            !(container instanceof HTMLElement)
          ) return fail('terminal search fixtures missing');
          const selection = document.getSelection()?.toString() || '';
          const openPointerMenu = () => {
            canvas.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 24,
              clientY: 24,
              button: 2,
              buttons: 2
            }));
          };
          openPointerMenu();
          poll(
            () => [...document.querySelectorAll('.terminal-context-menu [role="menuitem"]')]
              .find((button) => button.textContent?.trim() === 'Search Terminal…'),
            'Search Terminal context action missing',
            (searchAction) => {
              searchAction.click();
              poll(
                () => surface.querySelector('.terminal-search'),
                'context action did not open terminal search',
                (contextSearch) => {
                  const close = contextSearch.querySelector(
                    'button[aria-label="Close terminal search"]'
                  );
                  if (!(close instanceof HTMLButtonElement)) {
                    return fail('terminal search close action missing');
                  }
                  close.click();
                  poll(
                    () => !surface.querySelector('.terminal-search'),
                    'context-opened terminal search did not close',
                    () => {
                      const primary = /Mac/.test(navigator.platform)
                        ? { metaKey: true }
                        : { ctrlKey: true };
                      const shortcut = new KeyboardEvent('keydown', {
                        key: 'f',
                        code: 'KeyF',
                        ...primary,
                        bubbles: true,
                        cancelable: true
                      });
                      engine.dispatchEvent(shortcut);
                      if (!shortcut.defaultPrevented) {
                        return fail('terminal-focused Mod+F was not claimed');
                      }
                      poll(
                        () => surface.querySelector('.terminal-search'),
                        'terminal-focused shortcut did not open search',
                        (search) => {
                          const input = search.querySelector('[aria-label="Find in terminal"]');
                          if (!(input instanceof HTMLInputElement)) {
                            return fail('terminal search query input missing');
                          }
                          input.focus();
                          const setter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype,
                            'value'
                          )?.set;
                          setter?.call(input, ${JSON.stringify(MATCH)});
                          input.dispatchEvent(new Event('input', { bubbles: true }));
                          poll(
                            () => search.querySelector('.terminal-search-status')
                              ?.textContent?.trim() === '1 of 3',
                            'terminal search did not publish three exact matches',
                            () => {
                              const next = search.querySelector(
                                'button[aria-label="Next terminal match"]'
                              );
                              const previous = search.querySelector(
                                'button[aria-label="Previous terminal match"]'
                              );
                              if (
                                !(next instanceof HTMLButtonElement) ||
                                !(previous instanceof HTMLButtonElement)
                              ) return fail('terminal search navigation actions missing');
                              next.click();
                              poll(
                                () => search.querySelector('.terminal-search-status')
                                  ?.textContent?.trim() === '2 of 3',
                                'terminal search next navigation failed',
                                () => {
                                  previous.click();
                                  poll(
                                    () => search.querySelector('.terminal-search-status')
                                      ?.textContent?.trim() === '1 of 3',
                                    'terminal search previous navigation failed',
                                    () => {
                                      const copy = [...search.querySelectorAll('button')].find(
                                        (button) => button.textContent?.trim() === 'Copy Match'
                                      );
                                      if (!(copy instanceof HTMLButtonElement)) {
                                        return fail('Copy Match action missing');
                                      }
                                      copy.click();
                                      poll(
                                        () => search.querySelector('.terminal-search-feedback')
                                          ?.textContent?.trim(),
                                        'Copy Match did not report feedback',
                                        (feedback) => {
                                          if (feedback !== 'Copied match.') {
                                            return fail('Copy Match failed: ' + feedback);
                                          }
                                          if (
                                            surface.querySelector('.terminal-engine-host') !== engine ||
                                            engine.querySelector('canvas') !== canvas ||
                                            (document.getSelection()?.toString() || '') !== selection
                                          ) {
                                            return fail(
                                              'terminal search replaced Canvas or mutated selection'
                                            );
                                          }
                                          resolve('context + Mod+F · next/previous · Copy Match');
                                        }
                                      );
                                    }
                                  );
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        })
      `),
      'terminal search Electron proof timed out',
      10_000,
    )) as string
    if (clipboard.readText() !== MATCH) {
      throw new Error(
        `Copy Match was not exact plain text: ${JSON.stringify(clipboard.readText())}`,
      )
    }

    clipboard.clear()
    await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const search = document.querySelector('.terminal-surface.active .terminal-search');
            const copy = search && [...search.querySelectorAll('button')].find(
              (button) => button.textContent?.trim() === 'Copy Region'
            );
            if (copy instanceof HTMLButtonElement && !copy.disabled) {
              copy.click();
              const waitForCopy = () => {
                const feedback = search.querySelector('.terminal-search-feedback')
                  ?.textContent?.trim();
                if (feedback === 'Copied terminal region.') {
                  const close = search.querySelector(
                    'button[aria-label="Close terminal search"]'
                  );
                  if (!(close instanceof HTMLButtonElement)) {
                    return reject(new Error('terminal search close action disappeared'));
                  }
                  close.click();
                  const waitForClose = () => {
                    if (!document.querySelector(
                      '.terminal-surface.active .terminal-search'
                    )) return resolve(undefined);
                    if (Date.now() > deadline) {
                      return reject(new Error('terminal search did not close after region copy'));
                    }
                    setTimeout(waitForClose, 20);
                  };
                  return waitForClose();
                }
                if (Date.now() > deadline) {
                  return reject(new Error('Copy Region did not report success: ' + feedback));
                }
                setTimeout(waitForCopy, 20);
              };
              return waitForCopy();
            }
            if (Date.now() > deadline) {
              return reject(new Error('Copy Region action unavailable'));
            }
            setTimeout(poll, 20);
          };
          poll();
        })
      `),
      'terminal semantic region copy timed out',
      7_000,
    )
    if (clipboard.readText() !== 'output\n') {
      throw new Error(
        `Copy Region was not exact plain text: ${JSON.stringify(clipboard.readText())}`,
      )
    }
    const retained = supervisor.list().find((candidate) => candidate.id === terminal.id)
    if (!retained || retained.instanceId !== instanceId) {
      throw new Error('terminal search replaced the supervised PTY')
    }
    return `${result} · Copy Region · retained Canvas and PTY`
  } finally {
    await detach()
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}
