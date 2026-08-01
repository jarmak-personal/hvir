import { clipboard, type BrowserWindow } from 'electron'

import { joinHostPath, type HostPath, type ProjectState } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { focusTerminalEngine } from './terminal-focus-presentation'

export interface RichOutputSmokeContext {
  readonly terminalId: string
  readonly harnessSessionId: string
  readonly resources: RendererResourceScopes
  readonly connectedState: ProjectState
  readonly disconnectedState: ProjectState
  readonly emitProjectState: (state: ProjectState) => void
}

export async function waitForRichOutputPilot(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  context: RichOutputSmokeContext,
): Promise<string> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(context.terminalId)};
        const deadline = Date.now() + 10000;
        let selected = false;
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          if (surface) return resolve(true);
          const checkbox = document.querySelector(
            'input[aria-label="Restore Rich output smoke"]'
          );
          const restore = [...document.querySelectorAll(
            '.terminal-recovery-dialog button'
          )].find((candidate) => candidate.textContent?.trim() === 'Restore selected');
          if (
            checkbox instanceof HTMLInputElement &&
            restore instanceof HTMLButtonElement &&
            !checkbox.disabled
          ) {
            if (!checkbox.checked && !selected) {
              selected = true;
              checkbox.click();
              return setTimeout(poll, 25);
            }
            if (checkbox.checked && !restore.disabled) {
              restore.click();
              return resolve(true);
            }
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'rich output recovery choice did not become available: ' +
              JSON.stringify({
                checkbox: Boolean(checkbox),
                disabled: checkbox?.disabled,
                restore: Boolean(restore),
                restoreDisabled: restore?.disabled
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'rich output recovery selection timed out',
    12_000,
  )
  await withTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        const terminal = supervisor
          .list()
          .find((candidate) => candidate.id === context.terminalId)
        if (
          terminal?.harnessSessionId === context.harnessSessionId &&
          terminal.identityStatus === 'identified' &&
          terminal.capabilities.assistantOutput === 'structured'
        ) {
          return resolve()
        }
        setTimeout(poll, 25)
      }
      poll()
    }),
    'rich output pilot did not start with an admitted source',
    20_000,
  )
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(context.terminalId)};
        const deadline = Date.now() + 10000;
        let settingsOpened = false;
        let preferenceSelected = false;
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const status = surface?.getAttribute('data-terminal-status') || '';
          if (!settingsOpened) {
            const settings = document.querySelector('button[aria-label="Open settings"]');
            if (
              surface instanceof HTMLElement &&
              !surface.querySelector('.terminal-rich-control') &&
              status.startsWith('Resumed · pid ') &&
              settings instanceof HTMLButtonElement
            ) {
              settingsOpened = true;
              settings.click();
              return setTimeout(poll, 25);
            }
          } else {
            const checkbox = document.querySelector('#settings-rich-output');
            const save = [...document.querySelectorAll('button')].find(
              (candidate) => candidate.textContent?.trim() === 'Save app settings'
            );
            if (
              checkbox instanceof HTMLInputElement &&
              save instanceof HTMLButtonElement
            ) {
              if (!checkbox.checked && !preferenceSelected) {
                preferenceSelected = true;
                checkbox.click();
                return setTimeout(poll, 25);
              }
              if (checkbox.checked) {
                save.click();
                return setTimeout(poll, 25);
              }
            }
            if (
              preferenceSelected &&
              !document.querySelector('.settings-dialog') &&
              surface?.getAttribute('data-rich-output') === 'on'
            ) {
              return resolve(true);
            }
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'rich output Appearance preference did not become active: ' +
              JSON.stringify({
                surface: Boolean(surface),
                settingsOpened,
                preferenceSelected,
                settings: Boolean(document.querySelector('.settings-dialog')),
                mode: surface?.getAttribute('data-rich-output'),
                status,
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'rich output Appearance preference timed out',
    12_000,
  )
  return 'eligible 0.146.x pilot · default-off Appearance preference · no terminal control'
}

export async function verifyVisibleRichOutput(options: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly root: HostPath
  readonly context: RichOutputSmokeContext
}): Promise<string> {
  const { win, supervisor, root, context } = options
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.id === context.terminalId)
  if (!terminal) throw new Error('rich output pilot disappeared before presentation')
  let probe = ''
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      probe = (probe + data).slice(-8_192)
    },
  })
  try {
    await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const sessionId = ${JSON.stringify(context.terminalId)};
          const deadline = Date.now() + 5000;
          const poll = () => {
            const surface = document.querySelector(
              '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
            );
            if (surface?.getAttribute('data-rich-output') === 'on') {
              return resolve(true);
            }
            if (Date.now() > deadline) {
              return reject(new Error('rich output source did not accept enabled mode'));
            }
            setTimeout(poll, 25);
          };
          poll();
        })
      `),
      'rich output Appearance preference acknowledgement timed out',
      7_000,
    )

    await focusTerminalEngine(win, terminal.id)
    for (const keyCode of ['P', 'I', 'L', 'O', 'T']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (probe.includes('input:pilot')) return resolve()
          setTimeout(poll, 25)
        }
        poll()
      }),
      `rich output pilot lost native input: ${JSON.stringify(probe)}`,
      5_000,
    )

    supervisor.write(terminal.id, terminal.ownerId, 'render-rich\n')
    const result = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const sessionId = ${JSON.stringify(context.terminalId)};
          const deadline = Date.now() + 7000;
          let progressive = false;
          const poll = () => {
            const surface = document.querySelector(
              '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
            );
            const message = surface?.querySelector('.terminal-rich-message');
            const heading = message?.querySelector('.terminal-rich-row.heading');
            if (
              message?.getAttribute('data-rich-message-state') === 'streaming' &&
              heading?.textContent?.includes('Progressive smoke')
            ) {
              progressive = true;
            }
            const copy = [...(surface?.querySelectorAll(
              '.terminal-rich-copy-target'
            ) || [])].find((candidate) =>
              candidate.getAttribute('aria-label')?.includes('package.json')
            );
            if (
              progressive &&
              message?.getAttribute('data-rich-message-state') === 'ended' &&
              copy instanceof HTMLButtonElement
            ) {
              copy.click();
              return resolve({
                rows: message.querySelectorAll('.terminal-rich-row').length,
                plainText: message.textContent || ''
              });
            }
            if (Date.now() > deadline) {
              return reject(new Error(
                'rich output did not render progressively and complete: ' +
                JSON.stringify({
                  progressive,
                  state: message?.getAttribute('data-rich-message-state'),
                  text: message?.textContent,
                  copy: Boolean(copy)
                })
              ));
            }
            setTimeout(poll, 20);
          };
          poll();
        })
      `),
      'progressive rich output timed out',
      9_000,
    )) as { readonly rows: number; readonly plainText: string }
    const expectedTarget = `${root.hostId}:${joinHostPath(root, 'package.json').path}`
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (clipboard.readText() === expectedTarget) return resolve()
          setTimeout(poll, 25)
        }
        poll()
      }),
      `rich output copy target mismatch: ${JSON.stringify(clipboard.readText())}`,
      3_000,
    )
    const retained = supervisor
      .list()
      .find((candidate) => candidate.id === context.terminalId)
    if (
      retained?.instanceId !== terminal.instanceId ||
      !result.plainText.includes('Progressive smoke') ||
      result.rows < 2
    ) {
      throw new Error('rich output changed the pilot session or lost rendered structure')
    }
    return 'progressive rows before completion · native keyboard input · copy target'
  } finally {
    void detach()
  }
}

