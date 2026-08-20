import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyTerminalClipboardFilePaste } from './terminal-file-paste'
import { verifyTerminalContextMenu } from './terminal-context-menu'
import { verifyTerminalCursorPresentation } from './terminal-cursor-presentation'
import { verifyTerminalHorizonPresentation } from './terminal-horizon-presentation'
import { verifyHiddenTerminalReveal } from './terminal-hidden-reveal'
import { verifyTerminalLigaturePresentation } from './terminal-ligature-presentation'
import { verifyNegotiatedTerminalKeyboard } from './terminal-keyboard-negotiation'
import { verifyTerminalPalettePresentation } from './terminal-palette-presentation'
import { verifyTerminalProjectReturn } from './terminal-project-return'
import { verifyTerminalSemanticNavigation } from './terminal-semantic-navigation'
import { verifyTerminalSearch } from './terminal-search'
import { verifyTerminalThemeGalleryPresentation } from './terminal-theme-gallery-presentation'
import { verifySynchronizedOutput } from './terminal-synchronized-output'

export async function verifyTerminalPresentationLifecycle(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
  launchMenuOverflowRoot?: HostPath,
): Promise<string> {
  checkpoint('terminal-presentation-explicit-launch-awaiting')
  const explicitLaunch = await ensureExplicitBareShellLaunch(win, supervisor)
  checkpoint('terminal-presentation-explicit-launch-ready')
  checkpoint('terminal-presentation-keyboard-awaiting')
  await verifyNegotiatedTerminalKeyboard(win, supervisor)
  checkpoint('terminal-presentation-keyboard-ready')
  if (launchMenuOverflowRoot) {
    checkpoint('terminal-presentation-file-paste-awaiting')
    await verifyTerminalClipboardFilePaste(win, supervisor, launchMenuOverflowRoot)
    checkpoint('terminal-presentation-file-paste-ready')
  }
  checkpoint('terminal-presentation-palette-awaiting')
  const paletteStatus = await verifyTerminalPalettePresentation(win, supervisor)
  checkpoint('terminal-presentation-palette-ready')
  checkpoint('terminal-presentation-semantic-navigation-awaiting')
  const semanticStatus = await verifyTerminalSemanticNavigation(win, supervisor)
  checkpoint('terminal-presentation-semantic-navigation-ready')
  checkpoint('terminal-presentation-search-awaiting')
  const searchStatus = await verifyTerminalSearch(win, supervisor)
  checkpoint('terminal-presentation-search-ready')
  checkpoint('terminal-presentation-horizon-awaiting')
  const horizonStatus = await verifyTerminalHorizonPresentation(win)
  checkpoint('terminal-presentation-horizon-ready')
  checkpoint('terminal-presentation-layout-focus-awaiting')
  const layoutFocusStatus = await verifyTerminalLayoutFocus(win)
  checkpoint('terminal-presentation-layout-focus-ready')
  checkpoint('terminal-presentation-project-return-awaiting')
  const projectReturnStatus = await verifyTerminalProjectReturn(
    win,
    supervisor,
    launchMenuOverflowRoot
      ? joinHostPath(launchMenuOverflowRoot, '.hvir-smoke-oversized-diff.txt')
      : undefined,
  )
  checkpoint('terminal-presentation-project-return-ready')
  checkpoint('terminal-presentation-launch-menu-awaiting')
  const launchMenuStatus = launchMenuOverflowRoot
    ? await verifyTerminalLaunchMenuOverflow(win, launchMenuOverflowRoot)
    : undefined
  checkpoint('terminal-presentation-launch-menu-ready')
  checkpoint('terminal-presentation-session-switch-awaiting')
  const switchStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        let menuOpened = false;
        const waitForTerminals = () => {
          const rows = [...document.querySelectorAll('.terminal-list-row')];
          const surfaces = [...document.querySelectorAll('.terminal-surface')];
          const active = document.querySelector('.terminal-surface.active');
          const status = active?.getAttribute('data-terminal-status') || '';
          const failure = active?.querySelector('.terminal-recovery-status')
            ?.textContent?.trim();
          if (failure) return reject(new Error('terminal session launch failed: ' + failure));
          if (rows.length === 3 && surfaces.length === 3 && status.startsWith('pid ')) {
            const visible = surfaces.filter(
              (surface) => getComputedStyle(surface).visibility === 'visible'
            );
            if (visible.length !== 1 || visible[0] !== active) {
              return reject(new Error('terminal selection did not isolate one canvas'));
            }
            rows[0]?.querySelector('.terminal-list-main')?.click();
            const waitForSwitch = () => {
              if (document.querySelector('.terminal-list-row.active') === rows[0]) {
                return resolve('3 live canvases · switch');
              }

              setTimeout(waitForSwitch, 25);
            };
            return waitForSwitch();
          }
          const add = document.querySelector('button[aria-label="New terminal"]');
          if (
            !menuOpened && rows.length < 3 && status.startsWith('pid ') &&
            add instanceof HTMLButtonElement && !add.disabled
          ) {
            add.click();
            menuOpened = true;
          }
          const shell = [...document.querySelectorAll('.terminal-new-menu button')]
            .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell');
          if (menuOpened && shell) {
            shell.click();
            menuOpened = false;
          }

          setTimeout(waitForTerminals, 25);
        };
        waitForTerminals();
      })
    `)) as string
  checkpoint('terminal-presentation-session-switch-ready')
  const ownerTerminals = supervisor
    .list()
    .filter((terminal) => terminal.ownerId === win.webContents.id)
  const secondTerminal = ownerTerminals[1]
  const quiescentTerminal = ownerTerminals[2]
  if (!secondTerminal) throw new Error('second terminal was not registered')
  if (!quiescentTerminal) throw new Error('quiescent third terminal was not registered')
  checkpoint('terminal-presentation-synchronized-output-awaiting')
  const synchronizedOutputStatus = await verifySynchronizedOutput(
    win,
    supervisor,
    secondTerminal.id,
  )
  checkpoint('terminal-presentation-synchronized-output-ready')
  checkpoint('terminal-presentation-hidden-reveal-awaiting')
  const revealStatus = await verifyHiddenTerminalReveal(
    win,
    supervisor,
    secondTerminal,
    quiescentTerminal,
  )
  checkpoint('terminal-presentation-hidden-reveal-ready')

  let inputProbe = ''
  let inputExit: string | undefined
  const detachInputProbe = supervisor.attach(secondTerminal.id, secondTerminal.ownerId, {
    onData: (data) => {
      inputProbe = (inputProbe + data).slice(-4_096)
    },
    onExit: (exit) => {
      inputExit = exit.signal ? `signal ${exit.signal}` : `code ${exit.exitCode}`
    },
  })
  checkpoint('terminal-presentation-focus-awaiting')
  await focusTerminalEngine(win, secondTerminal.id)
  checkpoint('terminal-presentation-focus-ready')
  checkpoint('terminal-presentation-cursor-cadence-awaiting')
  const cursorStatus = await verifyActiveCursorCadence(win, secondTerminal.id)
  checkpoint('terminal-presentation-cursor-cadence-ready')
  checkpoint('terminal-presentation-input-awaiting')
  for (const keyCode of ['H', 'V', 'I', 'R']) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  try {
    await new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (inputProbe.includes('input:hvir')) return resolve()
        if (inputExit)
          return reject(new Error(`terminal input PTY exited with ${inputExit}`))
        setTimeout(poll, 25)
      }
      poll()
    })
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; final probe: ${JSON.stringify(inputProbe)}`,
      { cause: error },
    )
  } finally {
    void detachInputProbe()
  }
  const inputStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(secondTerminal.id)};
        let closing = false;
        const poll = () => {
          const rows = [...document.querySelectorAll('.terminal-list-row')];
          if (closing && rows.length === 1) {
            return resolve('revealed input echo + close');
          }
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const row = button?.closest('.terminal-list-row');
          const failure = row?.querySelector('.terminal-recovery-status')
            ?.textContent?.trim();
          if (failure) return reject(new Error('terminal input session failed: ' + failure));
          if (!closing && row) {
            const extra = rows.at(-1);
            if (extra && extra !== row) extra.querySelector('.terminal-close-button')?.click();
            row.querySelector('.terminal-close-button')?.click();
            closing = true;
          }

          setTimeout(poll, 25);
        };
        poll();
      })
    `)) as string
  checkpoint('terminal-presentation-input-ready')
  checkpoint('terminal-presentation-cursor-style-awaiting')
  const cursorPresentationStatus = await verifyTerminalCursorPresentation(win, supervisor)
  checkpoint('terminal-presentation-cursor-style-ready')
  checkpoint('terminal-presentation-ligatures-awaiting')
  const ligaturePresentationStatus = await verifyTerminalLigaturePresentation(
    win,
    supervisor,
  )
  checkpoint('terminal-presentation-ligatures-ready')
  checkpoint('terminal-presentation-context-menu-awaiting')
  const contextMenuStatus = await verifyTerminalContextMenu(win, supervisor)
  checkpoint('terminal-presentation-context-menu-ready')
  checkpoint('terminal-presentation-typography-awaiting')
  const typographyStatus = await verifyLiveTerminalTypography(win, supervisor)
  checkpoint('terminal-presentation-typography-ready')
  checkpoint('terminal-presentation-theme-gallery-awaiting')
  const themeGalleryStatus = await verifyTerminalThemeGalleryPresentation(win, supervisor)
  checkpoint('terminal-presentation-theme-gallery-ready')
  return [
    explicitLaunch,
    paletteStatus,
    semanticStatus,
    searchStatus,
    horizonStatus,
    layoutFocusStatus,
    projectReturnStatus,
    launchMenuStatus,
    switchStatus,
    synchronizedOutputStatus,
    revealStatus,
    cursorStatus,
    inputStatus,
    cursorPresentationStatus,
    ligaturePresentationStatus,
    contextMenuStatus,
    typographyStatus,
    themeGalleryStatus,
  ]
    .filter((status): status is string => status !== undefined)
    .join(' · ')
}

async function verifyLiveTerminalTypography(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('live typography check has no retained terminal')
  let probe = ''
  let expectedSize: { readonly cols: number; readonly rows: number } | undefined
  const observedSizes: Array<{ readonly cols: number; readonly rows: number }> = []
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  let queryCount = 0
  const queryPtySize = (): void => {
    queryCount++
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      "printf '\n__HVIR_TYPO_STTY__:'; stty size; printf ':__HVIR_TYPO_END__\n'\n",
    )
  }
  let resolveResize: () => void = () => undefined
  let typographyTerminalExit: string | undefined
  const resizeObserved = new Promise<void>((resolve) => {
    resolveResize = resolve
  })
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      probe = (probe + data).slice(-8_192)
      const matches = [
        ...probe.matchAll(
          /[\r\n]__HVIR_TYPO_STTY__:[^\d]*(\d+)\s+(\d+)\s*:__HVIR_TYPO_END__/g,
        ),
      ]
      const latest = matches.at(-1)
      if (!latest) return
      const observed = { rows: Number(latest[1]), cols: Number(latest[2]) }
      if (
        !observedSizes.some(
          ({ rows, cols }) => rows === observed.rows && cols === observed.cols,
        )
      ) {
        observedSizes.push(observed)
      }
      if (
        expectedSize &&
        observed.rows === expectedSize.rows &&
        observed.cols === expectedSize.cols
      ) {
        resolveResize()
      } else if (expectedSize && queryTimer === undefined) {
        queryTimer = setTimeout(() => {
          queryTimer = undefined
          queryPtySize()
        }, 25)
      }
    },
    onExit: (exit) => {
      typographyTerminalExit = exit.signal
        ? `signal ${exit.signal}`
        : `code ${exit.exitCode}`
      resolveResize()
    },
  })
  let presentation:
    | { readonly cols: number; readonly rows: number; readonly fontSize: number }
    | undefined
  let failure: Error | undefined
  try {
    presentation = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const fail = (message) => reject(new Error(message));
        const panel = document.querySelector('.terminal-surface.active');
        const engine = panel?.querySelector('.terminal-engine-host');
        const canvas = engine?.querySelector('canvas');
        const before = engine?.__hvirTerminalPerformance;
        const terminalFailure = () => document.querySelector(
          '.terminal-surface.active .terminal-recovery-status'
        )?.textContent?.trim();
        const settingsButton = document.querySelector('.settings-toggle');
        if (
          !(engine instanceof HTMLElement) ||
          !(canvas instanceof HTMLCanvasElement) ||
          !(settingsButton instanceof HTMLButtonElement) ||
          !before
        ) {
          return fail('live typography fixtures missing');
        }
        settingsButton.click();
        const waitForSettings = () => {
          const failure = terminalFailure();
          if (failure) return fail('typography terminal failed: ' + failure);
          const mode = document.querySelector('#settings-monospace-font-mode');
          const size = document.querySelector('#settings-terminal-text-size');
          if (
            mode instanceof HTMLSelectElement &&
            size instanceof HTMLInputElement
          ) {
            const selectSetter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value'
            )?.set;
            const inputSetter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'value'
            )?.set;
            selectSetter?.call(mode, 'custom');
            mode.dispatchEvent(new Event('change', { bubbles: true }));
            const waitForFamily = () => {
              const failure = terminalFailure();
              if (failure) return fail('typography terminal failed: ' + failure);
              const family = document.querySelector('#settings-monospace-font');
              if (family instanceof HTMLInputElement) {
                inputSetter?.call(family, 'monospace');
                family.dispatchEvent(new Event('input', { bubbles: true }));
                const nextSize = before.fontSize === 18 ? 17 : 18;
                inputSetter?.call(size, String(nextSize));
                size.dispatchEvent(new Event('input', { bubbles: true }));
                const save = [...document.querySelectorAll('button')].find(
                  (candidate) => candidate.textContent?.trim() === 'Save app settings'
                );
                if (!(save instanceof HTMLButtonElement)) {
                  return fail('typography Save control missing');
                }
                save.click();
                return waitForApplied(nextSize);
              }
              setTimeout(waitForFamily, 25);
            };
            return waitForFamily();
          }
          setTimeout(waitForSettings, 25);
        };
        const waitForApplied = (nextSize) => {
          const failure = terminalFailure();
          if (failure) return fail('typography terminal failed: ' + failure);
          const current = engine.__hvirTerminalPerformance;
          const stack = getComputedStyle(document.documentElement)
            .getPropertyValue('--hvir-monospace-font');
          if (
            !document.querySelector('.settings-dialog') &&
            current?.fontSize === nextSize &&
            stack.includes('"monospace"') &&
            (current.cols !== before.cols || current.rows !== before.rows)
          ) {
            if (
              !engine.isConnected ||
              engine.querySelector('canvas') !== canvas ||
              document.querySelectorAll('.terminal-engine-host').length !== 1
            ) {
              return fail('typography change replaced the retained terminal surface');
            }
            return resolve({
              cols: current.cols,
              rows: current.rows,
              fontSize: current.fontSize,
            });
          }

          setTimeout(() => waitForApplied(nextSize), 25);
        };
        waitForSettings();
      })
    `)) as { readonly cols: number; readonly rows: number; readonly fontSize: number }

    expectedSize = presentation
    if (
      observedSizes.some(
        ({ rows, cols }) => rows === presentation?.rows && cols === presentation?.cols,
      )
    ) {
      resolveResize()
    }
    queryPtySize()
    await resizeObserved
    if (typographyTerminalExit) {
      throw new Error(`terminal typography PTY exited with ${typographyTerminalExit}`)
    }
  } catch (error) {
    failure = new Error(
      `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
        expectedSize,
        observedSizes,
        queryCount,
        retainedOutputBytes: Buffer.byteLength(probe, 'utf8'),
      })}`,
      { cause: error },
    )
  } finally {
    if (queryTimer !== undefined) clearTimeout(queryTimer)
    void detach()
  }
  if (failure) throw failure
  if (!presentation) throw new Error('terminal typography returned no presentation state')
  const retained = supervisor
    .list()
    .filter((candidate) => candidate.ownerId === win.webContents.id)
  if (retained.length !== 1 || retained[0]?.instanceId !== terminal.instanceId) {
    throw new Error('terminal typography change replaced the live PTY')
  }
  return `custom font fallback + ${presentation.fontSize}px + ${presentation.rows}x${presentation.cols} live PTY reflow`
}

