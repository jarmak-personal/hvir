import type { BrowserWindow } from 'electron'

/** Behavioral acceptance for the three user-visible Git diff bases. */
export function verifyGitDiffBases(win: BrowserWindow): Promise<string> {
  return win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 15000;
      const waitFor = async (test, message) => {
        for (;;) {
          const value = test();
          if (value) return value;
          if (Date.now() > deadline) throw new Error(message);
          await new Promise((painted) => requestAnimationFrame(painted));
        }
      };
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
      const diff = await waitFor(
        () => [...document.querySelectorAll('.mode-control button')]
          .find((node) => node.textContent?.trim() === 'diff'),
        'diff mode button missing'
      );
      diff.click();
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
      return expectations.map(([base]) => base).join(', ');
    })()
  `) as Promise<string>
}
