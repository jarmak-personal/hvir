import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

export interface TerminalRenderStats {
  readonly parsedWrites: number
  readonly renderRequests: number
  readonly renderFrames: number
  readonly fullRenderFrames: number
  readonly paused: boolean
  readonly pendingFrame: boolean
  readonly synchronizedOutput: boolean
  readonly synchronizedOutputRecoveries: number
  readonly retainedRows: number
  readonly retainedByteLimit: number
}

export interface TerminalPresentationSample extends TerminalRenderStats {
  readonly sessionId: string
  readonly visible: boolean
  readonly delivery: TerminalDeliverySample
  readonly semanticRegions: number
  readonly semanticRegionLimit: number
}

export interface TerminalDeliverySample {
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly receivedBytes: number
  readonly deliveredBytes: number
  readonly peakBufferedBytes: number
  readonly bufferedBytes: number
  readonly pending: boolean
  readonly presentation: 'visible' | 'hidden'
}

export interface TerminalActivityReport {
  readonly hiddenPanes: number
  readonly hiddenParsedWrites: number
  readonly hiddenPresentationFrames: number
  readonly visiblePresentationFrames: number
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly terminalWrites: number
  readonly peakBufferedBytes: number
  readonly synchronizedPanes: number
}

export interface TerminalReadinessSampleReport {
  readonly durationsMs: readonly number[]
  readonly p95Ms: number
  readonly maxMs: number
}

export interface TerminalSearchCapacityReport {
  readonly durationMs: number
  readonly retainedRows: number
}

export interface TerminalPaletteCapacityReport {
  readonly synchronousMs: number
  readonly eventLoopDelayMs: number
  readonly paneCount: number
  readonly hiddenPanes: number
  readonly visibleFrames: number
}

export interface TerminalLivePresentationCapacityReport {
  readonly synchronousMs: number
  readonly eventLoopDelayMs: number
  readonly paneCount: number
  readonly hiddenPanes: number
  readonly revealedSessionId: string
  readonly shapedRuns: number
  readonly shapedCells: number
  readonly maxRunCells: number
}

