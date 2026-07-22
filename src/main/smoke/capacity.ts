import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import { LocalHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import {
  activateCapacityTerminal,
  addCapacityTerminals,
  measureAdditionalTerminalReadiness,
  readTerminalPresentation,
  startCapacityOutputFixtures,
  verifyHiddenPresentationSettles,
  verifyTerminalActivity,
  waitForCapacityTerminalCount,
  type TerminalActivityReport,
  type TerminalReadinessSampleReport,
} from './capacity-terminals'
import {
  median,
  sampleElectronProcessMetrics,
  type ElectronProcessMetricReport,
} from './electron-process-metrics'
import {
  measureResponsivenessDiagnosticCost,
  type ResponsivenessDiagnosticCostReport,
} from './capacity-responsiveness'

const CPU_SAMPLE_DURATION_MS = 30_000
const CPU_SAMPLE_COUNT = 3
const TERMINAL_READINESS_SAMPLE_COUNT = 10
const TERMINAL_READINESS_RATIO_LIMIT = 2
const TERMINAL_READINESS_MAX_MS = 1_000

interface CapacityCpuComparison {
  readonly baseline: readonly ElectronProcessMetricReport[]
  readonly twelveTerminals: readonly ElectronProcessMetricReport[]
  readonly baselineMedianRendererPlusGpu: number
  readonly twelveTerminalMedianRendererPlusGpu: number
  readonly ratio: number
}

interface CapacityTerminalReadinessComparison {
  readonly baseline: TerminalReadinessSampleReport
  readonly loaded: TerminalReadinessSampleReport
  readonly ratio: number
}

interface CapacitySmokeReport {
  readonly durationMs: number
  readonly frameGapsMs: readonly number[]
  readonly clickLatenciesMs: readonly number[]
  readonly p99Ms: number
  readonly maxMs: number
  readonly memoryStartKiB?: number
  readonly memoryEndKiB?: number
  readonly memoryPeakKiB?: number
  readonly memoryGrowthKiB?: number
  readonly processMetrics?: ElectronProcessMetricReport
  readonly idleCpu?: CapacityCpuComparison
  readonly terminalReadiness?: CapacityTerminalReadinessComparison
  readonly terminalActivity?: TerminalActivityReport
  readonly responsivenessDiagnostics?: ResponsivenessDiagnosticCostReport
}

export async function runCapacityRecoverySmoke(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await win.webContents.executeJavaScript(
    `localStorage.setItem('hvir:terminal-recovery-mode', 'prompt')`,
  )
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )
  win.webContents.reload()
  await withTimeout(loaded, 'capacity recovery reload timed out')
  const status = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const snapshot = () => {
          const rows = [...document.querySelectorAll('.terminal-list-row')];
          const surfaces = [...document.querySelectorAll('.terminal-surface')];
          return {
            dialog: Boolean(document.querySelector('.terminal-recovery-dialog')),
            rows: rows.length,
            surfaces: surfaces.length,
            activeStatus: document.querySelector('.terminal-surface.active')
              ?.getAttribute('data-terminal-status') || '',
            changesReady: [...document.querySelectorAll('.git-tabs button')]
              .some((node) => /^Changes \\(\\d+\\)$/.test(node.textContent?.trim() || '')),
            historyReady: Boolean(document.querySelector('.git-rail-history-row.commit'))
          };
        };
        const fail = (message) => reject(
          new Error(message + ': ' + JSON.stringify(snapshot()))
        );
        const waitForDialog = () => {
          const dialog = document.querySelector('.terminal-recovery-dialog');
          const restore = [...(dialog?.querySelectorAll('button') || [])]
            .find((node) => node.textContent?.trim() === 'Restore selected');
          if (restore) {
            restore.click();
            return waitForTerminals();
          }
          if (Date.now() > deadline) return fail('capacity recovery dialog missing');
          setTimeout(waitForDialog, 25);
        };
        const waitForTerminals = () => {
          const current = snapshot();
          if (
            current.rows === 12 &&
            current.surfaces === 12 &&
            current.activeStatus.startsWith('pid ')
          ) {
            const git = document.querySelector('.rail-nav button:nth-child(2)');
            git?.click();
            return waitForGit(git);
          }
          if (Date.now() > deadline) return fail('capacity terminals did not restore');
          setTimeout(waitForTerminals, 25);
        };
        const waitForGit = (git) => {
          const current = snapshot();
          if (git?.classList.contains('active') && current.changesReady) {
            const history = [...document.querySelectorAll('.git-tabs button')]
              .find((node) => node.textContent?.trim() === 'History');
            history?.click();
            return waitForHistory(current.activeStatus);
          }
          if (Date.now() > deadline) return fail('Git unavailable after capacity restore');
          setTimeout(() => waitForGit(git), 25);
        };
        const waitForHistory = (activeStatus) => {
          if (snapshot().historyReady) {
            return resolve(
              '12 restored terminals · ' + activeStatus + ' · Changes + History ready'
            );
          }
          if (Date.now() > deadline) return fail('Git History unavailable after capacity restore');
          setTimeout(() => waitForHistory(activeStatus), 25);
        };
        waitForDialog();
      })
    `),
    'capacity recovery interaction timed out',
    25_000,
  )) as string
  if (supervisor.list().length !== 12) {
    throw new Error(
      `capacity recovery expected 12 supervised terminals, found ${supervisor.list().length}`,
    )
  }
  console.log(`[smoke] multi-terminal recovery under load OK (${status})`)
}

export async function runCapacityLoadSmoke(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  churnPath: HostPath,
): Promise<void> {
  await waitForCapacityTerminalCount(win, 1)
  const baselineReadiness = await measureAdditionalTerminalReadiness(
    win,
    supervisor,
    'baseline',
    TERMINAL_READINESS_SAMPLE_COUNT,
  )
  const baselineCpu = await sampleCapacityCpuSeries(win, 'one-terminal baseline')
  await addCapacityTerminals(win, 12)
  if (supervisor.list().length !== 12) {
    throw new Error(
      `capacity smoke expected 12 terminals, found ${supervisor.list().length}`,
    )
  }
  await activateCapacityTerminal(win, 0)
  await verifyHiddenPresentationSettles(win)
  const twelveTerminalCpu = await sampleCapacityCpuSeries(
    win,
    'one-visible-eleven-hidden',
  )
  const idleCpu = compareCapacityCpu(baselineCpu, twelveTerminalCpu)
  console.log(`[smoke:capacity:idle-cpu] ${JSON.stringify(idleCpu)}`)
  if (idleCpu.ratio > 1.5) {
    throw new Error(
      `idle renderer+GPU CPU ratio ${idleCpu.ratio.toFixed(2)} exceeded 1.50 ` +
        `(one terminal ${idleCpu.baselineMedianRendererPlusGpu.toFixed(3)}%, ` +
        `twelve terminals ${idleCpu.twelveTerminalMedianRendererPlusGpu.toFixed(3)}%)`,
    )
  }
  const responsivenessDiagnostics = await measureResponsivenessDiagnosticCost(win)
  console.log(
    `[smoke:capacity:responsiveness-diagnostics] ${JSON.stringify(responsivenessDiagnostics)}`,
  )

  startCapacityOutputFixtures(supervisor)
  let churning = true
  const watchChurn = (async (): Promise<void> => {
    let generation = 0
    while (churning) {
      await host.writeFile(churnPath, `capacity churn ${generation++}\n`)
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  })()

  const loadedReadiness = await measureAdditionalTerminalReadiness(
    win,
    supervisor,
    'loaded',
    TERMINAL_READINESS_SAMPLE_COUNT,
  )
  const terminalReadiness = compareTerminalReadiness(baselineReadiness, loadedReadiness)
  console.log(`[smoke:capacity:terminal-readiness] ${JSON.stringify(terminalReadiness)}`)
  if (terminalReadiness.ratio > TERMINAL_READINESS_RATIO_LIMIT) {
    throw new Error(
      `loaded terminal ready-and-echo p95 ${loadedReadiness.p95Ms.toFixed(1)}ms exceeded ` +
        `${TERMINAL_READINESS_RATIO_LIMIT.toFixed(1)}x baseline ` +
        `${baselineReadiness.p95Ms.toFixed(1)}ms`,
    )
  }
  if (loadedReadiness.maxMs > TERMINAL_READINESS_MAX_MS) {
    throw new Error(
      `loaded terminal ready-and-echo max ${loadedReadiness.maxMs.toFixed(1)}ms exceeded ` +
        `${TERMINAL_READINESS_MAX_MS}ms`,
    )
  }
  console.log(
    `[smoke] 10 loaded terminal launches ready + exact echo OK ` +
      `(p95 ${loadedReadiness.p95Ms.toFixed(1)}ms / baseline ` +
      `${baselineReadiness.p95Ms.toFixed(1)}ms · max ${loadedReadiness.maxMs.toFixed(1)}ms)`,
  )
  await activateCapacityTerminal(win, 0)
  const presentationBefore = await readTerminalPresentation(win)
  let report: CapacitySmokeReport | undefined
  try {
    const [rendererReport, processMetrics] = await Promise.all([
      withTimeout(
        win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const durationMs = 30000;
          const started = performance.now();
          const frameGapsMs = [];
          const clickLatenciesMs = [];
          let previousFrame;
          let clickPending = false;
          let clickTimer;
          const percentile = (values, fraction) => {
            if (!values.length) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
          };
          const measureClick = () => {
            if (clickPending) return;
            const buttons = [...document.querySelectorAll('.rail-nav button:not(:disabled)')];
            const current = buttons.find((button) => button.classList.contains('active'));
            const target = buttons.find((button) => button !== current);
            if (!target) return;
            clickPending = true;
            const clickStarted = performance.now();
            target.click();
            const waitForState = (now) => {
              if (target.classList.contains('active')) {
                clickLatenciesMs.push(Math.max(0, now - clickStarted));
                clickPending = false;
              } else if (now - clickStarted > 1000) {
                reject(new Error('rail click did not reach visible state within 1s'));
              } else {
                requestAnimationFrame(waitForState);
              }
            };
            requestAnimationFrame(waitForState);
          };
          clickTimer = setInterval(measureClick, 400);
          const frame = (now) => {
            if (previousFrame !== undefined) frameGapsMs.push(now - previousFrame);
            previousFrame = now;
            if (now - started < durationMs) {
              requestAnimationFrame(frame);
              return;
            }
            clearInterval(clickTimer);
            const finish = () => {
              const samples = [...frameGapsMs, ...clickLatenciesMs];
              const rounded = (values) => values.map((value) => Math.round(value * 10) / 10);
              resolve({
                durationMs: now - started,
                frameGapsMs: rounded(frameGapsMs),
                clickLatenciesMs: rounded(clickLatenciesMs),
                p99Ms: Math.round(percentile(samples, 0.99) * 10) / 10,
                maxMs: Math.round(Math.max(0, ...samples) * 10) / 10,
              });
            };
            if (clickPending) requestAnimationFrame(finish);
            else finish();
          };
          requestAnimationFrame(frame);
        })
      `),
        '30-second renderer responsiveness probe timed out',
        40_000,
      ) as Promise<CapacitySmokeReport>,
      sampleElectronProcessMetrics(
        win.webContents.getOSProcessId(),
        CPU_SAMPLE_DURATION_MS,
      ),
    ])
    const presentationAfter = await readTerminalPresentation(win)
    const terminalActivity = verifyTerminalActivity(
      presentationBefore,
      presentationAfter,
      supervisor
        .list()
        .slice(1, 4)
        .map((terminal) => terminal.id),
    )
    report = {
      ...rendererReport,
      processMetrics,
      idleCpu,
      terminalReadiness,
      terminalActivity,
      responsivenessDiagnostics,
      memoryStartKiB: processMetrics.memoryStartKiB,
      memoryEndKiB: processMetrics.memoryEndKiB,
      memoryPeakKiB: processMetrics.memoryPeakKiB,
      memoryGrowthKiB: processMetrics.memoryGrowthKiB,
    }
  } finally {
    churning = false
    await watchChurn
    for (const terminal of supervisor.list()) {
      supervisor.write(terminal.id, terminal.ownerId, '\u0003')
    }
  }

  if (!report) throw new Error('capacity report was not produced')

  console.log(`[smoke:capacity:raw] ${JSON.stringify(report)}`)
  if (report.p99Ms >= 100) {
    throw new Error(`capacity responsiveness p99 ${report.p99Ms}ms exceeded 100ms`)
  }
  if (report.maxMs > 500) {
    throw new Error(`capacity responsiveness max ${report.maxMs}ms exceeded 500ms`)
  }
  if ((report.memoryGrowthKiB ?? 0) > 256 * 1024) {
    throw new Error(
      `capacity memory grew ${Math.round((report.memoryGrowthKiB ?? 0) / 1024)} MiB in 30s`,
    )
  }
  console.log(
    `[smoke] 12-terminal responsiveness OK (p99 ${report.p99Ms}ms · max ${report.maxMs}ms · ${report.clickLatenciesMs.length} clicks · CPU renderer ${report.processMetrics!.cpu.renderer.toFixed(2)}% / GPU ${report.processMetrics!.cpu.gpu.toFixed(2)}% / main ${report.processMetrics!.cpu.main.toFixed(2)}% / aggregate children ${report.processMetrics!.cpu.aggregateChildren.toFixed(2)}% · memory ${Math.round((report.memoryGrowthKiB ?? 0) / 1024)} MiB net / ${Math.round(((report.memoryPeakKiB ?? 0) - (report.memoryStartKiB ?? 0)) / 1024)} MiB peak growth)`,
  )
}

