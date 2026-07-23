import type { BrowserWindow } from 'electron'

import type { ResponsivenessDiagnosticsState } from '../../shared'
import {
  sampleElectronProcessMetrics,
  type ElectronProcessMetricReport,
} from './electron-process-metrics'

const PHASE_DURATION_MS = 15_000

interface InteractionCost {
  readonly durationMs: number
  readonly frameP99Ms: number
  readonly frameMaxMs: number
  readonly clickP95Ms: number
  readonly clickMaxMs: number
  readonly clickCount: number
}

interface CostPhase {
  readonly interactions: InteractionCost
  readonly processes: ElectronProcessMetricReport
}

export interface ResponsivenessDiagnosticCostReport {
  readonly baseline: CostPhase
  readonly active: CostPhase
  readonly rendererPlusGpuCpuDelta: number
  readonly memoryGrowthDeltaKiB: number
  readonly frameP99DeltaMs: number
  readonly clickP95DeltaMs: number
  readonly observationCount: number
  readonly aggregateCount: number
  readonly dropped: number
}

/** Compare the passive observer with itself disabled under the same 12-terminal UI. */
export async function measureResponsivenessDiagnosticCost(
  win: BrowserWindow,
): Promise<ResponsivenessDiagnosticCostReport> {
  const baseline = await measurePhase(win)
  await startDiagnostics(win)
  let completed: ResponsivenessDiagnosticsState | undefined
  let active: CostPhase
  try {
    active = await measurePhase(win)
  } finally {
    completed = await stopAndDeleteDiagnostics(win)
  }
  if (completed.status !== 'complete') {
    throw new Error(`Responsiveness diagnostics did not complete: ${completed.status}`)
  }
  const report: ResponsivenessDiagnosticCostReport = {
    baseline,
    active,
    rendererPlusGpuCpuDelta:
      active.processes.cpu.rendererPlusGpu - baseline.processes.cpu.rendererPlusGpu,
    memoryGrowthDeltaKiB:
      active.processes.memoryGrowthKiB - baseline.processes.memoryGrowthKiB,
    frameP99DeltaMs: active.interactions.frameP99Ms - baseline.interactions.frameP99Ms,
    clickP95DeltaMs: active.interactions.clickP95Ms - baseline.interactions.clickP95Ms,
    observationCount: completed.observationCount,
    aggregateCount: completed.aggregateCount,
    dropped: completed.dropped,
  }
  if (report.dropped > 0) {
    throw new Error(`Responsiveness diagnostics dropped ${report.dropped} observations`)
  }
  return report
}

async function measurePhase(win: BrowserWindow): Promise<CostPhase> {
  const [interactions, processes] = await Promise.all([
    withTimeout(
      win.webContents.executeJavaScript(interactionProbe()) as Promise<InteractionCost>,
      'responsiveness diagnostic cost phase timed out',
    ),
    sampleElectronProcessMetrics(win.webContents.getOSProcessId(), PHASE_DURATION_MS),
  ])
  return { interactions, processes }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 25_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function startDiagnostics(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const dialog = document.querySelector('.workbench-health-dialog');
        const start = [...(dialog?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === 'Start responsiveness diagnostics');
        if (start) {
          start.click();
          return waitForActive();
        }
        if (Date.now() > deadline) return reject(new Error('capacity diagnostic start missing'));
        setTimeout(inspect, 20);
      };
      const waitForActive = () => {
        if (document.querySelector('.responsiveness-diagnostics-indicator')) {
          [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close')?.click();
          return resolve();
        }
        if (Date.now() > deadline) return reject(new Error('capacity diagnostic indicator missing'));
        setTimeout(waitForActive, 20);
      };
      inspect();
    })
  `)
}

async function stopAndDeleteDiagnostics(
  win: BrowserWindow,
): Promise<ResponsivenessDiagnosticsState> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const panel = document.querySelector('.responsiveness-diagnostics-panel');
        const stop = [...(panel?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === 'Stop and retain evidence');
        if (stop) {
          stop.click();
          return waitForComplete();
        }
        if (Date.now() > deadline) return reject(new Error('capacity diagnostic stop missing'));
        setTimeout(inspect, 20);
      };
      const waitForComplete = async () => {
        const state = await window.hvir.invoke('responsiveness-diagnostics:get', undefined);
        if (state.status === 'complete') {
          const deleted = await window.hvir.invoke('responsiveness-diagnostics:delete', {
            diagnosticSessionId: state.diagnosticSessionId
          });
          if (deleted.status !== 'idle') {
            return reject(new Error('capacity diagnostic evidence remained'));
          }
          [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close')?.click();
          return resolve(state);
        }
        if (Date.now() > deadline) return reject(new Error('capacity diagnostic completion missing'));
        setTimeout(waitForComplete, 20);
      };
      inspect();
    })
  `)) as ResponsivenessDiagnosticsState
}

function interactionProbe(): string {
  return `
    new Promise((resolve, reject) => {
      const durationMs = ${PHASE_DURATION_MS};
      const started = performance.now();
      const frames = [];
      const clicks = [];
      let previousFrame;
      let clickPending = false;
      const percentile = (values, fraction) => {
        if (!values.length) return 0;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
      };
      const clickTimer = setInterval(() => {
        if (clickPending) return;
        const buttons = [...document.querySelectorAll('.rail-nav button:not(:disabled)')];
        const current = buttons.find((button) => button.classList.contains('active'));
        const target = buttons.find((button) => button !== current);
        if (!target) return;
        clickPending = true;
        const clickStarted = performance.now();
        target.click();
        const wait = (now) => {
          if (target.classList.contains('active')) {
            clicks.push(now - clickStarted);
            clickPending = false;
          } else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      }, 400);
      const frame = (now) => {
        if (previousFrame !== undefined) frames.push(now - previousFrame);
        previousFrame = now;
        if (now - started < durationMs) return requestAnimationFrame(frame);
        clearInterval(clickTimer);
        const finish = () => {
          if (clickPending) return requestAnimationFrame(finish);
          resolve({
            durationMs: now - started,
            frameP99Ms: Math.round(percentile(frames, 0.99) * 10) / 10,
            frameMaxMs: Math.round(Math.max(0, ...frames) * 10) / 10,
            clickP95Ms: Math.round(percentile(clicks, 0.95) * 10) / 10,
            clickMaxMs: Math.round(Math.max(0, ...clicks) * 10) / 10,
            clickCount: clicks.length
          });
        };
        finish();
      };
      requestAnimationFrame(frame);
    })
  `
}
