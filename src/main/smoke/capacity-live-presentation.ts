import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

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

export async function verifyCapacityLivePresentationUpdate(
  win: Pick<BrowserWindow, 'webContents'>,
  supervisor: Pick<PtySupervisor, 'list' | 'write'>,
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

  try {
    return (await withTimeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const timers = new Set();
        let settled = false;
        const state = { phase: 'fixtures', category: 'pending', cancel: () => {
          settled = true;
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
        }};
        globalThis.__hvirCapacityLivePresentation = state;
        const fail = (category) => {
          state.category = category;
          state.cancel();
          reject(new Error('capacity presentation failed'));
        };
        const step = (phase, callback) => () => {
          if (settled) return;
          state.phase = phase;
          try { callback(); } catch { fail('callback-failed'); }
        };
        const schedule = (callback, delay) => {
          const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
          timers.add(timer);
        };
        step('fixtures', () => {
        const surfaces = [...document.querySelectorAll('.terminal-surface')];
        const settings = document.querySelector('.settings-toggle');
        if (surfaces.length !== 12 || !(settings instanceof HTMLButtonElement)) {
          return fail('readiness-failed');
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
          return fail('readiness-failed');
        }
        let shaping;
        let started;
        let synchronousMs;
        let eventLoopDelayMs;
        const waitForShaping = step('shaping', () => {
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
          if (Date.now() > deadline) return fail('readiness-failed');
          schedule(waitForShaping, 20);
        });
        const openTerminal = step('settings-navigation', () => {
          const terminal = [...document.querySelectorAll('.settings-section-index button')]
            .find((button) => button.textContent?.trim() === 'Terminal');
          if (terminal instanceof HTMLButtonElement) {
            terminal.click();
            return edit();
          }
          if (Date.now() > deadline) return fail('readiness-failed');
          schedule(openTerminal, 20);
        });
        const edit = step('settings-controls', () => {
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
            schedule(step('settings-applied', () => {
              eventLoopDelayMs = performance.now() - started;
            }), 0);
            return waitForApplied();
          }
          if (Date.now() > deadline) return fail('readiness-failed');
          schedule(edit, 20);
        });
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
        const waitForApplied = step('settings-applied', () => {
          if (
            eventLoopDelayMs !== undefined &&
            !document.querySelector('.settings-dialog') &&
            samples.every(updated)
          ) {
            if (synchronousMs > 100 || eventLoopDelayMs > 250) {
              return fail('renderer-budget-exceeded');
            }
            const row = document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(revealTarget.sessionId) + '"]'
            );
            if (!(row instanceof HTMLButtonElement)) {
              return fail('readiness-failed');
            }
            row.click();
            return waitForReveal();
          }
          if (Date.now() > deadline) {
            return fail('readiness-failed');
          }
          schedule(waitForApplied, 20);
        });
        const waitForReveal = step('hidden-reveal', () => {
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
              return fail('readiness-failed');
            }
            originalRow.click();
            return waitForRestore();
          }
          if (Date.now() > deadline) return fail('readiness-failed');
          schedule(waitForReveal, 20);
        });
        const waitForRestore = step('active-restore', () => {
          if (
            getComputedStyle(originalActive.surface).visibility === 'visible' &&
            originalActive.engine.querySelector('canvas') === originalActive.canvas
          ) {
            state.cancel();
            delete globalThis.__hvirCapacityLivePresentation;
            return resolve({
              synchronousMs,
              eventLoopDelayMs,
              paneCount: samples.length,
              hiddenPanes: samples.filter((sample) => sample.hidden).length,
              revealedSessionId: revealTarget.sessionId,
              ...shaping
            });
          }
          if (Date.now() > deadline) return fail('readiness-failed');
          schedule(waitForRestore, 20);
        });
        waitForShaping();
        })();
      })
    `),
      'capacity presentation update timed out',
      22_000,
    )) as TerminalLivePresentationCapacityReport
  } catch {
    // A failed renderer execution must not orphan its scheduled polls. The same
    // bounded probe distinguishes callback/readiness failure from an unavailable renderer.
    let evidence: unknown = { category: 'renderer-unavailable' }
    try {
      evidence = await withTimeout(
        win.webContents.executeJavaScript(`
        (() => {
          const state = globalThis.__hvirCapacityLivePresentation;
          try {
            return {
              phase: state?.phase ?? 'execution-not-started',
              category: state?.category ?? 'execution-rejected',
              visible: document.visibilityState === 'visible',
              focused: document.hasFocus(),
              surfaces: document.querySelectorAll('.terminal-surface').length
            };
          } finally {
            state?.cancel();
            delete globalThis.__hvirCapacityLivePresentation;
          }
        })()
      `),
        'capacity presentation diagnostic unavailable',
        1_000,
      )
    } catch {
      // Preserve failure without waiting indefinitely for diagnostic evidence.
    }
    throw new Error(
      'capacity presentation failed: ' + JSON.stringify(boundedEvidence(evidence)),
    )
  }
}

function boundedEvidence(value: unknown) {
  if (!value || typeof value !== 'object') return { category: 'renderer-unavailable' }
  const report = value as Record<string, unknown>
  const phases = [
    'fixtures',
    'shaping',
    'settings-navigation',
    'settings-controls',
    'settings-applied',
    'hidden-reveal',
    'active-restore',
    'execution-not-started',
  ]
  const categories = [
    'pending',
    'callback-failed',
    'readiness-failed',
    'renderer-budget-exceeded',
    'execution-rejected',
  ]
  return {
    phase:
      typeof report.phase === 'string' && phases.includes(report.phase)
        ? report.phase
        : null,
    category:
      typeof report.category === 'string' && categories.includes(report.category)
        ? report.category
        : 'renderer-unavailable',
    visible: typeof report.visible === 'boolean' ? report.visible : null,
    focused: typeof report.focused === 'boolean' ? report.focused : null,
    surfaces:
      Number.isInteger(report.surfaces) &&
      Number(report.surfaces) >= 0 &&
      Number(report.surfaces) <= 12
        ? report.surfaces
        : null,
  }
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
