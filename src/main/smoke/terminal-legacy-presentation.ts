import type { BrowserWindow } from 'electron'

/** Retain broad terminal presentation assertions only in the legacy workflow. */
export async function verifyLegacyTerminalPresentation(
  win: BrowserWindow,
): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const host = document.querySelector('.terminal-container');
      if (!(host instanceof HTMLElement)) throw new Error('terminal container missing');
      const inputHost = host.querySelector(':scope > .terminal-engine-host');
      if (!(inputHost instanceof HTMLElement)) throw new Error('terminal input host missing');
      const panel = host.closest('.terminal-panel');
      if (!(panel instanceof HTMLElement)) throw new Error('terminal panel missing');
      if (panel.querySelector(':scope > .panel-header')) {
        throw new Error('redundant terminal header is still mounted');
      }
      if (Math.abs(panel.getBoundingClientRect().top - host.getBoundingClientRect().top) > 1) {
        throw new Error('terminal canvas does not begin at the deck edge');
      }
      const rail = document.querySelector('.terminal-rail');
      if (!(rail instanceof HTMLElement)) throw new Error('terminal rail missing');
      if (parseFloat(getComputedStyle(rail).borderLeftWidth) !== 0) {
        throw new Error('terminal rail divider cannot open at the active entry');
      }
      const activeRow = rail.querySelector('.terminal-list-row.active');
      if (!(activeRow instanceof HTMLElement)) throw new Error('active terminal row missing');
      if (parseFloat(getComputedStyle(activeRow).borderTopLeftRadius) !== 0) {
        throw new Error('active terminal row still narrows its opening');
      }
      const activeBackground = getComputedStyle(activeRow).backgroundImage;
      if (!activeBackground.includes('linear-gradient') || !activeBackground.includes('80%')) {
        throw new Error('active terminal entry does not blend into the canvas');
      }
      inputHost.focus();
      const caret = getComputedStyle(inputHost).caretColor;
      if (caret !== 'transparent' && caret !== 'rgba(0, 0, 0, 0)') {
        throw new Error('browser caret is visible in terminal input host: ' + caret);
      }
      return 'headerless · canvas cursor only · flush active rail';
    })()
  `)) as string
}
