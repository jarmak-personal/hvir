import type { BrowserWindow } from 'electron'
import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'
import { runViewerPositionOperation } from './viewer-position-operation'

/** Exercise the intended document's real CodeMirror viewport across an external write. */
export async function verifyLiveReloadScroll(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly path: HostPath
  readonly contents: string
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<{ before: number; after: number }> {
  const { win, host, path, contents, checkpoint } = options
  const source = `
    const leaf = () => [...document.querySelectorAll('[data-viewer-pane]')].find(node =>
      node.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title') === ${JSON.stringify(path.path)});
    const scroller = () => leaf()?.querySelector('.source-shell .cm-scroller');
    const waitFor = async (test, condition) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const value = test();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(condition);
    };
  `
  const before = await runViewerPositionOperation({
    awaiting: 'viewer-content-reload-position-awaiting',
    ready: 'viewer-content-reload-position-ready',
    checkpoint,
    execute: () =>
      win.webContents.executeJavaScript(`(async () => {
      ${source}
      await waitFor(() => {
        const discard = [...document.querySelectorAll('.dirty-tab-close-dialog button')]
          .find(node => node.textContent?.trim() === 'Close without saving');
        if (discard) { discard.click(); return false; }
        const stale = [...document.querySelectorAll('.viewer-tab')].find(node =>
          node.querySelector('.tab-main')?.getAttribute('title') === ${JSON.stringify(path.path)} &&
          node.querySelector('.tab-status')?.textContent?.includes('●'));
        if (stale) { stale.querySelector('.tab-close')?.click(); return false; }
        return true;
      }, 'live-reload dirty fixture did not close');
      const file = await waitFor(() => [...document.querySelectorAll('.file-row')]
        .find(node => node.title === ${JSON.stringify(path.path)}), 'live-reload fixture missing');
      file.click();
      await waitFor(leaf, 'live-reload document did not activate');
      await waitFor(() => {
        if (scroller() && leaf()?.querySelector('.cm-content')?.textContent?.includes('line 20')) return true;
        [...(leaf()?.querySelectorAll('.mode-control button') || [])]
          .find(node => node.textContent?.trim() === 'source')?.click();
        return false;
      }, 'live-reload source document did not materialize');
      // Flush the open document's CodeMirror measurement before supplying a user
      // scroll, using the same paint boundary as the viewer-position fixture.
      // Idle callbacks may starve even while the renderer remains responsive.
      for (let frame = 0; frame < 2; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const viewport = scroller();
      if (viewport.scrollHeight - viewport.clientHeight < 220) throw new Error('live-reload fixture lacks scroll extent');
      viewport.scrollTop = 220;
      viewport.dispatchEvent(new Event('scroll'));
      await waitFor(() => scroller() === viewport && Math.abs(viewport.scrollTop - 220) <= 2 &&
        [...viewport.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].some(node =>
          Number(node.textContent) > 1 && node.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top),
        'live-reload initial scroll did not settle');
      return viewport.scrollTop;
    })()`) as Promise<number>,
  })
  await host.writeFile(path, contents.replace('line 20\n', 'line 20 external marker\n'))
  const after = await runViewerPositionOperation({
    awaiting: 'viewer-content-reload-restoration-awaiting',
    ready: 'viewer-content-reload-restoration-ready',
    checkpoint,
    execute: () =>
      win.webContents.executeJavaScript(`(async () => {
      ${source}
      await waitFor(() => leaf()?.querySelector('.cm-content')?.textContent?.includes('external marker') &&
        scroller() && Math.abs(scroller().scrollTop - ${before}) <= 2,
        'live-reload content and scroll restoration did not settle');
      return scroller().scrollTop;
    })()`) as Promise<number>,
  })
  return { before, after }
}
