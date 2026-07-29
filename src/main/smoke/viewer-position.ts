import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'

export async function verifyFocusedViewer(
  win: BrowserWindow,
  sourcePath: HostPath,
  renderedPath: HostPath,
): Promise<string> {
  const virtualized = await verifySourceDiffPosition(win, sourcePath)
  const commands = await verifyViewerPositions(win, renderedPath)
  return `${virtualized} · ${commands}`
}

/** Retains keyboard routing and rendered-to-code position coverage in the legacy workflow. */
export function verifyViewerPositions(
  win: BrowserWindow,
  path: HostPath,
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
      await waitFor(
        () => document.querySelector('.viewer-tab.active .tab-main')
          ?.getAttribute('title') === ${JSON.stringify(path.path)},
        'viewer position fixture did not activate'
      );
      modeButton('rendered')?.click();
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

      modeButton('rendered')?.click();
      await waitFor(() => activeMode() === 'rendered', 'go-to-line fixture did not render');
      terminal?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'g', ctrlKey: true, bubbles: true
      }));
      await settle();
      if (document.querySelector('[aria-label="Go to line"]')) {
        throw new Error('terminal Ctrl+G opened viewer navigation');
      }
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'g', ctrlKey: true, bubbles: true
      }));
      const coordinate = await waitFor(
        () => document.querySelector('[aria-label="Go to line"] input'),
        'Ctrl+G did not open go-to-line'
      );
      const coordinateSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      coordinateSetter?.call(coordinate, '121:3');
      coordinate.dispatchEvent(new Event('input', { bubbles: true }));
      coordinate.closest('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
      const goToSource = await waitFor(
        () => document.querySelector('.source-shell .cm-scroller'),
        'go-to-line did not switch to source'
      );
      await waitFor(() => {
        const bounds = goToSource.getBoundingClientRect();
        const marker = [...goToSource.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
          .find((node) => node.textContent?.trim() === '121');
        if (!marker) return false;
        const markerBounds = marker.getBoundingClientRect();
        return markerBounds.bottom > bounds.top && markerBounds.top < bounds.bottom;
      }, 'go-to-line did not scroll to the requested line');
      await waitFor(() => {
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        const selectedLine = anchor instanceof Element
          ? anchor.closest('.cm-line')
          : anchor?.parentElement?.closest('.cm-line');
        if (!selection || !anchor || !selectedLine) return false;
        const marker = [...goToSource.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
          .find((node) => node.textContent?.trim() === '121');
        if (!marker || Math.abs(
          marker.getBoundingClientRect().top - selectedLine.getBoundingClientRect().top
        ) > 2) return false;
        const range = document.createRange();
        range.selectNodeContents(selectedLine);
        range.setEnd(anchor, selection.anchorOffset);
        return range.toString().length + 1 === 3;
      }, 'go-to-line did not place the requested column');

      const cleanFile = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title')?.endsWith('/package.json')),
        'clean diff fixture missing'
      );
      cleanFile.click();
      await waitFor(
        () => document.querySelector('.viewer-tab.active .tab-name')?.textContent
          ?.includes('package.json'),
        'clean diff fixture did not open'
      );
      modeButton('source')?.click();
      const cleanSource = await waitFor(
        () => document.querySelector('.source-shell .cm-scroller'),
        'clean diff source missing'
      );
      const cleanLine = await waitFor(() => {
        cleanSource.scrollTop = Math.min(
          cleanSource.scrollHeight - cleanSource.clientHeight,
          cleanSource.clientHeight * 0.75
        );
        cleanSource.dispatchEvent(new Event('scroll'));
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

      document.querySelector('[aria-label="Split viewer right"]')?.click();
      const secondary = await waitFor(
        () => document.querySelector('[data-viewer-pane="secondary"]'),
        'secondary viewer did not open'
      );
      secondary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const secondaryFile = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title')?.endsWith('/tsconfig.json')),
        'secondary viewer fixture missing'
      );
      secondaryFile.click();
      await waitFor(
        () => secondary.querySelector('.viewer-tab.active .tab-name')?.textContent
          ?.includes('tsconfig.json'),
        'secondary viewer fixture did not open in the focused pane'
      );
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'g', ctrlKey: true, bubbles: true
      }));
      const scopedControl = await waitFor(
        () => secondary.querySelector('[aria-label="Go to line"]'),
        'go-to-line did not target the focused secondary pane'
      );
      if (document.querySelectorAll('[aria-label="Go to line"]').length !== 1) {
        throw new Error('go-to-line opened in more than one viewer pane');
      }
      scopedControl.querySelector('input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      await waitFor(
        () => !secondary.querySelector('[aria-label="Go to line"]'),
        'go-to-line did not close on Escape'
      );
      secondary.querySelector('[aria-label="Close secondary viewer"]')?.click();
      await waitFor(
        () => !document.querySelector('[data-viewer-pane="secondary"]'),
        'secondary viewer did not close after scoped command coverage'
      );
      document.querySelector('[data-viewer-pane="primary"]')?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true })
      );

      return 'keyboard isolated · line ' + targetLine + ' · ' + transitions.join(', ') +
        ' · go-to 121:3 · split scoped · empty diff preserved line ' + cleanLine;
    })()
  `) as Promise<string>
}

/** Real CodeMirror acceptance for virtualized source/diff remount restoration. */
export function verifySourceDiffPosition(
  win: BrowserWindow,
  path: HostPath,
): Promise<string> {
  return win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 20000;
      const sourceSelector = '.source-shell .cm-scroller';
      const sourceGutter = '.cm-lineNumbers .cm-gutterElement';
      const diffSelector = '.cm-mergeView';
      const diffGutter = '.cm-merge-b .cm-lineNumbers .cm-gutterElement';
      let phase = 'starting';
      let observedSource;
      let observedDiff;
      let pendingDiffObserved = false;
      const activeMode = () => document.querySelector('.mode-control button.active')
        ?.textContent?.trim();
      const activePath = () => document.querySelector('.viewer-tab.active .tab-main')
        ?.getAttribute('title');
      const currentSource = () => document.querySelector(sourceSelector);
      const currentDiff = () => document.querySelector(diffSelector);
      const modeButton = (mode) => [...document.querySelectorAll('.mode-control button')]
        .find((node) => node.textContent?.trim() === mode);
      const gutterRange = (root, selector) => {
        if (!root) return undefined;
        const viewportTop = root.getBoundingClientRect().top;
        const markers = [...root.querySelectorAll(selector)]
          .map((node) => ({
            line: Number(node.textContent?.trim()),
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
            visible: getComputedStyle(node).visibility !== 'hidden'
          }))
          .filter((marker) =>
            Number.isFinite(marker.line) && marker.visible && marker.bottom - marker.top > 1
          )
          .sort((left, right) => left.top - right.top);
        const visible = markers.find((marker) => marker.bottom > viewportTop + 1)?.line;
        const lines = markers.map((marker) => marker.line);
        return {
          visible,
          first: lines.length > 0 ? Math.min(...lines) : undefined,
          last: lines.length > 0 ? Math.max(...lines) : undefined,
          count: lines.length
        };
      };
      const rootState = (root, current, selector) => root ? {
        connected: root.isConnected,
        current: current() === root,
        scroll: Math.round(root.scrollTop),
        maxScroll: Math.round(root.scrollHeight - root.clientHeight),
        gutter: gutterRange(root, selector)
      } : undefined;
      const snapshot = () => {
        const source = currentSource();
        const diff = currentDiff();
        const empty = document.querySelector('.viewer-empty');
        if (empty?.textContent?.includes('Preparing diff')) pendingDiffObserved = true;
        return {
          phase,
          mode: activeMode(),
          path: activePath(),
          source: rootState(source, currentSource, sourceGutter),
          diff: rootState(diff, currentDiff, diffGutter),
          observedSource: rootState(observedSource, currentSource, sourceGutter),
          observedDiff: rootState(observedDiff, currentDiff, diffGutter),
          diffState: {
            pendingObserved: pendingDiffObserved,
            labels: document.querySelector('.diff-labels')?.textContent?.trim(),
            empty: empty?.textContent?.trim(),
            changed: Boolean(diff?.querySelector('.cm-changedLine'))
          }
        };
      };
      const fail = (message) => {
        throw new Error(message + ': ' + JSON.stringify(snapshot()));
      };
      const waitFor = async (test, message) => {
        for (;;) {
          snapshot();
          const value = test();
          if (value) return value;
          if (Date.now() > deadline) fail(message);
          await new Promise((painted) => requestAnimationFrame(painted));
        }
      };
      const virtualized = (root, selector, expected) => {
        const range = gutterRange(root, selector);
        return range?.visible !== undefined && range.first > 1 && range.count < 120 &&
          (expected === undefined || Math.abs(range.visible - expected) <= 1)
          ? range
          : undefined;
      };
      const scrollDeep = async (root, selector, minimum, markDiffNavigation = false) => {
        await new Promise((ready) => requestIdleCallback(ready, { timeout: 1000 }));
        const maxScroll = root.scrollHeight - root.clientHeight;
        const target = Math.min(maxScroll, Math.max(minimum, root.clientHeight * 3));
        if (target <= 0) fail('CodeMirror did not create a scroll extent');
        if (markDiffNavigation) {
          root.dispatchEvent(new WheelEvent('wheel', { deltaY: target, bubbles: true }));
        }
        root.scrollTop = target;
        root.dispatchEvent(new Event('scroll'));
        return waitFor(
          () => Math.abs(root.scrollTop - target) <= 2 && virtualized(root, selector),
          'deep CodeMirror viewport did not materialize'
        );
      };

      phase = 'open-source';
      const file = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title') === ${JSON.stringify(path.path)}),
        'viewer position fixture missing'
      );
      file.click();
      await waitFor(() => activePath() === ${JSON.stringify(path.path)}, 'fixture did not activate');
      if (activeMode() !== 'source') {
        const sourceButton = await waitFor(() => modeButton('source'), 'source mode missing');
        sourceButton.click();
      }
      observedSource = await waitFor(() => currentSource(), 'source CodeMirror missing');
      const initialSource = await scrollDeep(observedSource, sourceGutter, 900);
      const sourceLine = initialSource.visible;

      phase = 'source-to-diff';
      const diffButton = await waitFor(() => modeButton('diff'), 'diff mode missing');
      diffButton.click();
      await waitFor(() => !observedSource.isConnected, 'source CodeMirror did not unmount');
      observedDiff = await waitFor(() => {
        const root = currentDiff();
        return root && virtualized(root, diffGutter, sourceLine) ? root : undefined;
      }, 'async MergeView did not restore the source line');
      const sourceToDiff = gutterRange(observedDiff, diffGutter);

      phase = 'diff-to-source';
      const deepDiff = await scrollDeep(observedDiff, diffGutter, 1500, true);
      const diffLine = deepDiff.visible;
      const returnToSource = await waitFor(() => modeButton('source'), 'source mode missing');
      returnToSource.click();
      await waitFor(() => !observedDiff.isConnected, 'MergeView did not unmount');
      const restoredSource = await waitFor(() => {
        const root = currentSource();
        return root && root !== observedSource && virtualized(root, sourceGutter, diffLine)
          ? root
          : undefined;
      }, 'remounted source did not restore the diff line');
      const diffToSource = gutterRange(restoredSource, sourceGutter);

      phase = 'complete';
      return 'virtualized source ' + sourceLine + '→diff ' + sourceToDiff.visible +
        '→virtualized diff ' + diffLine + '→source ' + diffToSource.visible +
        ' · materialized source=' + initialSource.first + '-' + initialSource.last +
        '/' + initialSource.count + ' diff=' + deepDiff.first + '-' + deepDiff.last +
        '/' + deepDiff.count;
    })()
  `) as Promise<string>
}
