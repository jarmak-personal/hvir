import type { BrowserWindow } from 'electron'

export async function verifyDevelopmentPerformanceMode(
  win: BrowserWindow,
  mode: string,
): Promise<boolean> {
  const development = mode === 'development-performance'
  if (!development) return false

  const result = await verifyDevelopmentPerformanceMeasures(win)
  console.log(`[smoke] React development Performance Timeline bound OK (${result})`)
  console.log('HVIR_SMOKE_OK')
  return true
}

async function verifyDevelopmentPerformanceMeasures(win: BrowserWindow): Promise<string> {
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const requestEvent = 'hvir:development-performance-fixture-request:v1';
        const completeEvent = 'hvir:development-performance-fixture-complete:v1';
        if (!PerformanceObserver.supportedEntryTypes.includes('measure')) {
          reject(new Error('Chromium does not support measure observation'));
          return;
        }

        performance.clearMeasures();
        let observedMeasureCount = 0;
        let observedReactMeasureCount = 0;
        const isFixtureReactMeasure = (entry) =>
          entry.name === 'Update' || entry.name.startsWith('\u200bMeasuredCommit');
        const record = (entries) => {
          observedMeasureCount += entries.length;
          observedReactMeasureCount += entries.filter(isFixtureReactMeasure).length;
        };
        const observer = new PerformanceObserver((list) => record(list.getEntries()));
        observer.observe({ type: 'measure' });

        let requestTimer;
        let failureTimer;
        const cleanup = () => {
          if (requestTimer !== undefined) clearInterval(requestTimer);
          if (failureTimer !== undefined) clearTimeout(failureTimer);
          window.removeEventListener(completeEvent, complete);
          observer.disconnect();
        };
        const complete = () => {
          setTimeout(() => {
            record(observer.takeRecords());
            const retained = performance.getEntriesByType('measure');
            const retainedReactMeasureCount = retained.filter(isFixtureReactMeasure).length;
            cleanup();
            resolve({
              observedMeasureCount,
              observedReactMeasureCount,
              retainedMeasureCount: retained.length,
              retainedReactMeasureCount,
            });
          }, 0);
        };
        window.addEventListener(completeEvent, complete, { once: true });

        const request = () => window.dispatchEvent(new Event(requestEvent));
        request();
        requestTimer = setInterval(request, 25);
        failureTimer = setTimeout(() => {
          cleanup();
          reject(new Error('development renderer fixture did not complete'));
        }, 20000);
      })
    `),
    'development Performance Timeline smoke timed out',
    30_000,
  )) as {
    observedMeasureCount: number
    observedReactMeasureCount: number
    retainedMeasureCount: number
    retainedReactMeasureCount: number
  }
  if (result.observedReactMeasureCount < 1) {
    throw new Error('development fixture did not produce React Performance measures')
  }
  if (result.retainedReactMeasureCount !== 0) {
    throw new Error(
      `React retained ${result.retainedReactMeasureCount} development Performance measures`,
    )
  }
  return `${result.observedReactMeasureCount}/${result.observedMeasureCount} React/total measures observed · ${result.retainedReactMeasureCount}/${result.retainedMeasureCount} retained`
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
