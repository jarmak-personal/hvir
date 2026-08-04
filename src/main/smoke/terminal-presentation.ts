import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyTerminalHorizonPresentation } from './terminal-horizon-presentation'
import { verifyTerminalProjectReturn } from './terminal-project-return'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

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
  const explicitLaunch = await ensureExplicitBareShellLaunch(win, supervisor)
  const horizonStatus = await verifyTerminalHorizonPresentation(win)
  const layoutFocusStatus = await verifyTerminalLayoutFocus(win)
  const projectReturnStatus = await verifyTerminalProjectReturn(
    win,
    supervisor,
    launchMenuOverflowRoot
      ? joinHostPath(launchMenuOverflowRoot, '.hvir-smoke-oversized-diff.txt')
      : undefined,
  )
  const launchMenuStatus = launchMenuOverflowRoot
    ? await verifyTerminalLaunchMenuOverflow(win, launchMenuOverflowRoot)
    : undefined
  const switchStatus = (await withTerminalSmokeTimeout(
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
  const revealStatus = (await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(secondTerminal.id)};
        const deadline = Date.now() + 8000;
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
              selectFromCompactRail(surface, row, hiddenFullFrames);
            }, 650);
          }
          if (Date.now() > deadline) {
            return fail('hidden terminal output did not settle: title=' + title +
              ' bell=' + Boolean(bell) + ' surface=' + Boolean(surface));
          }
          setTimeout(waitForHiddenOutput, 25);
        };
        const selectFromCompactRail = (surface, row, hiddenFullFrames) => {
          const workbench = document.querySelector('.workbench');
          const rail = document.querySelector('.terminal-rail:not([hidden])');
          const collapse = document.querySelector(
            'button[aria-label="Collapse terminal rail"]'
          );
          const expandedOrder = [...document.querySelectorAll('.terminal-list-main')]
            .map((entry) => entry.getAttribute('data-terminal-session'))
            .join('|');
          if (
            !(workbench instanceof HTMLElement) ||
            !(rail instanceof HTMLElement) ||
            !(collapse instanceof HTMLButtonElement)
          ) {
            return fail('compact marker switch fixtures missing');
          }
          collapse.click();
          const waitForMarkers = () => {
            const markerList = document.querySelector('.terminal-rail-compact-markers');
            const restore = document.querySelector(
              'button[aria-label="Restore terminal rail"]'
            );
            const markers = markerList
              ? [...markerList.querySelectorAll('.terminal-rail-compact-marker')]
              : [];
            if (
              workbench.classList.contains('terminal-rail-compact') &&
              markerList instanceof HTMLElement &&
              restore instanceof HTMLButtonElement &&
              markers.length === 2
            ) {
              const markerOrder = markers
                .map((entry) => entry.getAttribute('data-terminal-session'))
                .join('|');
              const firstMarker = markers[0];
              const marker = markers.find(
                (entry) => entry.getAttribute('data-terminal-session') === sessionId
              );
              if (
                markerOrder !== expandedOrder ||
                !(firstMarker instanceof HTMLButtonElement) ||
                !(marker instanceof HTMLButtonElement) ||
                firstMarker.textContent !== '' ||
                marker.dataset.terminalState !== 'bell' ||
                marker.getAttribute('aria-label') !== 'Hidden buffered, Bell' ||
                marker.title !== 'Hidden buffered, Bell' ||
                marker.tabIndex !== 0
              ) {
                return fail(
                  'compact markers lost row order, state, or accessible naming: order=' +
                  markerOrder + ' expected=' + expandedOrder +
                  ' state=' + marker?.getAttribute('data-terminal-state') +
                  ' label=' + marker?.getAttribute('aria-label')
                );
              }
              const firstRectangle = getComputedStyle(firstMarker, '::before');
              const secondRectangle = getComputedStyle(marker, '::before');
              const firstItem = firstMarker.closest(
                '.terminal-rail-compact-marker-item'
              );
              const lastItem = marker.closest(
                '.terminal-rail-compact-marker-item'
              );
              const firstItemDecoration = firstItem
                ? getComputedStyle(firstItem, '::before')
                : undefined;
              const lastItemDecoration = lastItem
                ? getComputedStyle(lastItem, '::before')
                : undefined;
              const firstBounds = firstMarker.getBoundingClientRect();
              const secondBounds = marker.getBoundingClientRect();
              if (
                firstRectangle.transform !== 'none' ||
                secondRectangle.transform !== 'none' ||
                firstRectangle.borderRadius !== '0px' ||
                secondRectangle.borderRadius !== '0px' ||
                firstRectangle.borderLeftWidth !== '2px' ||
                firstRectangle.borderTopWidth !== '2px' ||
                secondRectangle.borderBottomWidth !== '3px' ||
                getComputedStyle(markerList).rowGap !== '0px' ||
                Math.abs(firstBounds.width - markerList.clientWidth) > 1 ||
                Math.abs(secondBounds.width - markerList.clientWidth) > 1 ||
                Math.abs(secondBounds.top - firstBounds.bottom) > 1 ||
                firstItemDecoration?.content !== 'none' ||
                lastItemDecoration?.content !== 'none'
              ) {
                return fail(
                  'compact markers lost zero-gap full-width rectangle geometry: ' +
                  'transforms=' + firstRectangle.transform + '/' +
                    secondRectangle.transform +
                  ' radii=' + firstRectangle.borderRadius + '/' +
                    secondRectangle.borderRadius +
                  ' active=' + firstRectangle.borderLeftWidth + '/' +
                    firstRectangle.borderTopWidth +
                  ' bell=' + secondRectangle.borderBottomWidth +
                  ' gap=' + getComputedStyle(markerList).rowGap +
                  ' widths=' + [
                    firstBounds.width,
                    secondBounds.width,
                    markerList.clientWidth
                  ].join('/') +
                  ' adjacency=' + (secondBounds.top - firstBounds.bottom) +
                  ' decorations=' + [
                    firstItemDecoration?.content,
                    lastItemDecoration?.content
                  ].join('/')
                );
              }
              markerList.style.flex = '0 0 20px';
              markerList.style.maxHeight = '20px';
              return requestAnimationFrame(() => {
                const railBounds = rail.getBoundingClientRect();
                const listBounds = markerList.getBoundingClientRect();
                const restoreBounds = restore.getBoundingClientRect();
                const restoreTop = restoreBounds.top;
                const listStyle = getComputedStyle(markerList);
                if (
                  listStyle.overflowY !== 'auto' ||
                  markerList.scrollHeight <= markerList.clientHeight ||
                  listStyle.scrollbarWidth !== 'none' ||
                  markerList.offsetWidth !== markerList.clientWidth ||
                  listBounds.left < railBounds.left - 1 ||
                  listBounds.right > railBounds.right + 1 ||
                  restoreBounds.left < railBounds.left - 1 ||
                  restoreBounds.right > railBounds.right + 1 ||
                  restoreBounds.top < railBounds.top - 1 ||
                  restoreBounds.bottom > listBounds.top + 1
                ) {
                  return fail(
                    'compact marker overflow escaped the rail or moved above restore: ' +
                    'overflow=' + listStyle.overflowY +
                    ' heights=' + markerList.clientHeight + '/' + markerList.scrollHeight +
                    ' scrollbar=' + listStyle.scrollbarWidth +
                    ' widths=' + markerList.clientWidth + '/' + markerList.offsetWidth +
                    ' rail=' + [railBounds.left, railBounds.right].join(',') +
                    ' list=' + [listBounds.left, listBounds.right].join(',') +
                    ' restore=' + [
                      restoreBounds.left,
                      restoreBounds.right,
                      restoreBounds.top,
                      restoreBounds.bottom
                    ].join(',')
                  );
                }
                marker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                requestAnimationFrame(() => {
                  const markerBounds = marker.getBoundingClientRect();
                  const restoreAfterScroll = restore.getBoundingClientRect();
                  if (
                    markerList.scrollTop <= 0 ||
                    markerBounds.top < listBounds.top - 1 ||
                    markerBounds.bottom > listBounds.bottom + 1 ||
                    Math.abs(restoreAfterScroll.top - restoreTop) > 1
                  ) {
                    return fail(
                      'compact marker scroll moved restore or hid the final marker: ' +
                      'scrollTop=' + markerList.scrollTop +
                      ' restoreTop=' + restoreTop + '/' + restoreAfterScroll.top
                    );
                  }
                  marker.focus();
                  marker.click();
                  waitForReveal(
                    surface,
                    row,
                    hiddenFullFrames,
                    workbench,
                    markerList,
                    restore
                  );
                });
              });
            }
            if (Date.now() > deadline) {
              return fail('compact terminal markers did not appear');
            }
            setTimeout(waitForMarkers, 25);
          };
          waitForMarkers();
        };
        const waitForReveal = (
          surface,
          row,
          hiddenFullFrames,
          workbench,
          markerList,
          restore
        ) => {
          const canvas = surface.querySelector('canvas');
          const context = canvas?.getContext('2d');
          const stats = surface.querySelector('.terminal-engine-host')
            ?.__hvirTerminalPerformance;
          const marker = markerList.querySelector(
            '.terminal-rail-compact-marker[data-terminal-session="' +
            CSS.escape(sessionId) + '"]'
          );
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
            !stats.paused && !stats.pendingFrame &&
            workbench.classList.contains('terminal-rail-compact') &&
            marker instanceof HTMLButtonElement &&
            marker.getAttribute('aria-current') === 'true' &&
            marker.dataset.terminalState === 'neutral' &&
            marker.getAttribute('aria-label') ===
              'Hidden buffered, Neutral, active terminal' &&
            !row.querySelector('.terminal-attention-badge')
          ) {
            if (stats.fullRenderFrames - hiddenFullFrames !== 1) {
              return fail(
                'terminal reveal full repaint count was ' +
                (stats.fullRenderFrames - hiddenFullFrames)
              );
            }
            markerList.style.removeProperty('flex');
            markerList.style.removeProperty('max-height');
            restore.click();
            const waitForRestore = () => {
              if (!workbench.classList.contains('terminal-rail-compact')) {
                return resolve(
                  'hidden output + compact marker switch + attention clear + ' +
                  'bounded overflow + current repaint'
                );
              }
              if (Date.now() > deadline) {
                return fail('terminal rail did not restore after compact marker switch');
              }
              setTimeout(waitForRestore, 25);
            };
            return waitForRestore();
          }
          if (Date.now() > deadline) {
            return fail(
              'compact marker did not activate and clear the revealed terminal'
            );
          }
          setTimeout(
            () =>
              waitForReveal(
                surface,
                row,
                hiddenFullFrames,
                workbench,
                markerList,
                restore
              ),
            25
          );
        };
        waitForHiddenOutput();
      })
    `),
    'hidden terminal compact switch timed out',
    12_000,
  )) as string

  let inputProbe = ''
  const detachInputProbe = supervisor.attach(secondTerminal.id, secondTerminal.ownerId, {
    onData: (data) => {
      inputProbe = (inputProbe + data).slice(-4_096)
    },
  })
  await focusTerminalEngine(win, secondTerminal.id)
  const cursorStatus = await verifyActiveCursorCadence(win, secondTerminal.id)
  for (const keyCode of ['H', 'V', 'I', 'R']) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  try {
    await withTerminalSmokeTimeout(
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
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; final probe: ${JSON.stringify(inputProbe)}`,
      { cause: error },
    )
  } finally {
    void detachInputProbe()
  }
  const inputStatus = (await withTerminalSmokeTimeout(
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
  const typographyStatus = await verifyLiveTerminalTypography(win, supervisor)

  return [
    explicitLaunch,
    horizonStatus,
    layoutFocusStatus,
    projectReturnStatus,
    launchMenuStatus,
    switchStatus,
    revealStatus,
    cursorStatus,
    inputStatus,
    typographyStatus,
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
  })
  let presentation:
    | { readonly cols: number; readonly rows: number; readonly fontSize: number }
    | undefined
  let failure: Error | undefined
  try {
    presentation = (await withTerminalSmokeTimeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const fail = (message) => reject(new Error(message));
        const panel = document.querySelector('.terminal-surface.active');
        const engine = panel?.querySelector('.terminal-engine-host');
        const canvas = engine?.querySelector('canvas');
        const before = engine?.__hvirTerminalPerformance;
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
              if (Date.now() > deadline) return fail('custom font field did not appear');
              setTimeout(waitForFamily, 25);
            };
            return waitForFamily();
          }
          if (Date.now() > deadline) return fail('Appearance typography controls missing');
          setTimeout(waitForSettings, 25);
        };
        const waitForApplied = (nextSize) => {
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
          if (Date.now() > deadline) {
            return fail(
              'typography did not reflow retained grid: before=' +
              JSON.stringify(before) + ' current=' + JSON.stringify(current)
            );
          }
          setTimeout(() => waitForApplied(nextSize), 25);
        };
        waitForSettings();
      })
    `),
      'live terminal typography timed out',
      10_000,
    )) as { readonly cols: number; readonly rows: number; readonly fontSize: number }

    expectedSize = presentation
    if (
      observedSizes.some(
        ({ rows, cols }) => rows === presentation?.rows && cols === presentation?.cols,
      )
    ) {
      resolveResize()
    }
    queryPtySize()
    await withTerminalSmokeTimeout(
      resizeObserved,
      'terminal typography PTY resize timed out',
      5_000,
    )
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
  await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          if (
            surface?.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'visible' &&
            engine instanceof HTMLElement
          ) {
            engine.focus();
            if (document.activeElement === engine) return resolve();
          }
          if (Date.now() > deadline) {
            return reject(new Error('revealed terminal engine did not regain focus'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'revealed terminal engine focus timed out',
  )
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
  return (await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 2500;
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          if (
            stats && !stats.paused && !stats.pendingFrame &&
            stats.cursorVisible === ${JSON.stringify(visible)} &&
            stats.renderFrames > ${JSON.stringify(afterFrame)}
          ) {
            return resolve(stats.renderFrames);
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              ${JSON.stringify(failure)} + ': last=' + JSON.stringify({
                engineFocused: document.activeElement === engine,
                hasStats: Boolean(stats),
                paused: stats?.paused,
                pendingFrame: stats?.pendingFrame,
                cursorVisible: stats?.cursorVisible,
                renderFrames: stats?.renderFrames,
                renderRequests: stats?.renderRequests
              })
            ));
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
  return (await withTerminalSmokeTimeout(
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
        let backgroundHarnessFocus = false;
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
            const poll = () => {
              const container = input.closest('.terminal-container');
              if (document.activeElement === input) return finish();
              if (
                document.activeElement === container &&
                !document.hasFocus()
              ) {
                backgroundHarnessFocus = true;
                input.focus();
                if (document.activeElement === input) return finish();
              }
              if (Date.now() > deadline) {
                input.removeEventListener('focus', finish);
                const surface = input.closest('.terminal-surface');
                const activeElement = document.activeElement;
                return reject(new Error(
                  expectedMode + ' layout left focus on ' +
                  (activeElement?.className || activeElement?.tagName) +
                  ': documentFocused=' + document.hasFocus() +
                  ' inputConnected=' + input.isConnected +
                  ' inputTabIndex=' + input.tabIndex +
                  ' inputEditable=' + input.getAttribute('contenteditable') +
                  ' containerFocused=' + (activeElement === container) +
                  ' surfaceActive=' + Boolean(surface?.classList.contains('active')) +
                  ' surfaceVisible=' + Boolean(surface?.classList.contains('visible')) +
                  ' surfaceSession=' + (surface?.getAttribute('data-terminal-session') || '')
                ));
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
        return 'maximized + collapsed + compact rail refit + restored terminal focus' +
          (backgroundHarnessFocus ? ' (background harness setup)' : '');
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
  return (await withTerminalSmokeTimeout(
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
    `),
    'terminal launch menu overflow timed out',
    20_000,
  )) as string
}
