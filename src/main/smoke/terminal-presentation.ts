import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'

/** Retain broad terminal presentation assertions only in the legacy workflow. */
export async function verifyLegacyTerminalPresentation(
  win: BrowserWindow,
): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const host = document.querySelector('.terminal-container');
      if (!(host instanceof HTMLElement)) throw new Error('terminal container missing');
      const inputHost = host.querySelector(':scope > .terminal-engine-host');
      if (!(inputHost instanceof HTMLElement)) throw new Error('terminal input host missing');
      const panel = host.closest('.terminal-panel');
      if (!(panel instanceof HTMLElement)) throw new Error('terminal panel missing');
      if (panel.querySelector(':scope > .panel-header')) {
        throw new Error('redundant terminal header is still mounted');
      }
      if (Math.abs(panel.getBoundingClientRect().top - host.getBoundingClientRect().top) > 1) {
        throw new Error('terminal canvas does not begin at the deck edge');
      }
      const rail = document.querySelector('.terminal-rail');
      if (!(rail instanceof HTMLElement)) throw new Error('terminal rail missing');
      if (parseFloat(getComputedStyle(rail).borderLeftWidth) !== 0) {
        throw new Error('terminal rail divider cannot open at the active entry');
      }
      const activeRow = rail.querySelector('.terminal-list-row.active');
      if (!(activeRow instanceof HTMLElement)) throw new Error('active terminal row missing');
      if (parseFloat(getComputedStyle(activeRow).borderTopLeftRadius) !== 0) {
        throw new Error('active terminal row still narrows its opening');
      }
      const activeBackground = getComputedStyle(activeRow).backgroundImage;
      if (!activeBackground.includes('linear-gradient') || !activeBackground.includes('80%')) {
        throw new Error('active terminal entry does not blend into the canvas');
      }
      inputHost.focus();
      const caret = getComputedStyle(inputHost).caretColor;
      if (caret !== 'transparent' && caret !== 'rgba(0, 0, 0, 0)') {
        throw new Error('browser caret is visible in terminal input host: ' + caret);
      }
      return 'headerless · canvas cursor only · flush active rail';
    })()
  `)) as string
}

export async function verifyTerminalPresentationLifecycle(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  launchMenuOverflowRoot?: HostPath,
): Promise<string> {
  const layoutFocusStatus = await verifyTerminalLayoutFocus(win)
  const launchMenuStatus = launchMenuOverflowRoot
    ? await verifyTerminalLaunchMenuOverflow(win, launchMenuOverflowRoot)
    : undefined
  const switchStatus = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        let menuOpened = false;
        const waitForSecond = () => {
          const rows = [...document.querySelectorAll('.terminal-list-row')];
          const surfaces = [...document.querySelectorAll('.terminal-surface')];
          const active = document.querySelector('.terminal-surface.active');
          const status = active?.getAttribute('data-terminal-status') || '';
          if (rows.length === 2 && surfaces.length === 2 && status.startsWith('pid ')) {
            const visible = surfaces.filter(
              (surface) => getComputedStyle(surface).visibility === 'visible'
            );
            if (visible.length !== 1 || visible[0] !== active) {
              return reject(new Error('terminal selection did not isolate one canvas'));
            }
            rows[0]?.querySelector('.terminal-list-main')?.click();
            const waitForSwitch = () => {
              if (document.querySelector('.terminal-list-row.active') === rows[0]) {
                return resolve('2 live canvases · switch');
              }
              if (Date.now() > deadline) {
                return reject(new Error('terminal selection did not switch'));
              }
              setTimeout(waitForSwitch, 25);
            };
            return waitForSwitch();
          }
          if (Date.now() > deadline) return reject(new Error(
            'second terminal did not start: rows=' + rows.length +
            ' surfaces=' + surfaces.length + ' status=' + status
          ));
          setTimeout(waitForSecond, 25);
        };
        const waitForMenu = () => {
          const add = document.querySelector('button[aria-label="New terminal"]');
          if (!menuOpened && add && !add.disabled) {
            add.click();
            menuOpened = true;
          }
          const shell = [...document.querySelectorAll('.terminal-new-menu button')]
            .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell');
          if (shell) {
            shell.click();
            return waitForSecond();
          }
          if (Date.now() > deadline) return reject(new Error('new-terminal menu did not open'));
          setTimeout(waitForMenu, 25);
        };
        waitForMenu();
      })
    `),
    'multi-terminal interaction timed out',
    10_000,
  )) as string
  const secondTerminal = supervisor
    .list()
    .filter((terminal) => terminal.ownerId === win.webContents.id)[1]
  if (!secondTerminal) throw new Error('second terminal was not registered')

  supervisor.write(
    secondTerminal.id,
    secondTerminal.ownerId,
    "printf '\\033[41m\\033[2J\\033[Hhidden-buffer\\033[0m\\033]0;Hidden buffered\\007\\007'; IFS= read -r hvir_input; printf 'input:%s\\n' \"$hvir_input\"; sleep 10\n",
  )
  const revealStatus = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(secondTerminal.id)};
        const deadline = Date.now() + 5000;
        const fail = (message) => reject(new Error(message));
        const waitForHiddenOutput = () => {
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const row = button?.closest('.terminal-list-row');
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const title = row?.querySelector('.terminal-list-title')?.textContent || '';
          const bell = row?.querySelector('.terminal-attention-badge.bell');
          const engine = surface?.querySelector('.terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          if (
            button && row && surface && title === 'Hidden buffered' && bell &&
            getComputedStyle(surface).visibility === 'hidden' && stats &&
            stats.paused && !stats.pendingFrame && stats.parsedWrites > 0
          ) {
            const hiddenFrames = stats.renderFrames;
            const hiddenFullFrames = stats.fullRenderFrames;
            return setTimeout(() => {
              const settled = engine.__hvirTerminalPerformance;
              if (
                settled.renderFrames !== hiddenFrames ||
                !settled.paused ||
                settled.pendingFrame
              ) {
                return fail('hidden terminal continued presentation work');
              }
              button.click();
              waitForReveal(surface, row, hiddenFullFrames);
            }, 650);
          }
          if (Date.now() > deadline) {
            return fail('hidden terminal output did not settle: title=' + title +
              ' bell=' + Boolean(bell) + ' surface=' + Boolean(surface));
          }
          setTimeout(waitForHiddenOutput, 25);
        };
        const waitForReveal = (surface, row, hiddenFullFrames) => {
          const canvas = surface.querySelector('canvas');
          const context = canvas?.getContext('2d');
          const stats = surface.querySelector('.terminal-engine-host')
            ?.__hvirTerminalPerformance;
          const pixel = canvas && context
            ? context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1
              ).data
            : undefined;
          if (
            row.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'visible' &&
            pixel && pixel[0] > 120 && pixel[1] < 160 && stats &&
            !stats.paused && !stats.pendingFrame
          ) {
            if (stats.fullRenderFrames - hiddenFullFrames !== 1) {
              return fail(
                'terminal reveal full repaint count was ' +
                (stats.fullRenderFrames - hiddenFullFrames)
              );
            }
            return resolve('hidden output + current repaint');
          }
          if (Date.now() > deadline) {
            return fail('revealed terminal did not repaint its hidden buffer');
          }
          setTimeout(() => waitForReveal(surface, row, hiddenFullFrames), 25);
        };
        waitForHiddenOutput();
      })
    `),
    'hidden terminal reveal timed out',
  )) as string

  let inputProbe = ''
  const detachInputProbe = supervisor.attach(secondTerminal.id, secondTerminal.ownerId, {
    onData: (data) => {
      inputProbe = (inputProbe + data).slice(-4_096)
    },
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  const cursorStatus = await verifyActiveCursorCadence(win, secondTerminal.id)
  for (const keyCode of ['H', 'V', 'I', 'R']) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (inputProbe.includes('input:hvir')) return resolve()
          setTimeout(poll, 25)
        }
        poll()
      }),
      `revealed terminal input was not echoed: ${JSON.stringify(inputProbe)}`,
      5_000,
    )
  } finally {
    void detachInputProbe()
  }
  const inputStatus = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(secondTerminal.id)};
        const deadline = Date.now() + 5000;
        const poll = () => {
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const row = button?.closest('.terminal-list-row');
          if (row) {
            row.querySelector('.terminal-close-button')?.click();
            return resolve('revealed input echo + close');
          }
          if (Date.now() > deadline) {
            return reject(new Error('revealed terminal row disappeared before close'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'revealed terminal close timed out',
  )) as string

  return [
    layoutFocusStatus,
    launchMenuStatus,
    switchStatus,
    revealStatus,
    cursorStatus,
    inputStatus,
  ]
    .filter((status): status is string => status !== undefined)
    .join(' · ')
}

async function verifyActiveCursorCadence(
  win: BrowserWindow,
  sessionId: string,
): Promise<string> {
  const idleHiddenFrame = await waitForCursorPhase(
    win,
    sessionId,
    false,
    -1,
    'cursor did not enter its idle hidden phase',
  )

  let activeVisibleFrame = idleHiddenFrame
  for (let index = 0; index < 6; index += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
    activeVisibleFrame = await waitForCursorPhase(
      win,
      sessionId,
      true,
      activeVisibleFrame,
      'sustained input did not keep the cursor visible',
    )
    if (index < 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  }
  const resumedHiddenFrame = await waitForCursorPhase(
    win,
    sessionId,
    false,
    activeVisibleFrame,
    'cursor did not resume blinking after input',
  )
  await waitForCursorPhase(
    win,
    sessionId,
    true,
    resumedHiddenFrame,
    'cursor blink cadence did not return to visible',
  )

  // Remove the probe character before the surrounding canonical read submits.
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'U',
    modifiers: ['control'],
  })
  win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'U',
    modifiers: ['control'],
  })
  return 'active cursor + idle blink'
}

async function waitForCursorPhase(
  win: BrowserWindow,
  sessionId: string,
  visible: boolean,
  afterFrame: number,
  failure: string,
): Promise<number> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 2500;
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const stats = surface?.querySelector('.terminal-engine-host')
            ?.__hvirTerminalPerformance;
          if (
            stats && !stats.paused && !stats.pendingFrame &&
            stats.cursorVisible === ${JSON.stringify(visible)} &&
            stats.renderFrames > ${JSON.stringify(afterFrame)}
          ) {
            return resolve(stats.renderFrames);
          }
          if (Date.now() > deadline) {
            return reject(new Error(${JSON.stringify(failure)}));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    failure,
    3_000,
  )) as number
}

async function verifyTerminalLayoutFocus(win: BrowserWindow): Promise<string> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const workbench = document.querySelector('.workbench');
        const maximize = document.querySelector('.terminal-focus-toggle');
        const minimize = document.querySelector('.terminal-collapse-toggle');
        const collapseRail = document.querySelector(
          'button[aria-label="Collapse terminal rail"]'
        );
        const restoreRail = document.querySelector(
          'button[aria-label="Restore terminal rail"]'
        );
        if (
          !(workbench instanceof HTMLElement) ||
          !(maximize instanceof HTMLButtonElement) ||
          !(minimize instanceof HTMLButtonElement) ||
          !(collapseRail instanceof HTMLButtonElement) ||
          !(restoreRail instanceof HTMLButtonElement)
        ) {
          throw new Error('terminal layout focus controls missing');
        }
        const activeInput = () => document.querySelector(
          '.terminal-deck:not([hidden]) .terminal-surface.active .terminal-container'
        );
        const deadline = Date.now() + 12000;
        const waitFor = (read, message) => new Promise((resolve, reject) => {
          const waitDeadline = Date.now() + 4000;
          const poll = () => {
            const value = read();
            if (value) return resolve(value);
            if (Date.now() > waitDeadline) return reject(new Error(message));
            setTimeout(poll, 25);
          };
          poll();
        });
        await new Promise((resolve, reject) => {
          const poll = () => {
            if (activeInput() instanceof HTMLElement) return resolve();
            if (Date.now() > deadline) {
              return reject(new Error('active terminal input did not mount'));
            }
            setTimeout(poll, 25);
          };
          poll();
        });
        const terminalTrack = workbench.style.getPropertyValue('--terminal-track');
        const expectFocused = async (button, expectedMode) => {
          const input = activeInput();
          if (!(input instanceof HTMLElement)) {
            throw new Error('active terminal input missing after ' + expectedMode);
          }
          await new Promise((resolve, reject) => {
            let timer;
            const finish = () => {
              if (timer) clearTimeout(timer);
              input.removeEventListener('focus', finish);
              resolve();
            };
            input.addEventListener('focus', finish);
            timer = setTimeout(() => {
              input.removeEventListener('focus', finish);
              const surface = input.closest('.terminal-surface');
              const container = input.closest('.terminal-container');
              const activeElement = document.activeElement;
              reject(new Error(
                expectedMode + ' layout left focus on ' +
                (activeElement?.className || activeElement?.tagName) +
                ': inputConnected=' + input.isConnected +
                ' inputTabIndex=' + input.tabIndex +
                ' inputEditable=' + input.getAttribute('contenteditable') +
                ' containerFocused=' + (activeElement === container) +
                ' surfaceActive=' + Boolean(surface?.classList.contains('active')) +
                ' surfaceVisible=' + Boolean(surface?.classList.contains('visible')) +
                ' surfaceSession=' + (surface?.getAttribute('data-terminal-session') || '')
              ));
            }, Math.max(0, deadline - Date.now()));
            button.focus();
            button.click();
            if (document.activeElement === input) finish();
          });
          if (workbench.style.getPropertyValue('--terminal-track') !== terminalTrack) {
            throw new Error(expectedMode + ' layout changed the saved terminal track');
          }
        };

        await expectFocused(maximize, 'maximized');
        await expectFocused(maximize, 'restored');
        await expectFocused(minimize, 'collapsed');
        await expectFocused(minimize, 'restored');
        const deck = document.querySelector('.terminal-deck:not([hidden])');
        const rail = document.querySelector('.terminal-rail:not([hidden])');
        const canvas = activeInput()?.querySelector('canvas');
        const add = document.querySelector('button[aria-label="New terminal"]');
        if (
          !(deck instanceof HTMLElement) ||
          !(rail instanceof HTMLElement) ||
          !(canvas instanceof HTMLCanvasElement) ||
          !(add instanceof HTMLButtonElement)
        ) {
          throw new Error('terminal rail compact fixtures missing');
        }
        const deckWidth = deck.getBoundingClientRect().width;
        const canvasWidth = canvas.getBoundingClientRect().width;
        const primaryTrack = deck.style.getPropertyValue('--terminal-primary-track');
        const surfaceState = [...deck.querySelectorAll('.terminal-surface')]
          .map((surface) => [
            surface.getAttribute('data-terminal-session'),
            surface.getAttribute('data-terminal-slot'),
            surface.classList.contains('active'),
            surface.classList.contains('visible')
          ].join(':'))
          .join('|');
        add.click();
        await waitFor(
          () => document.querySelector('.terminal-new-menu'),
          'terminal launch menu did not open before rail collapse'
        );
        await expectFocused(collapseRail, 'compact rail');
        await waitFor(() => {
          const strip = document.querySelector('.terminal-rail-compact-strip');
          return (
            workbench.classList.contains('terminal-rail-compact') &&
            strip instanceof HTMLElement &&
            !strip.hidden &&
            !document.querySelector('.terminal-new-menu') &&
            deck.getBoundingClientRect().width > deckWidth + 100 &&
            canvas.getBoundingClientRect().width > canvasWidth + 100
          );
        }, 'compact terminal rail did not release and refit the terminal width');
        const deckBounds = deck.getBoundingClientRect();
        const railBounds = rail.getBoundingClientRect();
        const restoreBounds = restoreRail.getBoundingClientRect();
        const deckEdgeTarget = document.elementFromPoint(
          deckBounds.right - 2,
          deckBounds.top + deckBounds.height / 2
        );
        if (
          railBounds.left < deckBounds.right - 1 ||
          railBounds.width > 32 ||
          restoreBounds.bottom < railBounds.bottom - 8 ||
          deckEdgeTarget?.closest('.terminal-rail')
        ) {
          throw new Error(
            'compact terminal rail overlaps the deck or misplaces restore: deckRight=' +
            deckBounds.right + ' rail=' + [railBounds.left, railBounds.width].join(',') +
            ' restoreBottom=' + restoreBounds.bottom + ' railBottom=' + railBounds.bottom
          );
        }
        if (
          workbench.style.getPropertyValue('--terminal-track') !== terminalTrack ||
          deck.style.getPropertyValue('--terminal-primary-track') !== primaryTrack ||
          [...deck.querySelectorAll('.terminal-surface')]
            .map((surface) => [
              surface.getAttribute('data-terminal-session'),
              surface.getAttribute('data-terminal-slot'),
              surface.classList.contains('active'),
              surface.classList.contains('visible')
            ].join(':'))
            .join('|') !== surfaceState
        ) {
          throw new Error('compact terminal rail changed terminal layout state');
        }
        await expectFocused(restoreRail, 'restored rail');
        await waitFor(
          () =>
            !workbench.classList.contains('terminal-rail-compact') &&
            Math.abs(deck.getBoundingClientRect().width - deckWidth) <= 1 &&
            Math.abs(canvas.getBoundingClientRect().width - canvasWidth) <= 1,
          'restored terminal rail did not refit the original terminal width'
        );
        if (
          workbench.classList.contains('terminal-focused') ||
          workbench.classList.contains('terminal-collapsed') ||
          workbench.classList.contains('terminal-rail-compact')
        ) {
          throw new Error('terminal layout focus check did not restore split view');
        }
        return 'maximized + collapsed + compact rail refit + restored terminal focus';
      })()
    `),
    'terminal layout focus check timed out',
    10_000,
  )) as string
}