async function focusTerminalEngine(win: BrowserWindow, sessionId: string): Promise<void> {
  win.focus()
  win.webContents.focus()
  await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const failure = surface?.querySelector('.terminal-recovery-status')
            ?.textContent?.trim();
          if (failure) return reject(new Error('terminal focus session failed: ' + failure));
          if (
            surface?.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'visible' &&
            engine instanceof HTMLElement
          ) {
            engine.focus();
            if (engine.contains(document.activeElement)) return resolve();
          }

          setTimeout(poll, 25);
        };
        poll();
      })
    `)
}

async function verifyActiveCursorCadence(
  win: BrowserWindow,
  sessionId: string,
): Promise<string> {
  const idleHiddenFrame = await waitForCursorPhase(win, sessionId, false, -1)

  let activeVisibleFrame = idleHiddenFrame
  for (let index = 0; index < 6; index += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
    activeVisibleFrame = await waitForCursorPhase(
      win,
      sessionId,
      true,
      activeVisibleFrame,
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
  )
  await waitForCursorPhase(win, sessionId, true, resumedHiddenFrame)

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
): Promise<number> {
  return (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const failure = surface?.querySelector('.terminal-recovery-status')
            ?.textContent?.trim();
          if (failure) return reject(new Error('terminal cursor session failed: ' + failure));
          const stats = engine?.__hvirTerminalPerformance;
          if (
            stats && !stats.paused && !stats.pendingFrame &&
            stats.cursorVisible === ${JSON.stringify(visible)} &&
            stats.renderFrames > ${JSON.stringify(afterFrame)}
          ) {
            return resolve(stats.renderFrames);
          }

          setTimeout(poll, 25);
        };
        poll();
      })
    `)) as number
}

