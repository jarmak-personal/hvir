import type { BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared'
import { runViewerPositionOperation } from './viewer-position-operation'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

/** Local timing evidence, never a controlled-capacity verdict or runtime diagnostic. */
export async function verifyViewerWorkload(
  win: BrowserWindow,
  root: HostPath,
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
): Promise<void> {
  // Native keyboard events can queue while the renderer applies results. The renderer
  // measures delivery against Chromium's event timestamp, alongside animation cadence.
  const input = setInterval(() => {
    if (win.isDestroyed()) return
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' })
  }, 16)
  try {
    const evidence: unknown = await runViewerPositionOperation({
      awaiting: 'viewer-position-workload-awaiting',
      ready: 'viewer-position-workload-ready',
      checkpoint,
      execute: () =>
        win.webContents.executeJavaScript(`(async () => {
      const waitFor = async (test, name) => {
        const deadline = performance.now() + 30000;
        while (!test()) {
          if (performance.now() > deadline) throw new Error('dense viewer timeout: ' + name);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const open = async path => {
        const row = [...document.querySelectorAll('.file-row')].find(node => node.title === path);
        if (!row) throw new Error('dense viewer fixture missing');
        row.click();
        await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')?.title === path, 'active path');
        const source = [...document.querySelectorAll('.mode-control button')].find(node => node.textContent.trim() === 'source');
        source?.click();
        await waitFor(() => document.querySelector('.source-shell .cm-editor'), 'source editor');
      };
      const measurements = [];
      let measuring;
      let lastFrame;
      let frameId;
      const tick = now => {
        if (measuring && lastFrame !== undefined) measuring.maxFrameGapMs = Math.max(measuring.maxFrameGapMs, now - lastFrame);
        lastFrame = now;
        frameId = requestAnimationFrame(tick);
      };
      const onKey = event => {
        if (!measuring || event.key !== 'Shift') return;
        measuring.inputEvents++;
        measuring.maxInputLatencyMs = Math.max(measuring.maxInputLatencyMs, performance.now() - event.timeStamp);
      };
      const begin = phase => {
        measuring = { phase, maxFrameGapMs: 0, maxInputLatencyMs: 0, inputEvents: 0 };
        lastFrame = undefined;
      };
      const end = async () => {
        await frame(); await frame();
        measurements.push(measuring);
        measuring = undefined;
      };
      frameId = requestAnimationFrame(tick);
      window.addEventListener('keydown', onKey, true);
      try {
        await open(${JSON.stringify(joinHostPath(root, '.hvir-smoke-dense-find.txt').path)});
        const find = document.querySelector('.find-toggle');
        find.click();
        await waitFor(() => document.querySelector('[aria-label="Find in file"] > input'), 'find input');
        const control = document.querySelector('[aria-label="Find in file"]');
        const input = control.querySelector('input');
        const status = () => control.querySelector('[role="status"]').textContent.trim();
        begin('dense-search');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'x');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => status() === '1 of 2097152', 'complete match count');
        await end();
        begin('repeated-navigation');
        for (let i = 2; i <= 21; i++) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await waitFor(() => status() === i + ' of 2097152', 'next match');
        }
        for (let i = 20; i >= 1; i--) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
          await waitFor(() => status() === i + ' of 2097152', 'previous match');
        }
        await end();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        begin('dense-highlight');
        await open(${JSON.stringify(joinHostPath(root, '.hvir-smoke-dense-highlight.js').path)});
        await waitFor(() => [...document.querySelectorAll('.source-meta span')].some(node => node.textContent === 'javascript'), 'highlight completion');
        if (!document.querySelector('.cm-content [style*="color:"]')) throw new Error('dense syntax decorations missing');
        await end();
        if (measurements.some(value => value.inputEvents === 0)) throw new Error('native input evidence missing');
        return measurements;
      } finally {
        cancelAnimationFrame(frameId);
        window.removeEventListener('keydown', onKey, true);
      }
    })()`),
    })
    console.log(`[smoke] dense viewer local timing evidence ${JSON.stringify(evidence)}`)
  } finally {
    clearInterval(input)
  }
}
