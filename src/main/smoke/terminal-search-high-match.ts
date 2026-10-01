import { app, type BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { CAPACITY_PERFORMANCE_BUDGETS } from './capacity-performance'
import { focusSmokeWindow } from './window-focus'

/** Qualify broad-query metadata and primary output at the existing retained cap. */
export async function verifyHighMatchTerminalSearch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminalId: string,
): Promise<string> {
  await focusSmokeWindow(win)
  const memory = (): number =>
    app.getAppMetrics().find((metric) => metric.pid === win.webContents.getOSProcessId())
      ?.memory.workingSetSize ?? 0
  const beforeKiB = memory()
  const initialCount = (await win.webContents.executeJavaScript(`(async () => {
    const surface = document.querySelector('.terminal-surface.active');
    const engine = surface.querySelector('.terminal-engine-host');
    engine.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', shiftKey: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
      bubbles: true, cancelable: true
    }));
    const deadline = performance.now() + 60000;
    while (!surface.querySelector('.terminal-search')) {
      if (performance.now() > deadline) throw new Error('high-match search did not open');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const input = surface.querySelector('[aria-label="Find in terminal"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'a');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    while (true) {
      const text = surface.querySelector('.terminal-search-status')?.textContent || '';
      const count = Number(text.match(/of ([0-9]+)/)?.[1] || 0);
      if (count > 10000) return count;
      if (performance.now() > deadline) throw new Error('high-match query did not finish: ' + text);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })()`)) as number
  const queryKiB = memory()
  let output = ''
  let done = false
  const detach = supervisor.attach(terminalId, win.webContents.id, {
    onData: (data) => {
      output = (output + data).slice(-8192)
      done ||= output.includes('__HVIR_HIGH_MATCH_DONE__')
    },
  })
  try {
    supervisor.write(
      terminalId,
      win.webContents.id,
      `hvir_high_done='__HVIR_HIGH_MATCH_''DONE__'; ` +
        `hvir_high_i=0; while [ "$hvir_high_i" -lt 300 ]; do ` +
        `hvir_high_j=0; while [ "$hvir_high_j" -lt 50 ]; do printf 'unrelated output\\n'; hvir_high_j=$((hvir_high_j+1)); done; ` +
        `hvir_high_i=$((hvir_high_i+1)); sleep 0.02; done; printf '%s\\n' "$hvir_high_done"\n`,
    )
    const evidence = (await win.webContents.executeJavaScript(`(async () => {
      const surface = document.querySelector('.terminal-surface.active');
      const deadline = performance.now() + 15000;
      let last = performance.now();
      let maximumGapMs = 0;
      let frames = 0;
      let released = false;
      let observedCount;
      const started = performance.now();
      const frame = now => {
        maximumGapMs = Math.max(maximumGapMs, now - last);
        last = now;
        frames++;
        if (!released) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      try {
        while (true) {
          const status = surface.querySelector('.terminal-search-status')?.textContent || '';
          const count = Number(status.match(/([0-9]+) matches/)?.[1] || 0);
          if (surface.querySelector('.terminal-search-unavailable') && count > 0 && count < ${initialCount}) {
            observedCount ??= count;
          }
          if (observedCount !== undefined && performance.now() - started >= 3000) {
            return { count: observedCount, maximumGapMs: Math.round(maximumGapMs * 10) / 10, frames };
          }
          if (performance.now() > deadline) throw new Error('evicted high-match selection hid current counts: ' + status);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally { released = true; }
    })()`)) as { count: number; maximumGapMs: number; frames: number }
    if (evidence.maximumGapMs > CAPACITY_PERFORMANCE_BUDGETS.responsivenessMaxMs)
      throw new Error('High-match streaming exceeded the existing frame-gap budget')
    if (done) throw new Error('high-match updates completed after the finite producer')
    const deadline = Date.now() + 15000
    while (!done) {
      if (Date.now() > deadline) throw new Error('high-match producer did not finish')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const afterKiB = memory()
    await win.webContents.executeJavaScript(`
      document.querySelector('.terminal-surface.active [aria-label="Close terminal search"]').click()
    `)
    if (
      Math.max(queryKiB, afterKiB) - beforeKiB >
      CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB
    )
      throw new Error('High-match metadata exceeded the existing memory growth budget')
    return `${initialCount} matches at 10MB history cap; updated ${evidence.count} with lost-selection notice during nominal 50 Hz × 300 batches of 50 rows; ${evidence.frames} frames, ${evidence.maximumGapMs}ms maximum gap; renderer KiB before/query/after ${beforeKiB}/${queryKiB}/${afterKiB}`
  } finally {
    await detach()
  }
}