async function verifyTerminalLaunchMenuOverflow(
  win: BrowserWindow,
  root: HostPath,
): Promise<string> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 15000;
        const waitFor = (read, message) => new Promise((resolve, reject) => {
          const poll = () => {
            const value = read();
            if (value) return resolve(value);
            if (Date.now() > deadline) return reject(new Error(message));
            setTimeout(poll, 25);
          };
          poll();
        });
        const add = await waitFor(
          () => document.querySelector('button[aria-label="New terminal"]:not(:disabled)'),
          'new-terminal button unavailable for overflow check'
        );
        add.click();
        const initialMenu = await waitFor(
          () => document.querySelector('.terminal-new-menu'),
          'initial new-terminal menu did not open'
        );
        const initialStyle = getComputedStyle(initialMenu);
        if (initialStyle.overflowY !== 'auto') {
          throw new Error('new-terminal menu does not use conditional vertical overflow');
        }
        if (initialMenu.scrollHeight > initialMenu.clientHeight + 1) {
          throw new Error('new-terminal menu overflows with only the built-in shell');
        }
        add.click();
        await waitFor(
          () => !document.querySelector('.terminal-new-menu'),
          'initial new-terminal menu did not close'
        );

        const root = ${JSON.stringify(root)};
        const profiles = await window.hvir.invoke('harness:profiles', { root });
        const shell = profiles.find((profile) => profile.builtIn);
        if (!shell) throw new Error('built-in shell profile missing');
        const created = await Promise.all(
          Array.from({ length: 24 }, () =>
            window.hvir.invoke('harness:profile-duplicate', { id: shell.id })
          )
        );
        window.dispatchEvent(new Event('hvir:harness-profiles-changed'));
        add.click();
        const menu = await waitFor(() => {
          const candidate = document.querySelector('.terminal-new-menu');
          if (!(candidate instanceof HTMLElement)) return undefined;
          const profileButtons = [...candidate.children].filter(
            (node) => node instanceof HTMLButtonElement
          );
          if (profileButtons.length >= created.length + 1) return candidate;
          return undefined;
        }, 'configured harness profiles did not enter the launch menu');

        const uncheckedProfiles = [...menu.children].filter(
          (node) =>
            node instanceof HTMLButtonElement &&
            node.dataset.harnessAvailability === 'unchecked'
        );
        if (uncheckedProfiles.length < created.length) {
          throw new Error(
            'configured profiles were hidden or checked implicitly: visible unchecked=' +
            uncheckedProfiles.length + ' created=' + created.length
          );
        }
        if (menu.scrollHeight <= menu.clientHeight + 1) {
          throw new Error('configured harness profiles did not overflow the launch menu');
        }
        const bounds = menu.getBoundingClientRect();
        if (
          bounds.top < -1 ||
          bounds.left < -1 ||
          bounds.right > window.innerWidth + 1 ||
          bounds.bottom > window.innerHeight + 1
        ) {
          throw new Error(
            'overflowing launch menu escaped the viewport: bounds=' +
            [bounds.top, bounds.right, bounds.bottom, bounds.left].join(',') +
            ' viewport=' + window.innerWidth + 'x' + window.innerHeight
          );
        }
        const scrollbar = getComputedStyle(menu, '::-webkit-scrollbar');
        const thumb = getComputedStyle(menu, '::-webkit-scrollbar-thumb');
        if (scrollbar.width !== '8px' || thumb.backgroundColor === 'rgba(0, 0, 0, 0)') {
          throw new Error(
            'overflowing launch menu has no visible scrollbar: width=' +
            scrollbar.width + ' thumb=' + thumb.backgroundColor
          );
        }

        menu.scrollTop = menu.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const profileButtons = [...menu.children].filter(
          (node) => node instanceof HTMLButtonElement
        );
        const finalProfile = profileButtons.at(-1);
        const actions = menu.querySelector('.terminal-new-menu-actions');
        if (!(finalProfile instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
          throw new Error('launch menu profile or actions missing after scroll');
        }
        const finalProfileBounds = finalProfile.getBoundingClientRect();
        const actionBounds = actions.getBoundingClientRect();
        if (
          menu.scrollTop <= 0 ||
          finalProfileBounds.top < bounds.top - 1 ||
          finalProfileBounds.bottom > bounds.bottom + 1 ||
          actionBounds.top < bounds.top - 1 ||
          actionBounds.bottom > bounds.bottom + 1
        ) {
          throw new Error('final harness profile and actions are not reachable by scrolling');
        }
        add.click();
        return created.length + ' configured profiles · visible scrollbar · final actions';
      })()
    `),
    'terminal launch menu overflow timed out',
    20_000,
  )) as string
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 8_000,
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
