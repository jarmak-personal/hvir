import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'

export function verifyViewerFind(
  win: BrowserWindow,
  sourcePath: HostPath,
  renderedPath: HostPath,
  largePath: HostPath,
  collapsedDiffPath: HostPath,
  focusPath: HostPath,
): Promise<string> {
  return win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 30000;
      const mac = /Mac/.test(navigator.platform);
      const chord = (target) => target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', ctrlKey: !mac, metaKey: mac, bubbles: true
      }));
      const settle = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const waitFor = async (test, message) => {
        for (;;) {
          const value = test();
          if (value) return value;
          if (Date.now() > deadline) throw new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const activeMode = () => document.querySelector('.mode-control button.active')
        ?.textContent?.trim();
      const modeButton = (mode, root = document) => [...root.querySelectorAll(
        '.mode-control button'
      )].find((node) => node.textContent?.trim() === mode);
      const activePath = (root = document) => root.querySelector(
        '.viewer-tab.active .tab-main'
      )?.getAttribute('title');
      const openFile = async (path) => {
        const row = await waitFor(
          () => [...document.querySelectorAll('.file-row')]
            .find((node) => node.getAttribute('title') === path),
          'find fixture missing from tree: ' + path
        );
        row.click();
        await waitFor(() => activePath() === path, 'find fixture did not activate: ' + path);
      };
      const revealRenderedFixture = async () => {
        for (const suffix of ['/test', '/test/fixtures']) {
          const row = await waitFor(
            () => [...document.querySelectorAll('.directory-row')]
              .find((node) => node.getAttribute('title')?.endsWith(suffix)),
            'rendered find directory missing: ' + suffix
          );
          if (row.getAttribute('aria-expanded') !== 'true') row.click();
        }
        await openFile(${JSON.stringify(renderedPath.path)});
      };
      const switchMode = async (mode, root = document) => {
        if (activeMode() !== mode) modeButton(mode, root)?.click();
        await waitFor(() => activeMode() === mode, 'find mode did not switch to ' + mode);
      };
      const currentControl = (root = document) => root.querySelector(
        '[aria-label="Find in file"]'
      );
      const openFind = async (root = document) => {
        chord(window);
        return waitFor(
          () => currentControl(root),
          'Ctrl/Cmd+F did not open find in the expected viewer'
        );
      };
      const setQuery = async (control, value, expected) => {
        const input = control.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return waitFor(() => {
          const status = control.querySelector('[role="status"]')?.textContent?.trim();
          return expected(status) ? status : undefined;
        }, 'find query did not settle: ' + value);
      };
      const closeFind = async (control) => {
        control.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true
        }));
        await waitFor(() => !control.isConnected, 'Escape did not close find');
      };

      await openFile(${JSON.stringify(sourcePath.path)});
      await switchMode('source');
      if (!document.querySelector('.terminal-panel')) {
        const createTerminal = await waitFor(
          () => document.querySelector('.terminal-empty button'),
          'new-terminal control missing for find shortcut isolation'
        );
        createTerminal.click();
      }
      const terminal = await waitFor(
        () => document.querySelector('.terminal-panel'),
        'terminal surface did not mount for find shortcut isolation'
      );
      chord(terminal);
      await settle();
      if (currentControl()) throw new Error('terminal Ctrl/Cmd+F opened viewer find');

      let control = await openFind();
      let status = await setQuery(control, 'line 23', (text) => text === '1 of 11');
      await waitFor(
        () => document.querySelector('.source-shell .cm-hvir-find-match-active'),
        'source find did not visibly highlight its active match'
      );
      const input = control.querySelector('input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(
        () => control.querySelector('[role="status"]')?.textContent?.trim() === '2 of 11',
        'source find did not move next'
      );
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: true, bubbles: true
      }));
      await waitFor(
        () => control.querySelector('[role="status"]')?.textContent?.trim() === '1 of 11',
        'source find did not move previous'
      );
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: true, bubbles: true
      }));
      status = await waitFor(() => {
        const text = control.querySelector('[role="status"]')?.textContent?.trim();
        return text === '11 of 11' ? text : undefined;
      }, 'source previous navigation did not wrap');

      modeButton('diff')?.click();
      await waitFor(() => activeMode() === 'diff', 'source find did not change to diff');
      await waitFor(() => !control.isConnected, 'mode change retained source find state');
      await waitFor(() => document.querySelector('.cm-mergeView'), 'find diff did not render');
      control = await openFind();
      const diffStatus = await setQuery(
        control,
        'line 23',
        (text) => text === '1 of 11 · current'
      );
      await waitFor(
        () => document.querySelector('.cm-merge-b .cm-hvir-find-match-active'),
        'diff find did not visibly highlight its active match'
      );
      await closeFind(control);

      await revealRenderedFixture();
      await switchMode('rendered');
      await waitFor(
        () => document.querySelector('.markdown-body .mermaid-diagram svg'),
        'rendered Mermaid fixture did not materialize'
      );
      control = await openFind();
      const renderedStatus = await setQuery(
        control,
        'Follow-up',
        (text) => text === '1 of 1'
      );
      if (CSS.highlights.size < 2) throw new Error('rendered find did not highlight its match');
      const mermaidStatus = await setQuery(
        control,
        'harness',
        (text) => text === '1 of 1'
      );
      const activeHighlight = [...CSS.highlights.entries()]
        .find(([name]) => name.includes('find-active'))?.[1];
      const activeRange = activeHighlight ? [...activeHighlight][0] : undefined;
      const activeParent = activeRange?.startContainer instanceof Element
        ? activeRange.startContainer
        : activeRange?.startContainer.parentElement;
      if (!activeParent?.closest('svg')) {
        throw new Error('Mermaid label search did not activate visible SVG text');
      }
      const matchCase = [...control.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Match case'))?.querySelector('input');
      matchCase?.click();
      await waitFor(
        () => control.querySelector('[role="status"]')?.textContent?.trim() === 'No matches',
        'rendered match-case toggle did not update results'
      );
      await closeFind(control);
      if ([...CSS.highlights.keys()].some((name) => name.startsWith('hvir-find'))) {
        throw new Error('closing rendered find retained highlights');
      }

      await openFile(${JSON.stringify(collapsedDiffPath.path)});
      await switchMode('diff');
      await waitFor(
        () => document.querySelector('.cm-mergeView .cm-collapsedLines'),
        'clean diff did not contain collapsed unchanged content'
      );
      control = await openFind();
      const collapsedStatus = await setQuery(
        control,
        'hvir may surface rich read-only information',
        (text) => text === '1 of 2 · base'
      );
      await waitFor(
        () => !document.querySelector('.cm-mergeView .cm-collapsedLines'),
        'find did not reveal collapsed unchanged diff content'
      );
      await waitFor(
        () => document.querySelector('.cm-merge-a .cm-hvir-find-match-active'),
        'revealed base match was not visibly highlighted'
      );
      await closeFind(control);

      await openFile(${JSON.stringify(largePath.path)});
      await switchMode('source');
      await waitFor(() => document.querySelector('.large-file-preview'), 'large preview missing');
      control = await openFind();
      if (!control.textContent?.includes('Loaded preview only')) {
        throw new Error('large-file find did not disclose its loaded boundary');
      }
      const largeStatus = await setQuery(
        control,
        'responsiveness fixture',
        (text) => /^1 of [1-9][0-9]*$/.test(text || '')
      );
      await setQuery(control, 'end', (text) => text === 'No matches');
      await closeFind(control);

      document.querySelector('[aria-label="Split viewer right"]')?.click();
      const secondary = await waitFor(
        () => document.querySelector('[data-viewer-pane="secondary"]'),
        'find focus-routing split did not open'
      );
      secondary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const focusRow = await waitFor(
        () => [...document.querySelectorAll('.file-row')]
          .find((node) => node.getAttribute('title') === ${JSON.stringify(focusPath.path)}),
        'fresh file row missing before split find routing'
      );
      focusRow.click();
      await waitFor(
        () => activePath(secondary) === ${JSON.stringify(focusPath.path)},
        'fresh file did not open in focused secondary viewer'
      );
      control = await openFind(secondary);
      if (document.querySelectorAll('[aria-label="Find in file"]').length !== 1) {
        throw new Error('find opened in more than the focused viewer pane');
      }
      secondary.querySelector('[aria-label="Close secondary viewer"]')?.click();
      await waitFor(
        () => !document.querySelector('[data-viewer-pane="secondary"]'),
        'secondary viewer did not close after find routing'
      );
      if (document.querySelector('[aria-label="Find in file"]')) {
        throw new Error('closing a pane retained its find session');
      }

      return 'source ' + status + ' · diff ' + diffStatus + ' · rendered ' +
        renderedStatus + ' · Mermaid ' + mermaidStatus + ' · collapsed ' +
        collapsedStatus + ' · large ' + largeStatus + ' · terminal isolated · split scoped';
    })()
  `) as Promise<string>
}