export async function waitForCapacityTerminalCount(
  win: BrowserWindow,
  expected: number,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const expected = ${expected};
        const deadline = Date.now() + 20000;
        const snapshot = () => ({
          rows: document.querySelectorAll('.terminal-list-row').length,
          surfaces: document.querySelectorAll('.terminal-surface').length,
          activeStatus: document.querySelector('.terminal-surface.active')
            ?.getAttribute('data-terminal-status') || ''
        });
        const poll = () => {
          const current = snapshot();
          if (
            current.rows === expected &&
            current.surfaces === expected &&
            current.activeStatus.startsWith('pid ')
          ) return resolve(undefined);
          if (Date.now() > deadline) {
            return reject(new Error(
              'capacity terminals did not settle: ' + JSON.stringify(current)
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    `capacity did not reach ${expected} terminals`,
    25_000,
  )
}

export async function addCapacityTerminals(
  win: BrowserWindow,
  targetCount: number,
): Promise<readonly number[]> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const targetCount = ${targetCount};
        const deadline = Date.now() + 30000;
        const actionStartedAtMs = [];
        const waitFor = (predicate, message) =>
          new Promise((resolve, reject) => {
            const poll = () => {
              const value = predicate();
              if (value) return resolve(value);
              if (Date.now() > deadline) return reject(new Error(message));
              setTimeout(poll, 25);
            };
            poll();
          });
        for (
          let expected = document.querySelectorAll('.terminal-list-row').length + 1;
          expected <= targetCount;
          expected++
        ) {
          const add = await waitFor(
            () => document.querySelector(
              'button[aria-label="New terminal"]:not(:disabled)'
            ),
            'new-terminal button unavailable at ' + expected
          );
          actionStartedAtMs.push(Date.now());
          add.click();
          const shell = await waitFor(
            () => [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell'),
            'shell menu item unavailable at ' + expected
          );
          shell.click();
          await waitFor(() => {
            const active = document.querySelector('.terminal-surface.active');
            return document.querySelectorAll('.terminal-list-row').length === expected &&
              document.querySelectorAll('.terminal-surface').length === expected &&
              (active?.getAttribute('data-terminal-status') || '').startsWith('pid ');
          }, 'terminal did not settle at ' + expected);
        }
        return actionStartedAtMs;
      })()
    `),
    `capacity terminal setup timed out at ${targetCount}`,
    35_000,
  )) as readonly number[]
}

export async function activateCapacityTerminal(
  win: BrowserWindow,
  position: number,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const position = ${position};
        const deadline = Date.now() + 5000;
        const rows = [...document.querySelectorAll('.terminal-list-row')];
        const row = rows[position];
        const button = row?.querySelector('.terminal-list-main');
        if (!row || !button) return reject(new Error('terminal row missing at ' + position));
        button.click();
        const poll = () => {
          const visible = [...document.querySelectorAll('.terminal-surface')]
            .filter((surface) => getComputedStyle(surface).visibility === 'visible');
          if (row.classList.contains('active') && visible.length === 1) {
            return resolve(undefined);
          }
          if (Date.now() > deadline) {
            return reject(new Error('terminal did not activate at ' + position));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    `capacity terminal ${position} activation timed out`,
  )
}

export async function readTerminalPresentation(
  win: BrowserWindow,
): Promise<readonly TerminalPresentationSample[]> {
  return (await win.webContents.executeJavaScript(`
    (() => [...document.querySelectorAll('.terminal-surface')].map((surface) => {
      const engine = surface.querySelector('.terminal-engine-host');
      const stats = engine?.__hvirTerminalPerformance;
      const delivery = surface.querySelector('.terminal-container')
        ?.__hvirTerminalDelivery;
      if (!stats) throw new Error('terminal presentation telemetry missing');
      if (!delivery) throw new Error('terminal delivery telemetry missing');
      return {
        sessionId: surface.getAttribute('data-terminal-session') || '',
        visible: getComputedStyle(surface).visibility === 'visible',
        ...stats,
        delivery,
        semanticRegions: Number(
          surface.querySelector('.terminal-container')
            ?.dataset.terminalSemanticRegions ?? -1
        ),
        semanticRegionLimit: Number(
          surface.querySelector('.terminal-container')
            ?.dataset.terminalSemanticRegionLimit ?? -1
        )
      };
    }))()
  `)) as readonly TerminalPresentationSample[]
}

export async function verifyHiddenPresentationSettles(win: BrowserWindow): Promise<void> {
  await delay(1_500)
  const before = await readTerminalPresentation(win)
  assertPresentationTopology(before)
  await delay(1_200)
  const after = await readTerminalPresentation(win)
  assertPresentationTopology(after)
  const previousById = new Map(before.map((sample) => [sample.sessionId, sample]))
  for (const sample of after.filter((candidate) => !candidate.visible)) {
    const previous = previousById.get(sample.sessionId)
    if (!previous || sample.renderFrames !== previous.renderFrames) {
      throw new Error(`hidden terminal ${sample.sessionId} presented a frame while idle`)
    }
  }
}

/** Prove one appearance change updates twelve retained palettes without hidden paint. */
export async function verifyCapacityPaletteUpdate(
  win: BrowserWindow,
): Promise<TerminalPaletteCapacityReport> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const surfaces = [...document.querySelectorAll('.terminal-surface')];
        const toggle = document.querySelector('.theme-toggle');
        const initialTheme = document.documentElement.dataset.theme;
        const alternateTheme = initialTheme === 'light' ? 'dark' : 'light';
        if (
          surfaces.length !== 12 ||
          !(toggle instanceof HTMLButtonElement) ||
          (initialTheme !== 'dark' && initialTheme !== 'light')
        ) return reject(new Error('capacity palette fixtures missing'));
        const samples = surfaces.map((surface) => {
          const engine = surface.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const stats = engine?.__hvirTerminalPerformance;
          if (
            !(engine instanceof HTMLElement) ||
            !(canvas instanceof HTMLCanvasElement) ||
            !stats?.palette
          ) throw new Error('capacity palette telemetry missing');
          return {
            surface,
            engine,
            canvas,
            background: stats.palette.background,
            renderFrames: stats.renderFrames,
            fullRenderFrames: stats.fullRenderFrames,
            hidden: getComputedStyle(surface).visibility !== 'visible'
          };
        });
        const started = performance.now();
        toggle.click();
        const synchronousMs = performance.now() - started;
        let eventLoopDelayMs;
        setTimeout(() => {
          eventLoopDelayMs = performance.now() - started;
        }, 0);
        const restored = (sample) => {
          const stats = sample.engine.__hvirTerminalPerformance;
          return stats?.palette?.background === sample.background &&
            (sample.hidden
              ? stats.paused && stats.renderFrames === sample.renderFrames
              : !stats.paused && stats.fullRenderFrames > sample.fullRenderFrames) &&
            sample.engine.querySelector('canvas') === sample.canvas;
        };
        const changed = (sample) => {
          const stats = sample.engine.__hvirTerminalPerformance;
          return stats?.palette?.background !== sample.background &&
            sample.engine.querySelector('canvas') === sample.canvas &&
            (sample.hidden
              ? stats.paused && stats.renderFrames === sample.renderFrames
              : !stats.paused && stats.fullRenderFrames > sample.fullRenderFrames);
        };
        const waitForChanged = () => {
          if (
            eventLoopDelayMs !== undefined &&
            document.documentElement.dataset.theme === alternateTheme &&
            samples.every(changed)
          ) {
            if (synchronousMs > 100 || eventLoopDelayMs > 250) {
              return reject(new Error(
                'capacity palette update blocked the renderer: ' +
                JSON.stringify({ synchronousMs, eventLoopDelayMs })
              ));
            }
            toggle.click();
            return waitForRestored();
          }
          if (Date.now() > deadline) {
            return reject(new Error('capacity palettes did not update across retained panes'));
          }
          setTimeout(waitForChanged, 20);
        };
        const waitForRestored = () => {
          if (
            document.documentElement.dataset.theme === initialTheme &&
            samples.every(restored)
          ) {
            const hiddenPanes = samples.filter((sample) => sample.hidden).length;
            const visibleFrames = samples
              .filter((sample) => !sample.hidden)
              .reduce((total, sample) => {
                const stats = sample.engine.__hvirTerminalPerformance;
                return total + stats.renderFrames - sample.renderFrames;
              }, 0);
            return resolve({
              synchronousMs,
              eventLoopDelayMs,
              paneCount: samples.length,
              hiddenPanes,
              visibleFrames
            });
          }
          if (Date.now() > deadline) {
            return reject(new Error('capacity palettes did not restore'));
          }
          setTimeout(waitForRestored, 20);
        };
        waitForChanged();
      })
    `),
    'capacity palette update timed out',
    10_000,
  )) as TerminalPaletteCapacityReport
}

