import { app, type BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import { LocalHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'

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
  await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 25000;
        let target = 1;
        const snapshot = () => ({
          target,
          rows: document.querySelectorAll('.terminal-list-row').length,
          surfaces: document.querySelectorAll('.terminal-surface').length,
          activeStatus: document.querySelector('.terminal-surface.active')
            ?.getAttribute('data-terminal-status') || '',
          addEnabled: Boolean(
            document.querySelector('button[aria-label="New terminal"]:not(:disabled)')
          ),
          shellChoice: [...document.querySelectorAll('.terminal-new-menu button')]
            .some((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell')
        });
        const waitFor = (predicate, message) =>
          new Promise((resolve, reject) => {
            const poll = () => {
              const value = predicate();
              if (value) return resolve(value);
              if (Date.now() > deadline) {
                return reject(new Error(message + ': ' + JSON.stringify(snapshot())));
              }
              setTimeout(poll, 25);
            };
            poll();
          });
        await waitFor(() => {
          const current = snapshot();
          return current.rows === 1 &&
            current.surfaces === 1 &&
            current.activeStatus.startsWith('pid ');
        }, 'initial terminal did not settle');
        for (target = 2; target <= 12; target++) {
          const add = await waitFor(
            () => document.querySelector('button[aria-label="New terminal"]:not(:disabled)'),
            'new-terminal button unavailable'
          );
          add.click();
          const shell = await waitFor(
            () => [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell'),
            'shell menu item unavailable'
          );
          shell.click();
          await waitFor(() => {
            const current = snapshot();
            return current.rows === target &&
              current.surfaces === target &&
              current.activeStatus.startsWith('pid ');
          }, 'terminal did not settle');
        }
        return document.querySelectorAll('.terminal-list-row').length;
      })()
    `),
    'capacity terminal setup timed out',
    30_000,
  )
  if (supervisor.list().length !== 12) {
    throw new Error(
      `capacity smoke expected 12 terminals, found ${supervisor.list().length}`,
    )
  }

  for (const terminal of supervisor.list()) {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      'i=0; while [ "$i" -lt 320 ]; do printf \'hvir-load-%04d abcdefghijklmnopqrstuvwxyz\\n\' "$i"; i=$((i+1)); sleep 0.1; done\n',
    )
  }
  let churning = true
  const watchChurn = (async (): Promise<void> => {
    let generation = 0
    while (churning) {
      await host.writeFile(churnPath, `capacity churn ${generation++}\n`)
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  })()

  let report: CapacitySmokeReport
  const memoryStartKiB = appWorkingSetKiB()
  let memoryPeakKiB = memoryStartKiB
  const memoryTimer = setInterval(() => {
    memoryPeakKiB = Math.max(memoryPeakKiB, appWorkingSetKiB())
  }, 500)
  try {
    report = (await withTimeout(
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
    )) as CapacitySmokeReport
  } finally {
    clearInterval(memoryTimer)
    churning = false
    await watchChurn
    for (const terminal of supervisor.list()) {
      supervisor.write(terminal.id, terminal.ownerId, '\u0003')
    }
  }

  const memoryEndKiB = appWorkingSetKiB()
  report = {
    ...report,
    memoryStartKiB,
    memoryEndKiB,
    memoryPeakKiB,
    memoryGrowthKiB: memoryEndKiB - memoryStartKiB,
  }

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
    `[smoke] 12-terminal responsiveness OK (p99 ${report.p99Ms}ms · max ${report.maxMs}ms · ${report.clickLatenciesMs.length} clicks · memory ${Math.round((report.memoryGrowthKiB ?? 0) / 1024)} MiB net / ${Math.round(((report.memoryPeakKiB ?? 0) - (report.memoryStartKiB ?? 0)) / 1024)} MiB peak growth)`,
  )
}

function appWorkingSetKiB(): number {
  return app
    .getAppMetrics()
    .reduce((total, metric) => total + metric.memory.workingSetSize, 0)
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