export async function verifyHiddenRichOutput(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  richTerminalId: string,
  shellTerminalId: string,
): Promise<string> {
  const terminal = supervisor.list().find((candidate) => candidate.id === richTerminalId)
  if (!terminal) throw new Error('hidden rich output pilot was not supervised')
  supervisor.write(terminal.id, terminal.ownerId, 'render-rich-hidden\n')
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const richId = ${JSON.stringify(richTerminalId)};
        const shellId = ${JSON.stringify(shellTerminalId)};
        const deadline = Date.now() + 8000;
        let advancedWhileHidden = false;
        const fail = (message) => reject(new Error(message));
        const pollHidden = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(richId) + '"]'
          );
          const lane = surface?.querySelector('.terminal-rich-lane');
          const messages = surface?.querySelectorAll('.terminal-rich-message');
          const row = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(richId) + '"]'
          )?.closest('.terminal-list-row');
          if (
            surface instanceof HTMLElement &&
            !surface.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'hidden' &&
            lane instanceof HTMLElement &&
            lane.hidden &&
            messages?.length === 2 &&
            lane.textContent.includes('Hidden rich smoke') &&
            !row?.querySelector('.terminal-attention-badge')
          ) {
            advancedWhileHidden = true;
            row?.querySelector('.terminal-list-main')?.click();
            return pollReveal();
          }
          if (Date.now() > deadline) {
            return fail('rich output did not advance while hidden');
          }
          setTimeout(pollHidden, 25);
        };
        const pollReveal = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(richId) + '"]'
          );
          const lane = surface?.querySelector('.terminal-rich-lane');
          if (
            advancedWhileHidden &&
            surface?.classList.contains('active') &&
            lane instanceof HTMLElement &&
            !lane.hidden &&
            lane.textContent.includes('retained while hidden')
          ) {
            document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(shellId) + '"]'
            )?.click();
            return pollShell();
          }
          if (Date.now() > deadline) return fail('hidden rich output did not reveal');
          setTimeout(pollReveal, 25);
        };
        const pollShell = () => {
          const shell = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(shellId) + '"]'
          );
          if (shell?.classList.contains('active')) {
            return resolve('hidden advance + reveal without attention');
          }
          if (Date.now() > deadline) return fail('shell did not regain active state');
          setTimeout(pollShell, 25);
        };
        pollHidden();
      })
    `),
    'hidden rich output presentation timed out',
    10_000,
  )) as string
}

export async function verifyRichOutputReconnect(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  context: RichOutputSmokeContext,
): Promise<string> {
  const before = supervisor
    .list()
    .find((candidate) => candidate.id === context.terminalId)
  if (!before) throw new Error('rich output reconnect pilot was not supervised')
  await context.resources.revokeWorkspace(context.connectedState.root)
  context.emitProjectState(context.disconnectedState)
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(context.terminalId)};
        const deadline = Date.now() + 5000;
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const container = surface?.querySelector('.terminal-container');
          if (
            surface?.getAttribute('data-terminal-status') === 'disconnected' &&
            container?.childElementCount === 0 &&
            surface.getAttribute('data-rich-output') === 'waiting' &&
            !surface.querySelector('.terminal-rich-message')
          ) {
            return resolve(true);
          }
          if (Date.now() > deadline) {
            return reject(new Error('rich output did not reset on disconnect'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'rich output disconnect reset timed out',
    7_000,
  )
  context.emitProjectState(context.connectedState)
  await withTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        const current = supervisor
          .list()
          .find((candidate) => candidate.id === context.terminalId)
        if (
          current &&
          current.instanceId !== before.instanceId &&
          current.capabilities.assistantOutput === 'structured' &&
          current.identityStatus === 'identified'
        ) {
          return resolve()
        }
        setTimeout(poll, 25)
      }
      poll()
    }),
    'rich output pilot did not resume after reconnect',
    20_000,
  )
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(context.terminalId)};
        const deadline = Date.now() + 10000;
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const status = surface?.getAttribute('data-terminal-status') || '';
          if (
            status.startsWith('Resumed · pid ') &&
            surface?.getAttribute('data-rich-output') === 'on' &&
            !surface.querySelector('.terminal-rich-message')
          ) {
            return resolve(true);
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'rich output reconnect revived content or lost the Appearance preference: ' +
              JSON.stringify({
                status,
                mode: surface?.getAttribute('data-rich-output'),
                messages: surface?.querySelectorAll('.terminal-rich-message').length
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'rich output reconnect presentation timed out',
    12_000,
  )
  return 'reconnect generation · no replay · Appearance preference reapplied'
}

export async function verifyRichOutputFallback(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  richTerminalId: string,
  shellTerminalId: string,
): Promise<string> {
  const terminal = supervisor.list().find((candidate) => candidate.id === richTerminalId)
  if (!terminal) throw new Error('native fallback pilot was not supervised')
  const baseline = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const richId = ${JSON.stringify(richTerminalId)};
        const deadline = Date.now() + 8000;
        let settingsOpened = false;
        let preferenceCleared = false;
        const poll = () => {
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(richId) + '"]'
          );
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(richId) + '"]'
          );
          if (!surface?.classList.contains('active')) {
            if (button instanceof HTMLButtonElement) {
              button.click();
              return setTimeout(poll, 25);
            }
          } else if (!settingsOpened) {
            const settings = document.querySelector('button[aria-label="Open settings"]');
            if (
              surface.getAttribute('data-rich-output') === 'on' &&
              settings instanceof HTMLButtonElement
            ) {
              settingsOpened = true;
              settings.click();
              return setTimeout(poll, 25);
            }
          } else if (!preferenceCleared) {
            const checkbox = document.querySelector('#settings-rich-output');
            const save = [...document.querySelectorAll('button')].find(
              (candidate) => candidate.textContent?.trim() === 'Save app settings'
            );
            if (
              checkbox instanceof HTMLInputElement &&
              checkbox.checked &&
              save instanceof HTMLButtonElement
            ) {
              preferenceCleared = true;
              checkbox.click();
              save.click();
              return setTimeout(poll, 25);
            }
          }
          const container = surface?.querySelector('.terminal-container');
          const delivery = container?.__hvirTerminalDelivery;
          if (
            preferenceCleared &&
            !document.querySelector('.settings-dialog') &&
            surface?.getAttribute('data-rich-output') === 'off' &&
            delivery
          ) {
            return resolve({
              bytes: delivery.deliveredBytes,
              messages: surface.querySelectorAll('.terminal-rich-message').length
            });
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'fallback Appearance preference did not disable rich output: ' +
              JSON.stringify({
                active: surface?.classList.contains('active'),
                settingsOpened,
                preferenceCleared,
                settings: Boolean(document.querySelector('.settings-dialog')),
                mode: surface?.getAttribute('data-rich-output')
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'rich output fallback transition timed out',
    10_000,
  )) as { readonly bytes: number; readonly messages: number }

  supervisor.write(terminal.id, terminal.ownerId, 'render-native\n')
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const richId = ${JSON.stringify(richTerminalId)};
        const shellId = ${JSON.stringify(shellTerminalId)};
        const beforeBytes = ${JSON.stringify(baseline.bytes)};
        const beforeMessages = ${JSON.stringify(baseline.messages)};
        const deadline = Date.now() + 7000;
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(richId) + '"]'
          );
          const container = surface?.querySelector('.terminal-container');
          const delivery = container?.__hvirTerminalDelivery;
          const messages = surface?.querySelectorAll('.terminal-rich-message').length;
          if (
            delivery?.deliveredBytes > beforeBytes &&
            messages === beforeMessages
          ) {
            document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(shellId) + '"]'
            )?.click();
            return resolve(true);
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'disabled assistant item did not return to native delivery: ' +
              JSON.stringify({
                beforeBytes,
                bytes: delivery?.deliveredBytes,
                beforeMessages,
                messages
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'native assistant fallback timed out',
    9_000,
  )
  const retained = supervisor.list().find((candidate) => candidate.id === richTerminalId)
  if (retained?.instanceId !== terminal.instanceId) {
    throw new Error('rich output transition replaced the pilot PTY')
  }
  return 'disable boundary · unchanged PTY · later assistant item native'
}

export async function waitForTerminalRemoval(
  supervisor: PtySupervisor,
  sessionId: string,
): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (!supervisor.list().some((candidate) => candidate.id === sessionId)) {
          return resolve()
        }
        setTimeout(poll, 25)
      }
      poll()
    }),
    `terminal '${sessionId}' was not removed`,
    5_000,
  )
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
