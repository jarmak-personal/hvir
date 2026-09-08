import type { BrowserWindow } from 'electron'

export async function verifyAppSettings(win: BrowserWindow): Promise<void> {
  const settingsStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        document.querySelector('.settings-toggle')?.click();
        requestAnimationFrame(() => {
          const dialog = document.querySelector('.settings-dialog');
          const sections = [...(dialog?.querySelectorAll(
            '.settings-section-index button'
          ) || [])];
          const appearance = dialog?.querySelector('#settings-appearance-title');
          if (!dialog || !appearance || sections.length !== 5) {
            return reject(new Error('settings surface incomplete'));
          }
          sections.find((button) => button.textContent?.trim() === 'Keybindings')?.click();
          requestAnimationFrame(() => {
          const keybindings = dialog.querySelector('.settings-keybindings textarea');
          if (!keybindings?.value.includes('toggleTerminalFocus')) {
            return reject(new Error('keybindings section did not activate'));
          }
          const terminalFocused = document.querySelector('.workbench')
            ?.classList.contains('terminal-focused');
          document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'J', code: 'KeyJ', bubbles: true, shiftKey: true,
            metaKey: navigator.platform.includes('Mac'),
            ctrlKey: !navigator.platform.includes('Mac')
          }));
          keybindings.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true
          }));
          requestAnimationFrame(() => {
            const openDialog = document.querySelector('.settings-dialog');
            if (!openDialog || document.querySelector('.workbench')
                ?.classList.contains('terminal-focused') !== terminalFocused) {
              return reject(new Error('settings modal leaked a global shortcut or textarea Escape'));
            }
            sections.find((button) => button.textContent?.trim() === 'Terminal')?.click();
            requestAnimationFrame(() => {
            const idle = openDialog.querySelector('#settings-idle-threshold');
            if (!idle) return reject(new Error('idle threshold control missing'));
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
              ?.set?.call(idle, '');
            idle.dispatchEvent(new Event('input', { bubbles: true }));
            requestAnimationFrame(() => {
              [...openDialog.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === 'Save app settings')?.click();
              requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const validation = document.querySelector('.settings-dialog .dialog-error')
                  ?.textContent || '';
                if (!/idle threshold/i.test(validation)) {
                  return reject(new Error('blank idle threshold did not show validation'));
                }
                if (openDialog.querySelector('[aria-current="page"]')
                    ?.textContent?.trim() !== 'Terminal' || document.activeElement !== idle) {
                  return reject(new Error('settings validation did not target its section'));
                }
                [...openDialog.querySelectorAll('button')]
                  .find((button) => button.textContent?.trim() === 'Close settings')?.click();
                requestAnimationFrame(() => {
                  if (document.querySelector('.settings-dialog')) {
                    return reject(new Error('settings dialog did not close'));
                  }
                  resolve('5 sections · modal isolation · validation focus');
                });
              });
              });
            });
          });
          });
          });
        });
      })
    `)) as string
  console.log(`[smoke] minimal settings OK (${settingsStatus})`)
}
