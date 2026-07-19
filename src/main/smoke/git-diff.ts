import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'

/** Behavioral acceptance for Git bases and bidirectional source/diff line anchors. */
export function verifyGitDiffBehavior(
  win: BrowserWindow,
  liveReloadPath: HostPath,
): Promise<string> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const waitFor = (test, message) => new Promise((done, fail) => {
        const poll = () => {
          const value = test();
          if (value) return done(value);
          if (Date.now() > deadline) return fail(new Error(message));
          setTimeout(poll, 50);
        };
        poll();
      });
      const visibleLine = (root, selector) => {
        const viewportTop = root.getBoundingClientRect().top;
        const markers = [...root.querySelectorAll(selector)]
          .filter((node) => /^[0-9]+$/.test(node.textContent?.trim() || ''))
          .sort((left, right) =>
            left.getBoundingClientRect().top - right.getBoundingClientRect().top
          );
        const marker = markers.find(
          (node) => node.getBoundingClientRect().bottom > viewportTop + 1
        );
        return marker ? Number(marker.textContent?.trim()) : undefined;
      };
      const waitForLineAnchor = async (
        root,
        currentRoot,
        selector,
        expected,
        label
      ) => {
        let actual;
        let connected = false;
        for (;;) {
          connected = root.isConnected && currentRoot() === root;
          actual = connected ? visibleLine(root, selector) : undefined;
          if (actual !== undefined && Math.abs(actual - expected) <= 1) return actual;
          if (Date.now() > deadline) {
            throw new Error(
              label + ': expected=' + expected + ' actual=' + actual +
                ' scroll=' + Math.round(root.scrollTop) +
                ' max=' + Math.round(root.scrollHeight - root.clientHeight) +
                ' connected=' + connected
            );
          }
          await new Promise((done) => setTimeout(done, 50));
        }
      };
      const waitForScrollableMerge = () => waitFor(
        () => {
          const merge = document.querySelector('.cm-mergeView');
          return merge && merge.scrollHeight > merge.clientHeight + 40
            ? merge
            : undefined;
        },
        'long diff did not create scroll extent'
      );
      const waitForScrolledMerge = async () => {
        let attempts = 0;
        let lastActual = 0;
        let lastMax = 0;
        for (;;) {
          const candidate = await waitForScrollableMerge();
          const maxScroll = candidate.scrollHeight - candidate.clientHeight;
          const targetScroll = Math.min(120, maxScroll);
          attempts += 1;
          candidate.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true })
          );
          candidate.scrollTop = targetScroll;
          candidate.dispatchEvent(new Event('scroll'));
          let stableSamples = 0;
          while (stableSamples < 3) {
            await new Promise((done) => setTimeout(done, 50));
            lastActual = candidate.scrollTop;
            lastMax = maxScroll;
            if (
              !candidate.isConnected ||
              document.querySelector('.cm-mergeView') !== candidate ||
              Math.abs(candidate.scrollTop - targetScroll) > 2
            ) {
              break;
            }
            stableSamples += 1;
          }
          if (stableSamples === 3) return candidate;
          if (Date.now() > deadline) {
            throw new Error(
              'long diff scroll did not settle after ' + attempts +
                ' attempts: actual=' + lastActual + ' max=' + lastMax
            );
          }
        }
      };
      (async () => {
        const file = await waitFor(
          () => [...document.querySelectorAll('.file-row')]
            .find((node) => node.getAttribute('title')?.endsWith('/package.json')),
          'package.json missing'
        );
        file.click();
        await waitFor(
          () => document.querySelector('.viewer-tab.active .tab-name')?.textContent
            ?.includes('package.json'),
          'package.json did not become active'
        );
        const diffButton = await waitFor(
          () => [...document.querySelectorAll('.mode-control button')]
            .find((node) => node.textContent?.trim() === 'diff'),
          'diff mode button missing'
        );
        diffButton.click();
        const expectations = [
          ['head', 'HEAD'],
          ['branch-point', 'Branch point'],
          ['working-tree', 'Index']
        ];
        for (const [base, label] of expectations) {
          const select = await waitFor(
            () => document.querySelector('.diff-base-select'),
            'diff base selector missing'
          );
          select.value = base;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(
            () => document.querySelector('.cm-mergeView') &&
              document.querySelector('.diff-labels')?.textContent?.includes(label),
            'diff did not render base ' + base
          );
        }

        const longFile = await waitFor(
          () => [...document.querySelectorAll('.file-row')]
            .find((node) => node.getAttribute('title') ===
              ${JSON.stringify(liveReloadPath.path)}),
          'long diff fixture missing'
        );
        longFile.click();
        await waitFor(
          () => document.querySelector('.viewer-tab.active .tab-name')?.textContent
            ?.includes('.hvir-smoke-live.txt'),
          'long diff fixture did not become active'
        );
        const longDiffButton = await waitFor(
          () => [...document.querySelectorAll('.mode-control button')]
            .find((node) => node.textContent?.trim() === 'diff'),
          'long diff mode button missing'
        );
        longDiffButton.click();

        const scrollableMerge = await waitForScrolledMerge();
        const initialDiffLine = await waitFor(
          () => visibleLine(
            scrollableMerge,
            '.cm-merge-b .cm-lineNumbers .cm-gutterElement'
          ),
          'long diff gutter did not materialize'
        );
        const sourceButton = [...document.querySelectorAll('.mode-control button')]
          .find((node) => node.textContent?.trim() === 'source');
        sourceButton?.click();
        const sourceScroller = await waitFor(
          () => document.querySelector('.source-shell .cm-scroller'),
          'source view did not replace long diff'
        );
        await waitForLineAnchor(
          sourceScroller,
          () => document.querySelector('.source-shell .cm-scroller'),
          '.cm-lineNumbers .cm-gutterElement',
          initialDiffLine,
          'diff→source line changed'
        );

        const sourceTargetScroll = Math.min(
          900,
          sourceScroller.scrollHeight - sourceScroller.clientHeight
        );
        const sourceLine = await waitFor(() => {
          sourceScroller.scrollTop = sourceTargetScroll;
          sourceScroller.dispatchEvent(new Event('scroll'));
          if (Math.abs(sourceScroller.scrollTop - sourceTargetScroll) > 2) return undefined;
          return visibleLine(sourceScroller, '.cm-lineNumbers .cm-gutterElement');
        }, 'source scroll anchor did not settle');
        const returnToDiff = [...document.querySelectorAll('.mode-control button')]
          .find((node) => node.textContent?.trim() === 'diff');
        returnToDiff?.click();
        const restoredMerge = await waitForScrollableMerge();
        const restoredDiffLine = await waitForLineAnchor(
          restoredMerge,
          () => document.querySelector('.cm-mergeView'),
          '.cm-merge-b .cm-lineNumbers .cm-gutterElement',
          sourceLine,
          'source→diff line changed'
        );
        resolve(
          expectations.map(([base]) => base).join(', ') +
            ' · line anchor ' + initialDiffLine + '→' + sourceLine + '→' +
            restoredDiffLine
        );
      })().catch(reject);
    })
  `) as Promise<string>
}
