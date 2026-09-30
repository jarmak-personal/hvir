import { clipboard, type BrowserWindow } from 'electron'
import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { SmokeCleanup } from './cleanup'
import { createDiffReadabilityFixtures } from './diff-readability-fixture'

/** Real production-composed Git inputs, Shiki worker, CodeMirror, selection, and paint. */
export async function verifyDiffReadability(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<string> {
  const cleanup = new SmokeCleanup()
  const originalClipboard = clipboard.readText()
  cleanup.defer('diff readability clipboard', () =>
    clipboard.writeText(originalClipboard),
  )
  try {
    const fixtures = await createDiffReadabilityFixtures(host, root, cleanup)
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
    const fixture = fixtures[0]!
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
        [...document.querySelectorAll('.file-row')].find(node => node.getAttribute('title') === ${JSON.stringify(fixture.path.path)}).click();
        await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title') === ${JSON.stringify(fixture.path.path)}, 'Copy fixture did not activate');
        [...document.querySelectorAll('.mode-control button')].find(node => node.textContent?.trim() === 'diff').click();
        const base = await waitFor(() => document.querySelector('.diff-base-select'), 'Copy base control missing');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(base, 'working-tree');
        base.dispatchEvent(new Event('change', { bubbles: true }));
        const control = await waitFor(() => document.querySelector('.cm-collapsedLines[role="button"]'), 'Copy context control missing');
        control.click();
        const line = await waitFor(() => [...document.querySelectorAll('.cm-merge-b .cm-line')].find(node => node.textContent?.includes('original line readable')), 'Long diff line missing');
        const range = document.createRange(); range.selectNodeContents(line);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      })()
    `)
    win.webContents.copy()
    const expected = fixture.current
      .split('\n')
      .find((line) => line.includes('original line readable'))
    // Clipboard copy runs in the renderer; observe the actual clipboard value, bounded by a deadline.
    const deadline = Date.now() + 1000
    while (clipboard.readText() !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (clipboard.readText() !== expected)
      throw new Error('Copy changed the original diff line')
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.viewer-tab')].filter(tab =>
        ${JSON.stringify(fixtures.map((fixture) => fixture.path.path))}.includes(tab.querySelector('.tab-main')?.getAttribute('title'))
      ).forEach(tab => tab.querySelector('.tab-close')?.click())
    `)
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
