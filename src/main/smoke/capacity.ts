import { arch, cpus, platform, release, totalmem } from 'node:os'

import type { BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  type HarnessProviderId,
  type HostPath,
  type TerminalRecoverySession,
} from '../../shared'
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
import {
  CAPACITY_PERFORMANCE_BUDGETS,
  CAPACITY_PERFORMANCE_GATE_ENV,
  capacityPerformanceViolations,
  formatCapacityPerformanceViolation,
  parseCapacityPerformanceMode,
  type CapacityPerformanceMeasurements,
  type CapacityPerformanceMode,
} from './capacity-performance'

const CPU_SAMPLE_DURATION_MS = 30_000
const CPU_SAMPLE_COUNT = 3
const TERMINAL_READINESS_SAMPLE_COUNT = 10

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

interface CapacitySourceEvidence {
  readonly commit: string
  readonly dirty: boolean | 'unknown'
}

export function capacityRecoverySessions(
  supervisor: PtySupervisor,
  providerId: HarnessProviderId,
): readonly TerminalRecoverySession[] {
  const template = supervisor.list()[0]
  if (!template) throw new Error('capacity recovery requires a terminal template')
  return Array.from({ length: 20 }, (_, position) => ({
    id: `capacity-recovery-${position}`,
    providerId,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    hostId: template.hostId,
    cwd: template.cwd,
    title: `Recovered capacity shell ${position + 1}`,
    position,
    active: position === 0,
    updatedAt: Date.now(),
  }))
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
  const restored = (await withTimeout(
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
            dormant: document.querySelectorAll(
              '.terminal-list-row[data-terminal-dormant="true"]'
            ).length,
            activeStatus: document.querySelector('.terminal-surface.active')
              ?.getAttribute('data-terminal-status') || ''
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
            current.rows === 20 &&
            current.surfaces === 1 &&
            current.dormant === 19 &&
            current.activeStatus.startsWith('pid ')
          ) {
            return resolve(
              '20 restored rows · 1 activated PTY · 19 dormant'
            );
          }
          if (Date.now() > deadline) return fail('capacity terminals did not restore');
          setTimeout(waitForTerminals, 25);
        };
        waitForDialog();
      })
    `),
    'capacity recovery interaction timed out',
    25_000,
  )) as string
  await waitForSupervisorCount(supervisor, 1, 'lazy capacity recovery')

  const activated = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const row = [...document.querySelectorAll(
          '.terminal-list-row[data-terminal-dormant="true"]'
        )].at(-1);
        const terminalId = row?.querySelector('.terminal-list-main')
          ?.getAttribute('data-terminal-session');
        if (!row || !terminalId) return reject(new Error('dormant recovery row missing'));
        row.querySelector('.terminal-list-main')?.click();
        document.querySelector('.rail-nav button:nth-child(2)')?.click();
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(terminalId) + '"]'
          );
          const changesReady = [...document.querySelectorAll('.git-tabs button')]
            .some((node) => /^Changes \\(\\d+\\)$/.test(node.textContent?.trim() || ''));
          if (
            !row.hasAttribute('data-terminal-dormant') &&
            document.querySelectorAll('.terminal-surface').length === 2 &&
            (surface?.getAttribute('data-terminal-status') || '').startsWith('pid ') &&
            changesReady
          ) return resolve('dormant selection started exactly one PTY · Changes ready');
          if (Date.now() > deadline) {
            return reject(new Error('dormant activation did not settle'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'capacity dormant activation timed out',
    12_000,
  )) as string
  await waitForSupervisorCount(supervisor, 2, 'dormant capacity activation')

  const bulk = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const resumeAll = document.querySelector('.terminal-resume-all-button');
        if (!resumeAll) return reject(new Error('Resume all now action missing'));
        const label = resumeAll.textContent?.trim() || '';
        resumeAll.click();
        const poll = () => {
          const current = {
            rows: document.querySelectorAll('.terminal-list-row').length,
            dormant: document.querySelectorAll(
              '.terminal-list-row[data-terminal-dormant="true"]'
            ).length,
            surfaces: document.querySelectorAll('.terminal-surface').length,
            starting: [...document.querySelectorAll('.terminal-surface')]
              .filter((surface) => {
                const status = surface.getAttribute('data-terminal-status') || '';
                return !status.startsWith('pid ');
              }).length
          };
          if (
            current.rows === 20 &&
            current.dormant === 0 &&
            current.surfaces === 20 &&
            current.starting === 0
          ) return resolve(label + ' · 20 isolated starts settled');
          if (Date.now() > deadline) {
            return reject(new Error(
              'capacity bulk recovery did not settle: ' + JSON.stringify(current)
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'capacity bulk recovery timed out',
    25_000,
  )) as string
  await waitForSupervisorCount(supervisor, 20, 'bulk capacity recovery')
  console.log(
    `[smoke] multi-terminal lazy recovery under load OK (${restored} · ${activated} · ${bulk})`,
  )
}

export async function runCapacityLoadSmoke(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  churnPath: HostPath,
): Promise<void> {
  const performanceMode = parseCapacityPerformanceMode(
    process.env[CAPACITY_PERFORMANCE_GATE_ENV],
  )
  const source = capacitySourceEvidence()
  if (
    performanceMode === 'controlled' &&
    (source.commit === 'unknown' || source.dirty !== false)
  ) {
    throw new Error(
      'controlled capacity performance gate requires a clean checkout at a known commit',
    )
  }
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
  console.log(`[smoke:performance:sample:idle-cpu] ${JSON.stringify(idleCpu)}`)
  const responsivenessDiagnostics = await measureResponsivenessDiagnosticCost(win)
  console.log(
    `[smoke:performance:sample:responsiveness-diagnostics] ${JSON.stringify(responsivenessDiagnostics)}`,
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
  console.log(
    `[smoke:performance:sample:terminal-readiness] ${JSON.stringify(terminalReadiness)}`,
  )
  console.log(
    `[smoke:capacity:contract] 10 loaded terminal launches ready + exact echo OK ` +
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
              if (clickPending) {
                requestAnimationFrame(finish);
                return;
              }
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
            finish();
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
  const evidence = capacityPerformanceEvidence(report, performanceMode, source)
  console.log(`[smoke:performance:evidence] ${JSON.stringify(evidence)}`)
  console.log(
    `[smoke:capacity:contracts] load passed ` +
      `(${report.terminalActivity!.hiddenPanes} hidden panes · ` +
      `${report.terminalActivity!.nativeDataEvents} native events → ` +
      `${report.terminalActivity!.deliveryCallbacks} bounded deliveries · ` +
      `${report.terminalActivity!.peakBufferedBytes} byte peak buffer)`,
  )
  if (performanceMode === 'controlled' && evidence.violations.length > 0) {
    throw new Error(
      `controlled capacity performance gate failed: ${evidence.violations
        .map(formatCapacityPerformanceViolation)
        .join('; ')}`,
    )
  }
  console.log(
    performanceMode === 'controlled'
      ? '[smoke:performance:gate] controlled budgets passed'
      : `[smoke:performance:gate] evidence only; run npm run performance:capacity on a controlled machine to enforce ${evidence.violations.length} observed crossing(s)`,
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

function capacityPerformanceEvidence(
  report: CapacitySmokeReport,
  mode: CapacityPerformanceMode,
  source: CapacitySourceEvidence,
) {
  if (
    !report.idleCpu ||
    !report.terminalReadiness ||
    !report.terminalActivity ||
    !report.responsivenessDiagnostics ||
    !report.processMetrics
  ) {
    throw new Error('capacity performance evidence was incomplete')
  }
  const measurements: CapacityPerformanceMeasurements = {
    idleRendererPlusGpuRatio: report.idleCpu.ratio,
    terminalReadinessP95Ratio: report.terminalReadiness.ratio,
    terminalReadinessMaxMs: report.terminalReadiness.loaded.maxMs,
    responsivenessP99Ms: report.p99Ms,
    responsivenessMaxMs: report.maxMs,
    workingSetGrowthKiB: report.memoryGrowthKiB ?? 0,
    diagnosticRendererPlusGpuCpuDelta:
      report.responsivenessDiagnostics.rendererPlusGpuCpuDelta,
    diagnosticMemoryGrowthDeltaKiB: report.responsivenessDiagnostics.memoryGrowthDeltaKiB,
    diagnosticFrameP99Ms: report.responsivenessDiagnostics.active.interactions.frameP99Ms,
    diagnosticFrameMaxMs: report.responsivenessDiagnostics.active.interactions.frameMaxMs,
    diagnosticClickP95Ms: report.responsivenessDiagnostics.active.interactions.clickP95Ms,
    diagnosticClickMaxMs: report.responsivenessDiagnostics.active.interactions.clickMaxMs,
  }
  const cpu = cpus()
  return {
    schemaVersion: 1,
    classification: 'machine-dependent-performance-evidence',
    mode,
    source,
    environment: {
      platform: platform(),
      architecture: arch(),
      release: release(),
      cpuModel: cpu[0]?.model ?? 'unknown',
      logicalCpuCount: cpu.length,
      totalMemoryMiB: Math.round(totalmem() / (1024 * 1024)),
      node: process.versions.node,
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
    },
    sampling: {
      idleCpu: {
        durationMs: CPU_SAMPLE_DURATION_MS,
        samplesPerTopology: CPU_SAMPLE_COUNT,
        baseline: report.idleCpu.baseline,
        twelveTerminals: report.idleCpu.twelveTerminals,
      },
      terminalReadiness: report.terminalReadiness,
      loadedInterval: {
        durationMs: report.durationMs,
        frameSamples: report.frameGapsMs.length,
        clickSamples: report.clickLatenciesMs.length,
        processMetrics: report.processMetrics,
      },
      responsivenessDiagnostics: report.responsivenessDiagnostics,
    },
    measurements,
    budgets: CAPACITY_PERFORMANCE_BUDGETS,
    violations: capacityPerformanceViolations(measurements),
  }
}

function capacitySourceEvidence(): CapacitySourceEvidence {
  const commit = process.env['HVIR_SMOKE_SOURCE_COMMIT']
  const dirty = process.env['HVIR_SMOKE_SOURCE_DIRTY']
  return {
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : 'unknown',
    dirty: dirty === '0' ? false : dirty === '1' ? true : 'unknown',
  }
}

async function waitForSupervisorCount(
  supervisor: PtySupervisor,
  expected: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (supervisor.list().length !== expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `${label} expected ${expected} supervised terminals, found ${supervisor.list().length}`,
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
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
