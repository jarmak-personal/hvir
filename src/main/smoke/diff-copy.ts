import { clipboard, type BrowserWindow } from 'electron'
import type { HostPath } from '../../shared'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

/** Browser selection delivery and native clipboard remain real Electron contracts. */
export async function verifyDiffCopy(
  win: BrowserWindow,
  fixture: { readonly path: HostPath; readonly base: string; readonly current: string },
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
): Promise<void> {
  try {
    for (const side of ['a', 'b'] as const) {
      const expected = (side === 'a' ? fixture.base : fixture.current)
        .split('\n')
        .find((line) => line.includes('original line'))!
      checkpoint('viewer-content-diff-selection-awaiting')
      await win.webContents.executeJavaScript(`
        (async () => {
          const waitFor = async (test, message) => {
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              const value = test(); if (value) return value;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error(message);
          };
          if (document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title') !== ${JSON.stringify(fixture.path.path)}) {
            [...document.querySelectorAll('.file-row')].find(node => node.getAttribute('title') === ${JSON.stringify(fixture.path.path)})?.click();
          }
          await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title') === ${JSON.stringify(fixture.path.path)}, 'Copy fixture did not activate');
          if (!document.querySelector('.diff-shell')) {
            [...document.querySelectorAll('.mode-control button')].find(node => node.textContent?.trim() === 'diff')?.click();
          }
          const base = await waitFor(() => document.querySelector('.diff-base-select'), 'Copy base control missing');
          if (base.value !== 'working-tree') {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(base, 'working-tree');
            base.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const expected = ${JSON.stringify(expected)};
          const line = await waitFor(() => [...document.querySelectorAll('.cm-merge-${side} .cm-line')].find(node => node.textContent === expected), 'Copy diff line missing');
          const content = line.closest('.cm-content');
          const probe = { delivered: false, outputExact: false, intercepted: false };
          const copied = event => {
            if (!content.contains(event.target)) return;
            probe.delivered = true;
            probe.outputExact = event.clipboardData?.getData('text/plain') === expected;
            probe.intercepted = event.defaultPrevented;
          };
          document.addEventListener('copy', copied);
          probe.dispose = () => document.removeEventListener('copy', copied);
          globalThis.__hvirDiffCopyProbe = probe;
          // CodeMirror's existing document listener reads the DOM range on selectionchange.
          // Subscribe before changing it; resolving after that listener gives Chromium's
          // selection delivery a semantic boundary, without a delay or private editor access.
          await new Promise((resolve, reject) => {
            const dispose = () => {
              clearTimeout(timer);
              document.removeEventListener('selectionchange', changed);
            };
            const changed = () => {
              const selection = getSelection();
              if (selection && !selection.isCollapsed &&
                  content.contains(selection.anchorNode) && content.contains(selection.focusNode) &&
                  selection.toString() === expected) {
                dispose(); resolve();
              }
            };
            const timer = setTimeout(() => {
              dispose(); reject(new Error('Diff selection delivery did not become ready'));
            }, 1000);
            document.addEventListener('selectionchange', changed);
            const range = document.createRange(); range.selectNodeContents(line);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          });
        })()
      `)
      checkpoint('viewer-content-diff-selection-ready')
      // A prior matching clipboard cannot satisfy this attempt's exact-copy oracle.
      clipboard.writeText('hvir smoke diff copy pending')
      checkpoint('viewer-content-diff-copy-delivery-awaiting')
      win.webContents.copy()
      await win.webContents.executeJavaScript(`
        (async () => {
          const deadline = Date.now() + 1000;
          while (!globalThis.__hvirDiffCopyProbe?.delivered && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          if (!globalThis.__hvirDiffCopyProbe?.delivered) throw new Error('Diff copy event was not delivered');
        })()
      `)
      checkpoint('viewer-content-diff-copy-delivered')
      const deadline = Date.now() + 1000
      while (clipboard.readText() !== expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (clipboard.readText() !== expected) {
        checkpoint('viewer-content-diff-copy-text-mismatch')
        const evidence: unknown = await win.webContents.executeJavaScript(`
          (() => {
            const probe = globalThis.__hvirDiffCopyProbe;
            return { delivered: probe?.delivered === true, outputExact: probe?.outputExact === true, intercepted: probe?.intercepted === true };
          })()
        `)
        throw new Error(
          `Diff native clipboard text mismatch; evidence=${JSON.stringify(evidence)}`,
        )
      }
      checkpoint('viewer-content-diff-copy-exact')
      await releaseDiffCopyProbe(win)
    }
  } catch (error) {
    try {
      await releaseDiffCopyProbe(win)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Diff copy and probe cleanup failed',
        { cause: cleanupError },
      )
    }
    throw error
  }
  await releaseDiffCopyProbe(win)
}

async function releaseDiffCopyProbe(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  await win.webContents.executeJavaScript(`
    globalThis.__hvirDiffCopyProbe?.dispose();
    delete globalThis.__hvirDiffCopyProbe;
    getSelection()?.removeAllRanges();
  `)
}