async function verifyTerminalLayoutFocus(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(`
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
        const waitFor = (read) => new Promise((resolve) => {
          const poll = () => {
            const value = read();
            if (value) return resolve(value);
            setTimeout(poll, 25);
          };
          poll();
        });
        await new Promise((resolve, reject) => {
          const poll = () => {
            if (activeInput() instanceof HTMLElement) return resolve();

            setTimeout(poll, 25);
          };
          poll();
        });
        const terminalTrack = workbench.style.getPropertyValue('--terminal-track');
        let backgroundHarnessFocus = false;
        const expectFocused = async (button, expectedMode) => {
          const input = activeInput();
          const engine = input?.querySelector('.terminal-engine-host');
          if (!(input instanceof HTMLElement) || !(engine instanceof HTMLElement)) {
            throw new Error('active terminal input missing after ' + expectedMode);
          }
          await new Promise((resolve, reject) => {
            let timer;
            const ready = () =>
              input.contains(document.activeElement) &&
              input.__hvirTerminalDelivery?.presentation === 'visible' &&
              !engine.__hvirTerminalPerformance?.paused;
            const finish = () => {
              if (!ready()) return;
              if (timer) clearTimeout(timer);
              input.removeEventListener('focus', finish);
              resolve();
            };
            const poll = () => {
              const container = input.closest('.terminal-container');
              if (ready()) return finish();
              if (
                document.activeElement === container &&
                !document.hasFocus()
              ) {
                backgroundHarnessFocus = true;
                input.focus();
                if (ready()) return finish();
              }
              timer = setTimeout(poll, 25);
            };
            input.addEventListener('focus', finish);
            button.focus();
            button.click();
            poll();
          });
          if (workbench.style.getPropertyValue('--terminal-track') !== terminalTrack) {
            throw new Error(expectedMode + ' layout changed the saved terminal track');
          }
        };
        const expectCollapsed = async (button) => {
          const input = activeInput();
          const engine = input?.querySelector('.terminal-engine-host');
          if (!(input instanceof HTMLElement) || !(engine instanceof HTMLElement)) {
            throw new Error('active terminal input missing before collapsed layout');
          }
          button.focus();
          button.click();
          await waitFor(() => {
            const delivery = input.__hvirTerminalDelivery;
            const presentation = engine.__hvirTerminalPerformance;
            return workbench.classList.contains('terminal-collapsed') &&
              delivery?.presentation === 'hidden' && presentation?.paused;
          }, 'collapsed layout did not hide the retained terminal presentation');
          if (!input.isConnected || document.activeElement !== button) {
            const delivery = input.__hvirTerminalDelivery;
            const presentation = engine.__hvirTerminalPerformance;
            throw new Error(
              'collapsed layout focus=' +
              (document.activeElement?.className || document.activeElement?.tagName) +
              ' inputConnected=' + input.isConnected +
              ' delivery=' + delivery?.presentation +
              ' paused=' + presentation?.paused
            );
          }
          if (workbench.style.getPropertyValue('--terminal-track') !== terminalTrack) {
            throw new Error('collapsed layout changed the saved terminal track');
          }
        };

        await expectFocused(maximize, 'maximized');
        await expectFocused(maximize, 'restored');
        await expectCollapsed(minimize);
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
        await waitFor(() => document.querySelector('.terminal-new-menu'));
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
        });
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
          restoreBounds.top < railBounds.top - 1 ||
          restoreBounds.top > railBounds.top + 8 ||
          deckEdgeTarget?.closest('.terminal-rail')
        ) {
          throw new Error(
            'compact terminal rail overlaps the deck or misplaces restore: deckRight=' +
            deckBounds.right + ' rail=' + [railBounds.left, railBounds.width].join(',') +
            ' restoreTop=' + restoreBounds.top + ' railTop=' + railBounds.top
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
            Math.abs(canvas.getBoundingClientRect().width - canvasWidth) <= 1
        );
        if (
          workbench.classList.contains('terminal-focused') ||
          workbench.classList.contains('terminal-collapsed') ||
          workbench.classList.contains('terminal-rail-compact')
        ) {
          throw new Error('terminal layout focus check did not restore split view');
        }
        return 'maximized + collapsed + compact rail refit + restored terminal focus' +
          (backgroundHarnessFocus ? ' (background harness setup)' : '');
      })()
    `)) as string
}

