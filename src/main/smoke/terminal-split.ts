import type { BrowserWindow } from 'electron'

export async function verifyTerminalSplit(win: BrowserWindow): Promise<void> {
  const splitStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const terminalSplit = () => {
          const button = document.querySelector('.terminal-split-button');
          const before = document.querySelectorAll('.terminal-list-row').length;
          if (!button) return reject(new Error('terminal split control missing'));
          button.click();
          const waitForTerminal = () => {
            const deck = document.querySelector('.terminal-deck:not([hidden])');
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const visible = deck?.querySelectorAll('.terminal-surface.visible canvas').length || 0;
            if (deck?.classList.contains('split') && rows.length === before + 1 && visible === 2) {
              const divider = deck.querySelector('.terminal-split-resizer');
              if (!divider) return reject(new Error('terminal split divider missing'));
              if (divider.getBoundingClientRect().width > 1.5) {
                return reject(new Error('terminal split divider is wider than its hairline'));
              }
              const left = deck.querySelector('[data-terminal-slot="primary"].visible');
              const widthBefore = left?.getBoundingClientRect().width || 0;
              divider.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowRight', bubbles: true
              }));
              return requestAnimationFrame(() => {
                const widthAfter = left?.getBoundingClientRect().width || 0;
                if (widthAfter <= widthBefore) return reject(new Error('terminal split did not resize'));
                rows.at(-1)?.querySelector('.terminal-close-button')?.click();
                const waitForCollapse = () => {
                  if (!deck.classList.contains('split') &&
                      document.querySelectorAll('.terminal-list-row').length === before) {
                    return resolve('terminal PTY split + keyboard divider');
                  }
                  setTimeout(waitForCollapse, 50);
                };
                waitForCollapse();
              });
            }
            setTimeout(waitForTerminal, 50);
          };
          waitForTerminal();
        };
        terminalSplit();
      })
    `)) as string
  console.log(`[smoke] split panes OK (${splitStatus})`)
}
