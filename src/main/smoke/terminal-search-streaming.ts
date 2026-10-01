import { clipboard, type BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'
import { focusSmokeWindow } from './window-focus'

const MATCH = 'hvir-streaming-search-match'
const READY = '__HVIR_STREAM_READY__'
const DONE = '__HVIR_STREAM_DONE__'

/** Finite 50 Hz producer: prove progress, occurrence selection and viewport stability. */
export async function verifyStreamingTerminalSearch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminalId?: string,
): Promise<string> {
  terminalId ??= (await win.webContents.executeJavaScript(`
    document.querySelector('.terminal-surface.active')?.dataset.terminalSession || ''
  `)) as string
  if (!terminalId) throw new Error('streaming search has no selected terminal')
  await focusSmokeWindow(win)
  let completed = false
  let output = ''
  let readyAt: number | undefined
  let completedAt: number | undefined
  const detach = supervisor.attach(terminalId, win.webContents.id, {
    onData: (data) => {
      output = (output + data).slice(-8192)
      if (readyAt === undefined && output.includes(READY)) readyAt = Date.now()
      if (!completed && output.includes(DONE)) {
        completed = true
        completedAt = Date.now()
      }
    },
  })
  try {
    supervisor.write(
      terminalId,
      win.webContents.id,
      `hvir_stream_match='hvir-streaming-search-''match'; ` +
        `hvir_stream_done='__HVIR_STREAM_''DONE__'; hvir_stream_ready='__HVIR_STREAM_''READY__'; ` +
        `printf '%s\\n%s\\n%s\\n' "$hvir_stream_match" "$hvir_stream_match" "$hvir_stream_match"; ` +
        `hvir_stream_i=0; while [ "$hvir_stream_i" -lt 120 ]; do printf 'history filler\\n'; hvir_stream_i=$((hvir_stream_i+1)); done; ` +
        `printf '%s\\n' "$hvir_stream_ready"; sleep 0.2; ` +
        `hvir_stream_i=0; while [ "$hvir_stream_i" -lt 150 ]; do ` +
        `printf 'stream filler %s\\n' "$hvir_stream_i"; ` +
        `if [ "$hvir_stream_i" = 30 ]; then printf '%s\\n' "$hvir_stream_match"; fi; ` +
        `hvir_stream_i=$((hvir_stream_i+1)); sleep 0.02; done; printf '%s\\n' "$hvir_stream_done"\n`,
    )
    const readyDeadline = Date.now() + 3000
    while (!output.includes(READY)) {
      if (Date.now() > readyDeadline)
        throw new Error('streaming search producer did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const evidence = (await win.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 2500;
      const wait = async (predicate, message) => {
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error(message);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await wait(() => document.hasFocus(), 'streaming search window did not acquire focus');
      const surface = document.querySelector('.terminal-surface.active');
      const engine = surface?.querySelector('.terminal-engine-host');
      if (!engine) throw new Error('streaming terminal surface missing');
      engine.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF', shiftKey: true,
        ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
        bubbles: true, cancelable: true
      }));
      await wait(() => surface.querySelector('.terminal-search'), 'streaming search did not open');
      const search = surface.querySelector('.terminal-search');
      const input = search.querySelector('[aria-label="Find in terminal"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(MATCH)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const status = () => search.querySelector('.terminal-search-status')?.textContent?.trim();
      await wait(() => status() === '1 of 3', 'initial streaming search did not complete with three matches');
      search.querySelector('[aria-label="Next terminal match"]').click();
      await wait(() => status() === '2 of 3', 'non-first streaming occurrence not selected');
      const highlight = () => engine.querySelector('.terminal-search-match-highlight');
      const selectedRow = highlight()?.dataset.retainedRow;
      const selectedTop = highlight()?.style.top;
      if (!selectedRow || !selectedTop) throw new Error('selected streaming highlight missing');
      await wait(() => status() === '2 of 4', 'appended occurrence did not update the count while streaming');
      for (let i = 0; i < 12; i++) {
        if (highlight()?.dataset.retainedRow !== selectedRow || highlight()?.style.top !== selectedTop) {
          throw new Error('unrelated output moved the selected occurrence or viewport');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const copy = [...search.querySelectorAll('button')].find(button => button.textContent.trim() === 'Copy Match');
      copy.click();
      await wait(() => search.querySelector('.terminal-search-feedback')?.textContent?.trim() === 'Copied match.', 'streaming Copy Match failed: ' + (search.querySelector('.terminal-search-feedback')?.textContent || '') + ', disabled=' + copy.disabled);
      search.querySelector('[aria-label="Previous terminal match"]').click();
      await wait(() => status() === '1 of 4', 'streaming previous navigation failed');
      search.querySelector('[aria-label="Next terminal match"]').click();
      await wait(() => status() === '2 of 4', 'streaming next navigation failed');
      search.querySelector('[aria-label="Close terminal search"]').click();
      // Leave later Canvas fixtures at the live viewport through a real gesture.
      engine.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', {
        deltaY: 1000000, bubbles: true, cancelable: true
      }));
      return { selectedRow, selectedTop, elapsedMs: Math.round(2500 - (deadline - performance.now())) };
    })()`)) as { selectedRow: string; selectedTop: string; elapsedMs: number }
    if (completed) throw new Error('streaming search finished after the finite producer')
    if (clipboard.readText() !== MATCH)
      throw new Error('streaming Copy Match returned different text')
    const deadline = Date.now() + 7000
    while (!completed) {
      if (Date.now() > deadline)
        throw new Error('finite terminal producer did not finish')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return `streaming nominal 50 Hz × 150 iterations, ${(completedAt! - readyAt!).toFixed(0)} ms producer duration including 200 ms start delay, 2.5 s search/7 s completion timeouts, updated count and stable second occurrence/viewport in ${evidence.elapsedMs} ms`
  } finally {
    await detach()
  }
}