async function verifyTerminalLaunchMenuOverflow(
  win: BrowserWindow,
  root: HostPath,
): Promise<string> {
  return (await win.webContents.executeJavaScript(`
      (async () => {
        const waitFor = (read, message) => new Promise((resolve, reject) => {
          const poll = () => {
            const value = read();
            if (value) return resolve(value);
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
        const menuStyle = getComputedStyle(menu);
        const scrollbarGutter =
          menu.offsetWidth -
          menu.clientWidth -
          parseFloat(menuStyle.borderLeftWidth) -
          parseFloat(menuStyle.borderRightWidth);
        if (menuStyle.scrollbarWidth !== 'none' || Math.abs(scrollbarGutter) > 0.01) {
          throw new Error(
            'overflowing launch menu did not retain overlay scrolling: width=' +
            menuStyle.scrollbarWidth + ' gutter=' + scrollbarGutter
          );
        }

        menu.scrollTop = menu.scrollHeight;
        await waitFor(() => {
          const overlay = document.querySelector(
            '.hvir-scrollbar[data-axis="vertical"][data-visible="true"]'
          );
          if (!(overlay instanceof HTMLElement)) return undefined;
          const overlayBounds = overlay.getBoundingClientRect();
          return Math.abs(overlayBounds.right - (bounds.right - 2)) <= 1 &&
            overlayBounds.top >= bounds.top &&
            overlayBounds.bottom <= bounds.bottom
            ? overlay
            : undefined;
        }, 'launch menu did not activate the shared scrollbar overlay');
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
        return created.length + ' configured profiles · overlay scrollbar · final actions';
      })()
    `)) as string
}