async function sampleCapacityCpuSeries(
  win: BrowserWindow,
  label: string,
): Promise<readonly ElectronProcessMetricReport[]> {
  const samples: ElectronProcessMetricReport[] = []
  for (let index = 0; index < CPU_SAMPLE_COUNT; index += 1) {
    const sample = await sampleElectronProcessMetrics(
      win.webContents.getOSProcessId(),
      CPU_SAMPLE_DURATION_MS,
    )
    samples.push(sample)
    console.log(
      `[smoke:capacity:cpu] ${label} ${index + 1}/${CPU_SAMPLE_COUNT} ` +
        `renderer=${sample.cpu.renderer.toFixed(3)}% ` +
        `gpu=${sample.cpu.gpu.toFixed(3)}% ` +
        `main=${sample.cpu.main.toFixed(3)}% ` +
        `aggregate-children=${sample.cpu.aggregateChildren.toFixed(3)}%`,
    )
  }
  return samples
}

function compareCapacityCpu(
  baseline: readonly ElectronProcessMetricReport[],
  twelveTerminals: readonly ElectronProcessMetricReport[],
): CapacityCpuComparison {
  const baselineMedianRendererPlusGpu = median(
    baseline.map((sample) => sample.cpu.rendererPlusGpu),
  )
  const twelveTerminalMedianRendererPlusGpu = median(
    twelveTerminals.map((sample) => sample.cpu.rendererPlusGpu),
  )
  const ratio =
    baselineMedianRendererPlusGpu === 0
      ? twelveTerminalMedianRendererPlusGpu === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : twelveTerminalMedianRendererPlusGpu / baselineMedianRendererPlusGpu
  return {
    baseline,
    twelveTerminals,
    baselineMedianRendererPlusGpu,
    twelveTerminalMedianRendererPlusGpu,
    ratio,
  }
}

function compareTerminalReadiness(
  baseline: TerminalReadinessSampleReport,
  loaded: TerminalReadinessSampleReport,
): CapacityTerminalReadinessComparison {
  return {
    baseline,
    loaded,
    ratio:
      baseline.p95Ms === 0
        ? loaded.p95Ms === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : loaded.p95Ms / baseline.p95Ms,
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
