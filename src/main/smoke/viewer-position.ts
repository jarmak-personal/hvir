import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'

/** Exercises keyboard routing and every direct rendered/source/diff position transition. */
export function verifyViewerPositions(
  win: BrowserWindow,
  path: HostPath,
  cleanPath: HostPath,
): Promise<string> {
  return win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 20000;
      const waitFor = (test, message) => new Promise((resolve, reject) => {
        const poll = () => {
          const value = test();
          if (value) return resolve(value);
          if (Date.now() > deadline) return reject(new Error(message));
          setTimeout(poll, 25);
        };
        poll();
      });
      const modeButton = (mode) => [...document.querySelectorAll('.mode-control button')]
        .find((node) => node.textContent?.trim() === mode);
      const activeMode = () => document.querySelector('.mode-control button.active')
        ?.textContent?.trim();
      const settle = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const visibleCodeLine = (root, selector) => {
        const viewportTop = root.getBoundingClientRect().top;
        const marker = [...root.querySelectorAll(selector)]
          .filter((node) => /^[0-9]+$/.test(node.textContent?.trim() || ''))
          .sort((left, right) =>
            left.getBoundingClientRect().top - right.getBoundingClientRect().top
          )
          .find((node) => node.getBoundingClientRect().bottom > viewportTop + 1);
        return marker ? Number(marker.textContent?.trim()) : undefined;
      };
      const visibleRenderedLine = (root) => {
        const viewportTop = root.getBoundingClientRect().top + 1;
        return [...root.querySelectorAll('[data-source-line]')]
          .map((node) => ({
            line: Number(node.getAttribute('data-source-line')),
            top: node.getBoundingClientRect().top
          }))
          .filter((anchor) => Number.isFinite(anchor.line) && anchor.top <= viewportTop)
          .sort((left, right) => right.top - left.top)[0]?.line;
      };
      const terminal = document.querySelector('.terminal-panel');
      const before = activeMode();
      const mac = /Mac/.test(navigator.platform);
      terminal?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'M', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true
      }));
      if (activeMode() !== before) throw new Error('terminal chord changed viewer mode');
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'M', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true
      }));
      await settle();
      if (!activeMode() || activeMode() === before) throw new Error('mode chord did not cycle');

      const file = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title') === ${JSON.stringify(path.path)}),
        'viewer position fixture missing'
      );
      file.click();
      const rendered = await waitFor(
        () => document.querySelector('.markdown-body'),
        'position fixture did not render'
      );
      const targetLine = 157;
      const target = await waitFor(
        () => rendered.querySelector('[data-source-line="' + targetLine + '"]'),
        'rendered source anchor missing'
      );
      rendered.scrollTop += target.getBoundingClientRect().top - rendered.getBoundingClientRect().top;
      rendered.dispatchEvent(new Event('scroll'));
      await settle();

      const transitions = [];
      const changeMode = async (from, to) => {
        modeButton(to)?.click();
        let root;
        let line;
        if (to === 'rendered') {
          root = await waitFor(() => document.querySelector('.markdown-body'), 'rendered missing');
          line = await waitFor(() => {
            const visible = visibleRenderedLine(root);
            return visible !== undefined && Math.abs(visible - targetLine) <= 4
              ? visible
              : undefined;
          }, from + '→rendered did not restore its line');
        } else if (to === 'source') {
          root = await waitFor(
            () => document.querySelector('.source-shell .cm-scroller'),
            'source missing'
          );
          line = await waitFor(() => {
            const visible = visibleCodeLine(root, '.cm-lineNumbers .cm-gutterElement');
            return visible !== undefined && Math.abs(visible - targetLine) <= 4
              ? visible
              : undefined;
          }, from + '→source did not restore its line');
        } else {
          root = await waitFor(
            () => document.querySelector('.cm-mergeView'),
            'diff missing'
          );
          line = await waitFor(() => {
            const visible = visibleCodeLine(
              root,
              '.cm-merge-b .cm-lineNumbers .cm-gutterElement'
            );
            return visible !== undefined && Math.abs(visible - targetLine) <= 4
              ? visible
              : undefined;
          }, from + '→diff did not restore its line');
        }
        if (line === undefined || Math.abs(line - targetLine) > 4) {
          const targetAnchor = root.querySelector?.('[data-source-line="' + targetLine + '"]');
          throw new Error(
            from + '→' + to + ' changed line ' + targetLine + '→' + line +
            ' scroll=' + Math.round(root.scrollTop) +
            ' max=' + Math.round(root.scrollHeight - root.clientHeight) +
            ' targetTop=' + Math.round(targetAnchor?.getBoundingClientRect().top || -1) +
            ' rootTop=' + Math.round(root.getBoundingClientRect().top)
          );
        }
        transitions.push(from + '→' + to);
      };

      await changeMode('rendered', 'source');
      await changeMode('source', 'rendered');
      await changeMode('rendered', 'diff');
      await changeMode('diff', 'rendered');
      await changeMode('rendered', 'source');
      await changeMode('source', 'diff');
      await changeMode('diff', 'source');

      const cleanFile = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title') === ${JSON.stringify(cleanPath.path)}),
        'clean diff fixture missing'
      );
      cleanFile.click();
      await waitFor(
        () => document.querySelector('.viewer-title')?.textContent
          ?.includes(${JSON.stringify(cleanPath.path.split('/').at(-1))}),
        'clean diff fixture did not open'
      );
      modeButton('source')?.click();
      const cleanSource = await waitFor(
        () => document.querySelector('.source-shell .cm-scroller'),
        'clean diff source missing'
      );
      cleanSource.scrollTop = Math.min(
        cleanSource.scrollHeight - cleanSource.clientHeight,
        cleanSource.clientHeight * 0.75
      );
      cleanSource.dispatchEvent(new Event('scroll'));
      await settle();
      const cleanLine = await waitFor(() => {
        const line = visibleCodeLine(cleanSource, '.cm-lineNumbers .cm-gutterElement');
        return line !== undefined && line > 1 ? line : undefined;
      }, 'clean diff source did not scroll');
      modeButton('diff')?.click();
      const emptyDiff = await waitFor(
        () => document.querySelector('.cm-mergeView'),
        'empty diff did not render'
      );
      if (emptyDiff.querySelector('.cm-changedLine')) {
        throw new Error('clean diff unexpectedly contained changes');
      }
      modeButton('source')?.click();
      const restoredCleanSource = await waitFor(
        () => document.querySelector('.source-shell .cm-scroller'),
        'source missing after empty diff'
      );
      await waitFor(() => {
        const line = visibleCodeLine(
          restoredCleanSource,
          '.cm-lineNumbers .cm-gutterElement'
        );
        return line !== undefined && Math.abs(line - cleanLine) <= 2 ? line : undefined;
      }, 'empty diff reset the source position');

      return 'keyboard isolated · line ' + targetLine + ' · ' + transitions.join(', ') +
        ' · empty diff preserved line ' + cleanLine;
    })()
  `) as Promise<string>
}