/** Prove saved cursor and shaping changes stay bounded across twelve retained panes. */
export async function verifyCapacityLivePresentationUpdate(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<TerminalLivePresentationCapacityReport> {
  if (supervisor.list().length !== 12) {
    throw new Error('capacity presentation update requires twelve live terminals')
  }
  for (const terminal of supervisor.list()) {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      "printf '\\033[0 qffi -> !== === <= >=\\n'\n",
    )
  }

  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const surfaces = [...document.querySelectorAll('.terminal-surface')];
        const settings = document.querySelector('.settings-toggle');
        const fail = (message) => reject(new Error(message));
        if (surfaces.length !== 12 || !(settings instanceof HTMLButtonElement)) {
          return fail('capacity presentation fixtures missing');
        }
        const samples = surfaces.map((surface) => {
          const engine = surface.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const stats = engine?.__hvirTerminalPerformance;
          const sessionId = surface.getAttribute('data-terminal-session') || '';
          if (
            !(engine instanceof HTMLElement) ||
            !(canvas instanceof HTMLCanvasElement) ||
            !engine.__hvirTerminalCursor?.defaults ||
            stats?.fontLigatures !== true ||
            !sessionId
          ) throw new Error('capacity presentation telemetry missing');
          return {
            surface,
            engine,
            canvas,
            sessionId,
            renderFrames: stats.renderFrames,
            hidden: getComputedStyle(surface).visibility !== 'visible'
          };
        });
        const originalActive = samples.find((sample) => !sample.hidden);
        const revealTarget = samples.find((sample) => sample.hidden);
        if (!originalActive || !revealTarget) {
          return fail('capacity cursor visibility topology missing');
        }
        let shaping;
        let started;
        let synchronousMs;
        let eventLoopDelayMs;
        const waitForShaping = () => {
          const stats = originalActive.engine.__hvirTerminalPerformance;
          if (
            stats?.lastFrame?.shapedRuns > 0 &&
            stats.lastFrame.shapedCells >= 2 &&
            stats.lastFrame.maxRunCells >= 2 &&
            stats.lastFrame.maxRunCells <= stats.cols
          ) {
            shaping = {
              shapedRuns: stats.lastFrame.shapedRuns,
              shapedCells: stats.lastFrame.shapedCells,
              maxRunCells: stats.lastFrame.maxRunCells
            };
            settings.click();
            return openTerminal();
          }
          if (Date.now() > deadline) return fail('capacity shaped run did not settle');
          setTimeout(waitForShaping, 20);
        };
        const openTerminal = () => {
          const terminal = [...document.querySelectorAll('.settings-section-index button')]
            .find((button) => button.textContent?.trim() === 'Terminal');
          if (terminal instanceof HTMLButtonElement) {
            terminal.click();
            return edit();
          }
          if (Date.now() > deadline) return fail('capacity Terminal settings missing');
          setTimeout(openTerminal, 20);
        };
        const edit = () => {
          const shape = document.querySelector('#settings-terminal-cursor-shape');
          const blink = document.querySelector('#settings-terminal-cursor-blink');
          const ligatures = document.querySelector('#settings-terminal-ligatures');
          const save = [...document.querySelectorAll('.settings-dialog button')]
            .find((button) => button.textContent?.trim() === 'Save app settings');
          if (
            shape instanceof HTMLSelectElement &&
            blink instanceof HTMLSelectElement &&
            ligatures instanceof HTMLInputElement &&
            save instanceof HTMLButtonElement
          ) {
            const setter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value'
            )?.set;
            setter?.call(shape, 'bar');
            shape.dispatchEvent(new Event('change', { bubbles: true }));
            setter?.call(blink, 'steady');
            blink.dispatchEvent(new Event('change', { bubbles: true }));
            if (ligatures.checked) ligatures.click();
            started = performance.now();
            save.click();
            synchronousMs = performance.now() - started;
            setTimeout(() => {
              eventLoopDelayMs = performance.now() - started;
            }, 0);
            return waitForApplied();
          }
          if (Date.now() > deadline) return fail('capacity presentation controls missing');
          setTimeout(edit, 20);
        };
        const updated = (sample) => {
          const stats = sample.engine.__hvirTerminalPerformance;
          const cursor = sample.engine.__hvirTerminalCursor;
          return cursor?.defaults?.shape === 'bar' &&
            cursor?.defaults?.blink === 'steady' &&
            cursor?.effective?.default === true &&
            cursor?.effective?.style === 'bar' &&
            cursor?.effective?.blinking === false &&
            stats.fontLigatures === false &&
            sample.engine.querySelector('canvas') === sample.canvas &&
            (sample.hidden
              ? stats.paused && stats.renderFrames === sample.renderFrames
              : !stats.paused && stats.renderFrames > sample.renderFrames &&
                stats.lastFrame?.shapedRuns === 0 &&
                stats.lastFrame?.shapedCells === 0);
        };
        const waitForApplied = () => {
          if (
            eventLoopDelayMs !== undefined &&
            !document.querySelector('.settings-dialog') &&
            samples.every(updated)
          ) {
            if (synchronousMs > 100 || eventLoopDelayMs > 250) {
              return fail('capacity presentation update blocked the renderer: ' +
                JSON.stringify({ synchronousMs, eventLoopDelayMs }));
            }
            const row = document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(revealTarget.sessionId) + '"]'
            );
            if (!(row instanceof HTMLButtonElement)) {
              return fail('capacity cursor reveal row missing');
            }
            row.click();
            return waitForReveal();
          }
          if (Date.now() > deadline) {
            return fail('capacity presentation settings did not update across retained panes');
          }
          setTimeout(waitForApplied, 20);
        };
        const waitForReveal = () => {
          const stats = revealTarget.engine.__hvirTerminalPerformance;
          const cursor = revealTarget.engine.__hvirTerminalCursor;
          if (
            getComputedStyle(revealTarget.surface).visibility === 'visible' &&
            !stats.paused &&
            cursor?.defaults?.shape === 'bar' &&
            cursor?.defaults?.blink === 'steady' &&
            cursor?.effective?.default === true &&
            cursor?.effective?.style === 'bar' &&
            cursor?.effective?.blinking === false &&
            stats.fontLigatures === false &&
            stats.lastFrame?.shapedRuns === 0 &&
            revealTarget.engine.querySelector('canvas') === revealTarget.canvas
          ) {
            const originalRow = document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(originalActive.sessionId) + '"]'
            );
            if (!(originalRow instanceof HTMLButtonElement)) {
              return fail('capacity cursor restore row missing');
            }
            originalRow.click();
            return waitForRestore();
          }
          if (Date.now() > deadline) return fail('hidden cursor defaults did not restore');
          setTimeout(waitForReveal, 20);
        };
        const waitForRestore = () => {
          if (
            getComputedStyle(originalActive.surface).visibility === 'visible' &&
            originalActive.engine.querySelector('canvas') === originalActive.canvas
          ) {
            return resolve({
              synchronousMs,
              eventLoopDelayMs,
              paneCount: samples.length,
              hiddenPanes: samples.filter((sample) => sample.hidden).length,
              revealedSessionId: revealTarget.sessionId,
              ...shaping
            });
          }
          if (Date.now() > deadline) return fail('capacity cursor active pane did not restore');
          setTimeout(waitForRestore, 20);
        };
        waitForShaping();
      })
    `),
    'capacity presentation update timed out',
    22_000,
  )) as TerminalLivePresentationCapacityReport
}

/** Prove bounded search after saturating the accepted retained-byte cap with twelve panes. */
export async function verifyCapacityTerminalSearch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<TerminalSearchCapacityReport> {
  const emittedRows = 120_000
  if (supervisor.list().length !== 12) {
    throw new Error('capacity terminal search requires twelve live terminals')
  }
  const sessionId = (await win.webContents.executeJavaScript(`
    document.querySelector('.terminal-surface.active')?.dataset.terminalSession || ''
  `)) as string
  const terminal = supervisor.list().find((candidate) => candidate.id === sessionId)
  if (!terminal) throw new Error('capacity terminal search has no selected PTY')
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `awk 'BEGIN { for (i=0; i<${emittedRows}; i++) ` +
      `printf "capacity-retained-fill-%06d-` +
      `abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqr\\r\\n", i }'; ` +
      `printf '\\033]0;Capacity retained ready\\007'; ` +
      `IFS= read -r hvir_capacity_search\n`,
  )
  try {
    return (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 60000;
          const surface = document.querySelector(
            '.terminal-surface.active[data-terminal-session=${JSON.stringify(sessionId)}]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          if (!(surface instanceof HTMLElement) || !(engine instanceof HTMLElement) || !stats) {
            return reject(new Error('capacity search fixtures missing'));
          }
          if (stats.retainedByteLimit !== 10000000) {
            return reject(new Error(
              'capacity retained-byte limit changed: ' + stats.retainedByteLimit
            ));
          }
          const waitForCap = () => {
            const title = document.querySelector(
              '.terminal-list-main[data-terminal-session=${JSON.stringify(sessionId)}] ' +
              '.terminal-list-title'
            )?.textContent?.trim();
            const current = engine.__hvirTerminalPerformance;
            const delivery = surface.querySelector('.terminal-container')
              ?.__hvirTerminalDelivery;
            if (
              title === 'Capacity retained ready' &&
              current.retainedRows > 0 &&
              current.retainedRows < ${emittedRows} &&
              delivery && !delivery.pending &&
              delivery.receivedBytes === delivery.deliveredBytes
            ) return openSearch();
            if (Date.now() > deadline) {
              return reject(new Error(
                'capacity retained-byte cap did not settle: ' +
                JSON.stringify({ title, current, delivery })
              ));
            }
            setTimeout(waitForCap, 20);
          };
          const openSearch = () => {
            const primary = /Mac/.test(navigator.platform)
              ? { metaKey: true }
              : { ctrlKey: true };
            const shortcut = new KeyboardEvent('keydown', {
              key: 'f',
              code: 'KeyF',
              shiftKey: true,
              ...primary,
              bubbles: true,
              cancelable: true
            });
            const started = performance.now();
            engine.dispatchEvent(shortcut);
            waitForSearch(started);
          };
          const waitForSearch = (started) => {
            const search = surface.querySelector('.terminal-search');
            const input = search?.querySelector('[aria-label="Find in terminal"]');
            if (input instanceof HTMLInputElement) {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
              )?.set;
              setter?.call(input, 'capacity-retained-fill-119999');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              const waitForResult = () => {
                const status = search.querySelector('.terminal-search-status')
                  ?.textContent?.trim();
                const current = engine.__hvirTerminalPerformance;
                const delivery = surface.querySelector('.terminal-container')
                  ?.__hvirTerminalDelivery;
                if (status === '1 of 1' && delivery && !delivery.pending) {
                  if (
                    current.retainedRows <= 0 ||
                    current.retainedRows >= ${emittedRows} ||
                    delivery.receivedBytes !== delivery.deliveredBytes ||
                    document.querySelectorAll('.terminal-search').length !== 1 ||
                    document.querySelectorAll('.terminal-surface').length !== 12
                  ) {
                    return reject(new Error(
                      'capacity search lost bounded ownership: ' + JSON.stringify({
                        retainedRows: current.retainedRows,
                        delivery
                      })
                    ));
                  }
                  search.querySelector(
                    'button[aria-label="Close terminal search"]'
                  )?.click();
                  return resolve({
                    durationMs: performance.now() - started,
                    retainedRows: current.retainedRows
                  });
                }
                if (Date.now() > deadline) {
                  return reject(new Error(
                    'capacity search did not settle at retained cap: ' +
                    JSON.stringify({ status, current, delivery })
                  ));
                }
                setTimeout(waitForResult, 20);
              };
              return waitForResult();
            }
            if (Date.now() > deadline) {
              return reject(new Error('capacity terminal search did not open'));
            }
            setTimeout(() => waitForSearch(started), 20);
          };
          waitForCap();
        })
      `),
      'capacity terminal search timed out',
      65_000,
    )) as TerminalSearchCapacityReport
  } finally {
    supervisor.write(terminal.id, terminal.ownerId, '\n')
  }
}

export async function measureAdditionalTerminalReadiness(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  label: string,
  sampleCount: number,
): Promise<TerminalReadinessSampleReport> {
  const baseCount = supervisor.list().length
  const durationsMs: number[] = []

  for (let index = 0; index < sampleCount; index += 1) {
    const existingIds = new Set(supervisor.list().map((terminal) => terminal.id))
    const [actionStartedAtMs] = await addCapacityTerminals(win, baseCount + 1)
    if (actionStartedAtMs === undefined) {
      throw new Error(`${label} terminal ${index + 1} action time was not recorded`)
    }
    await waitFor(
      () => supervisor.list().length === baseCount + 1,
      `${label} terminal ${index + 1} was not supervised`,
    )
    const terminal = supervisor.list().find((candidate) => !existingIds.has(candidate.id))
    if (!terminal)
      throw new Error(`${label} terminal ${index + 1} identity was not registered`)

    const input = `${label}${String.fromCharCode(97 + index)}`
    const awaitingInputMarker = `ready-awaiting-input:${input}`
    const marker = `ready-input:${input}`
    let output = ''
    const detach = supervisor.attach(terminal.id, terminal.ownerId, {
      onData: (data) => {
        output = (output + data).slice(-16_384)
      },
    })
    try {
      supervisor.write(
        terminal.id,
        terminal.ownerId,
        `stty -echo; printf '\\r\\nready-awaiting-input:%s\\r\\n' ${JSON.stringify(input)}; IFS= read -r hvir_input; stty echo; printf '\\r\\nready-input:%s\\r\\n' "$hvir_input"\n`,
      )
      await waitFor(
        () => output.includes(awaitingInputMarker),
        `${label} terminal ${index + 1} did not become input-ready: ${JSON.stringify(output)}`,
      )
      await win.webContents.executeJavaScript(`
        (() => {
          const sessionId = ${JSON.stringify(terminal.id)};
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          surface?.querySelector('.terminal-engine-host')?.focus();
        })()
      `)
      for (const keyCode of input.toUpperCase()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await waitFor(
        () => output.includes(marker),
        `${label} terminal ${index + 1} input was not echoed: ${JSON.stringify(output)}`,
      )
      const durationMs = Date.now() - actionStartedAtMs
      durationsMs.push(durationMs)
      await delay(250)
      if (countOccurrences(output, marker) !== 1) {
        throw new Error(
          `${label} terminal ${index + 1} input was duplicated: ${JSON.stringify(output)}`,
        )
      }
      console.log(
        `[smoke:performance:sample:readiness] ${label} ${index + 1}/${sampleCount} ` +
          `${durationMs.toFixed(1)}ms`,
      )
    } finally {
      void detach()
      await closeTerminal(win, terminal.id)
      await waitFor(
        () => supervisor.list().length === baseCount,
        `${label} terminal ${index + 1} did not leave the supervisor`,
      )
      await waitForCapacityTerminalCount(win, baseCount)
    }
  }

  return {
    durationsMs,
    p95Ms: percentile(durationsMs, 0.95),
    maxMs: Math.max(0, ...durationsMs),
  }
}

export function verifyTerminalActivity(
  before: readonly TerminalPresentationSample[],
  after: readonly TerminalPresentationSample[],
  activeFixtureIds: readonly string[],
): TerminalActivityReport {
  assertPresentationTopology(after)
  const beforeById = new Map(before.map((sample) => [sample.sessionId, sample]))
  let hiddenParsedWrites = 0
  let hiddenPresentationFrames = 0
  let visiblePresentationFrames = 0
  let nativeDataEvents = 0
  let deliveryCallbacks = 0
  let terminalWrites = 0
  let peakBufferedBytes = 0
  let synchronizedPanes = 0

  for (const current of after) {
    const previous = beforeById.get(current.sessionId)
    if (!previous)
      throw new Error(`terminal ${current.sessionId} lacked an activity baseline`)
    const parsedDelta = current.parsedWrites - previous.parsedWrites
    const frameDelta = current.renderFrames - previous.renderFrames
    const eventDelta =
      current.delivery.nativeDataEvents - previous.delivery.nativeDataEvents
    const deliveryDelta =
      current.delivery.deliveryCallbacks - previous.delivery.deliveryCallbacks
    nativeDataEvents += eventDelta
    deliveryCallbacks += deliveryDelta
    terminalWrites += parsedDelta
    peakBufferedBytes = Math.max(peakBufferedBytes, current.delivery.peakBufferedBytes)
    if (current.synchronizedOutput) synchronizedPanes += 1
    if (current.synchronizedOutputRecoveries !== previous.synchronizedOutputRecoveries) {
      throw new Error(
        `terminal ${current.sessionId} unexpectedly recovered synchronized output`,
      )
    }
    if (
      current.semanticRegionLimit <= 0 ||
      current.semanticRegions < 0 ||
      current.semanticRegions > current.semanticRegionLimit
    ) {
      throw new Error(
        `terminal ${current.sessionId} exceeded its semantic-region cap: ` +
          `${current.semanticRegions}/${current.semanticRegionLimit}`,
      )
    }
    if (current.semanticRegions !== current.semanticRegionLimit) {
      throw new Error(
        `terminal ${current.sessionId} did not exercise its semantic-region cap: ` +
          `${current.semanticRegions}/${current.semanticRegionLimit}`,
      )
    }
    if (
      current.delivery.bufferedBytes > 64 * 1024 ||
      current.delivery.peakBufferedBytes > 64 * 1024
    ) {
      throw new Error(`terminal ${current.sessionId} exceeded its delivery byte cap`)
    }
    if (current.visible) {
      visiblePresentationFrames += frameDelta
      continue
    }
    hiddenParsedWrites += parsedDelta
    hiddenPresentationFrames += frameDelta
    if (frameDelta !== 0 || current.pendingFrame || !current.paused) {
      throw new Error(
        `hidden terminal ${current.sessionId} presented work: frames=${frameDelta} ` +
          `pending=${current.pendingFrame} paused=${current.paused}`,
      )
    }
    if (activeFixtureIds.includes(current.sessionId) && parsedDelta <= 0) {
      throw new Error(`hidden output fixture ${current.sessionId} did not parse PTY data`)
    }
  }
  if (visiblePresentationFrames <= 0) {
    throw new Error('visible output fixture did not present any frames')
  }
  if (deliveryCallbacks >= nativeDataEvents) {
    throw new Error(
      `terminal output was not coalesced: events=${nativeDataEvents} deliveries=${deliveryCallbacks}`,
    )
  }
  if (synchronizedPanes !== 9) {
    throw new Error(
      `capacity synchronized-output topology was ${synchronizedPanes}/9 panes`,
    )
  }
  return {
    hiddenPanes: after.filter((sample) => !sample.visible).length,
    hiddenParsedWrites,
    hiddenPresentationFrames,
    visiblePresentationFrames,
    nativeDataEvents,
    deliveryCallbacks,
    terminalWrites,
    peakBufferedBytes,
    synchronizedPanes,
  }
}

function assertPresentationTopology(
  samples: readonly TerminalPresentationSample[],
): void {
  const visible = samples.filter((sample) => sample.visible)
  const hidden = samples.filter((sample) => !sample.visible)
  if (samples.length !== 12 || visible.length !== 1 || hidden.length !== 11) {
    throw new Error(
      `capacity presentation topology was ${samples.length}/${visible.length}/${hidden.length}`,
    )
  }
  if (visible[0]!.paused)
    throw new Error('visible capacity terminal presentation was paused')
  for (const sample of hidden) {
    if (!sample.paused || sample.pendingFrame) {
      throw new Error(
        `hidden terminal ${sample.sessionId} did not settle: ` +
          `paused=${sample.paused} pending=${sample.pendingFrame}`,
      )
    }
  }
}

async function closeTerminal(win: BrowserWindow, sessionId: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const sessionId = ${JSON.stringify(sessionId)};
      const button = document.querySelector(
        '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
      );
      button?.closest('.terminal-list-row')?.querySelector('.terminal-close-button')?.click();
    })()
  `)
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await delay(25)
  }
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
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
