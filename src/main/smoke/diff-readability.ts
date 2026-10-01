import { clipboard, type BrowserWindow } from 'electron'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'
import { verifyDiffCopy } from './diff-copy'
import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { SmokeCleanup } from './cleanup'
import { createDiffReadabilityFixtures } from './diff-readability-fixture'

/** Real production-composed Git inputs, Shiki worker, CodeMirror, selection, and paint. */
export async function verifyDiffReadability(
  win: BrowserWindow,
  host: Pick<ProjectHost, 'exec' | 'writeFile'>,
  root: HostPath,
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
): Promise<string> {
  const cleanup = new SmokeCleanup()
  const originalFormats = clipboard.availableFormats()
  const originalImage = originalFormats.includes('image/png')
    ? clipboard.readImage()
    : undefined
  const originalBookmark =
    process.platform === 'darwin' ? clipboard.readBookmark() : undefined
  const originalClipboard = {
    ...(originalFormats.includes('text/plain') ? { text: clipboard.readText() } : {}),
    ...(originalFormats.includes('text/html') ? { html: clipboard.readHTML() } : {}),
    ...(originalFormats.includes('text/rtf') ? { rtf: clipboard.readRTF() } : {}),
    ...(originalImage && !originalImage.isEmpty() ? { image: originalImage } : {}),
    ...(originalBookmark?.title && originalBookmark.url
      ? { bookmark: originalBookmark.title }
      : {}),
  }
  cleanup.defer('diff readability clipboard', () => {
    clipboard.clear()
    if (originalFormats.length > 0) clipboard.write(originalClipboard)
  })
  try {
    const fixtures = await createDiffReadabilityFixtures(host, root, cleanup)
    cleanup.defer('diff readability tabs', async () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      await win.webContents.executeJavaScript(`
        (async () => {
          const paths = ${JSON.stringify(fixtures.map((fixture) => fixture.path.path))};
          const tabs = () => [...document.querySelectorAll('.viewer-tab')].filter(tab =>
            paths.includes(tab.querySelector('.tab-main')?.getAttribute('title')));
          tabs().forEach(tab => tab.querySelector('.tab-close')?.click());
          const deadline = Date.now() + 5000;
          while (tabs().length && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          if (tabs().length) throw new Error('Diff fixture tabs did not close');
        })()
      `)
    })
    checkpoint('viewer-content-diff-presentation-awaiting')
    await win.webContents.executeJavaScript(`
      (async () => {
        const waitFor = async (test, message) => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const value = test();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error(message);
        };
        const fixtures = ${JSON.stringify(fixtures)};
        const originalTheme = document.documentElement.dataset.theme;
        const originalWidth = document.querySelector('.viewer-body')?.style.width ?? '';
        const modeButton = mode => [...document.querySelectorAll('.mode-control button')]
          .find(node => node.textContent?.trim() === mode);
        try {
          for (const theme of ['dark', 'light']) {
            if (document.documentElement.dataset.theme !== theme) document.querySelector('.theme-toggle')?.click();
            await waitFor(() => document.documentElement.dataset.theme === theme, 'Diff theme did not change');
            for (const fixture of fixtures) {
              const row = await waitFor(() => [...document.querySelectorAll('.file-row')]
                .find(node => node.getAttribute('title') === fixture.path.path), 'Diff fixture missing');
              row.click();
              await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title') === fixture.path.path, 'Diff fixture did not activate');
              modeButton('diff')?.click();
              const select = await waitFor(() => document.querySelector('.diff-base-select'), 'Diff base control missing');
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
              setter.call(select, 'working-tree');
              select.dispatchEvent(new Event('change', { bubbles: true }));
              const shell = await waitFor(() => {
                const node = document.querySelector('.diff-shell');
                return node?.querySelectorAll('.diff-labels small').length === 2 &&
                  [...node.querySelectorAll('.diff-labels small')].every(label => label.textContent === fixture.language) ? node : undefined;
              }, 'Both diff sides did not finish highlighting');
              const body = document.querySelector('.viewer-body');
              body.style.width = '580px';
              await waitFor(() => shell.getBoundingClientRect().width <= 580, 'Narrow diff did not resize');
              for (const status of shell.querySelectorAll('.diff-labels small')) {
                if (getComputedStyle(status).display === 'none') throw new Error('Narrow diff hides highlight status');
              }
              for (const side of ['a', 'b']) {
                const editor = shell.querySelector('.cm-merge-' + side);
                if (!editor.querySelector('.cm-content [style*="color"]')) throw new Error('Diff syntax colors missing');
                if (!editor.querySelector('.cm-diff-group-start')) throw new Error('Diff group boundary missing');
                const marker = editor.querySelector('.cm-changedLineGutter');
                const symbol = getComputedStyle(marker, '::before').content;
                if (!symbol.includes(side === 'a' ? '−' : '+')) throw new Error('Diff non-color cue missing');
                const line = editor.querySelector('.cm-changedLine');
                const word = editor.querySelector('.cm-changedText');
                if (getComputedStyle(line).backgroundColor === getComputedStyle(word).backgroundColor) throw new Error('Diff exact edit emphasis missing');
              }
              const collapse = await waitFor(() => shell.querySelector('.cm-collapsedLines[role="button"]'), 'Collapsed context not keyboard reachable');
              if (collapse.tabIndex !== 0) throw new Error('Collapsed context is not tabbable');
              collapse.focus();
              collapse.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await waitFor(() => !collapse.isConnected, 'Keyboard context expansion failed');
              const wrap = shell.querySelector('.diff-controls button');
              if (wrap.getAttribute('aria-pressed') !== 'true') throw new Error('Wrapping default missing');
              const merge = shell.querySelector('.cm-mergeView');
              wrap.click();
              await waitFor(() => wrap.getAttribute('aria-pressed') === 'false', 'Wrapping toggle failed');
              if (shell.querySelector('.cm-mergeView') !== merge) throw new Error('Wrapping replaced the diff');
              wrap.click();
              await waitFor(() => wrap.getAttribute('aria-pressed') === 'true', 'Wrapping did not restore');
              modeButton('source')?.click();
              await waitFor(() => document.querySelector('.source-shell'), 'Diff did not return to source');
              body.style.width = originalWidth;
            }
          }
        } finally {
          const body = document.querySelector('.viewer-body');
          if (body) body.style.width = originalWidth;
          if (document.documentElement.dataset.theme !== originalTheme) document.querySelector('.theme-toggle')?.click();
        }
      })()
    `)
    checkpoint('viewer-content-diff-presentation-ready')
    await verifyDiffCopy(win, fixtures[0]!, checkpoint)
  } catch (error) {
    try {
      await cleanup.run()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Diff readability acceptance and cleanup failed',
        { cause: cleanupError },
      )
    }
    throw error
  }
  await cleanup.run()
  return 'TS/JSON/prose · dark/light · narrow diff · syntax and exact edits · keyboard context · wrapping · exact copy'
}
