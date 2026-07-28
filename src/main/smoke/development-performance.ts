import type { BrowserWindow } from 'electron'

export async function verifyDevelopmentPerformanceMode(
  win: BrowserWindow,
  mode: string,
): Promise<boolean> {
  const development = mode === 'development-performance'
  const active = development
    ? ((await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 15000;
            const inspect = () => {
              if (document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy) {
                resolve(true);
                return;
              }
              if (Date.now() > deadline) {
                reject(new Error('development measure-budget owner was not installed'));
                return;
              }
              setTimeout(inspect, 25);
            };
            inspect();
          })
        `),
        'development measure-budget owner did not start',
        15_000,
      )) as boolean)
    : ((await win.webContents.executeJavaScript(
        `Boolean(document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy)`,
      )) as boolean)
  if (!development) {
    if (active) {
      throw new Error('production renderer activated development measure instrumentation')
    }
    return false
  }
  if (!active)
    throw new Error('development renderer omitted its Performance Timeline owner')

  const result = await verifyDevelopmentPerformanceMeasures(win)
  console.log(`[smoke] development Performance Timeline bound OK (${result})`)
  console.log('HVIR_SMOKE_OK')
  return true
}

async function verifyDevelopmentPerformanceMeasures(win: BrowserWindow): Promise<string> {
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const root = document.documentElement;
        const budget = Number(root.dataset.hvirDevelopmentPerformanceMeasureBudget);
        const intervalMs = Number(root.dataset.hvirDevelopmentPerformanceMeasureInterval);
        const policy = root.dataset.hvirDevelopmentPerformanceMeasurePolicy;
        if (!Number.isSafeInteger(budget) || budget < 1 || !policy) {
          throw new Error('development measure-budget owner was not installed');
        }
        performance.clearMeasures();
        window.dispatchEvent(new Event('hvir:development-performance-measure-fixture'));
        const deadline = Date.now() + Math.max(20000, intervalMs * 3);
        let peak = 0;
        let sawReactMeasure = false;
        let exceeded = false;
        while (Date.now() < deadline) {
          const entries = performance.getEntriesByType('measure');
          peak = Math.max(peak, entries.length);
          sawReactMeasure ||= entries.some((entry) =>
            entry.name === 'Update' || entry.name.startsWith('\u200bMeasuredCommit')
          );
          exceeded ||= entries.length > budget;
          const complete = document.querySelector(
            '[data-hvir-development-performance-fixture="complete"]'
          );
          if (complete && exceeded && entries.length <= budget) {
            return { budget, intervalMs, peak, final: entries.length, sawReactMeasure };
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          'development measure fixture did not exceed and return below its budget (' +
            JSON.stringify({ budget, intervalMs, peak, current: performance.getEntriesByType('measure').length }) +
            ')'
        );
      })()
    `),
    'development Performance Timeline smoke timed out',
    30_000,
  )) as {
    budget: number
    intervalMs: number
    peak: number
    final: number
    sawReactMeasure: boolean
  }
  if (!result.sawReactMeasure) {
    throw new Error('development fixture did not produce React Performance measures')
  }
  return `React measures ${result.peak}→${result.final} · budget ${result.budget} · ${result.intervalMs}ms inspection`
}

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ])
}
