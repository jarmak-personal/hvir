import type { BrowserWindow } from 'electron'

/** Chromium proof for the shared rail details interaction and viewport owner. */
export async function verifySessionDetailsPopover(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const fail = (message) => reject(new Error(message));
      const waitFor = (predicate, label, attempts = 80) => {
        const value = predicate();
        if (value) return Promise.resolve(value);
        if (attempts <= 0) return Promise.reject(new Error(label));
        return new Promise((next) => setTimeout(next, 25))
          .then(() => waitFor(predicate, label, attempts - 1));
      };
      const run = async () => {
        const row = document.querySelector('.terminal-list-row.active');
        const origin = row?.querySelector('.terminal-list-main');
        if (!(row instanceof HTMLElement) || !(origin instanceof HTMLButtonElement)) {
          return fail('active terminal row missing for session details');
        }
        const activeSession = origin.dataset.terminalSession;
        const priorFocus = document.activeElement;
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        if (document.querySelector('.session-details-popover')) {
          return fail('hover opened session details');
        }
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: innerWidth - 2,
          clientY: innerHeight - 2,
        }));
        const pointerPopover = await waitFor(
          () => document.querySelector('.session-details-popover'),
          'right-click did not open session details'
        );
        const bounds = pointerPopover.getBoundingClientRect();
        if (
          bounds.left < 0 || bounds.top < 0 ||
          bounds.right > innerWidth || bounds.bottom > innerHeight
        ) return fail('session details escaped the viewport');
        if (
          document.querySelector('.terminal-list-row.active .terminal-list-main')
            ?.dataset.terminalSession !== activeSession ||
          document.activeElement !== priorFocus
        ) return fail('right-click changed terminal selection or focus');
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'outside click did not dismiss session details'
        );

        origin.focus();
        origin.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        const keyboardPopover = await waitFor(
          () => document.querySelector('.session-details-popover'),
          'Shift+F10 did not open session details'
        );
        if (keyboardPopover.querySelector('button') !== document.activeElement) {
          return fail('keyboard-opened session details did not receive focus');
        }
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'Escape did not dismiss session details'
        );
        if (document.activeElement !== origin) {
          return fail('session details did not restore keyboard focus');
        }

        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 40,
        }));
        await waitFor(
          () => document.querySelector('.session-details-popover'),
          'rail session details did not reopen before navigation'
        );
        const sessionsDestination = document.querySelector('.sessions-destination');
        if (!(sessionsDestination instanceof HTMLButtonElement)) {
          return fail('Sessions destination missing');
        }
        sessionsDestination.click();
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'navigation did not dismiss rail session details'
        );
        const card = await waitFor(
          () => document.querySelector('.session-card[aria-current="true"]') ||
            document.querySelector('.session-card'),
          'Sessions card missing for session details'
        );
        const selectedBefore = card.getAttribute('aria-current');
        const cardFocusBefore = document.activeElement;
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: innerWidth - 2,
          clientY: innerHeight - 2,
        }));
        const cardPopover = await waitFor(
          () => document.querySelector('.session-details-popover'),
          'Sessions right-click did not open session details'
        );
        const cardBounds = cardPopover.getBoundingClientRect();
        if (
          cardBounds.left < 0 || cardBounds.top < 0 ||
          cardBounds.right > innerWidth || cardBounds.bottom > innerHeight
        ) return fail('Sessions session details escaped the viewport');
        if (
          card.getAttribute('aria-current') !== selectedBefore ||
          document.activeElement !== cardFocusBefore
        ) return fail('Sessions right-click changed selection or focus');
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'outside click did not dismiss Sessions session details'
        );

        card.focus();
        card.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ContextMenu',
          bubbles: true,
          cancelable: true,
        }));
        const cardKeyboardPopover = await waitFor(
          () => document.querySelector('.session-details-popover'),
          'context-menu key did not open Sessions session details'
        );
        const close = cardKeyboardPopover.querySelector('button');
        if (!(close instanceof HTMLButtonElement) || close !== document.activeElement) {
          return fail('keyboard-opened Sessions details did not receive focus');
        }
        close.click();
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'close button did not dismiss Sessions session details'
        );
        if (document.activeElement !== card) {
          return fail('Sessions details did not restore focus to its card');
        }

        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 40,
        }));
        await waitFor(
          () => document.querySelector('.session-details-popover'),
          'Sessions details did not reopen before navigation'
        );
        const project = document.querySelector('.project-tab-main');
        if (!(project instanceof HTMLButtonElement)) return fail('project tab missing');
        project.click();
        await waitFor(
          () => !document.querySelector('.session-details-popover'),
          'navigation did not dismiss Sessions session details'
        );
        const returned = await waitFor(
          () => document.querySelector('.terminal-list-row.active .terminal-list-main'),
          'terminal rail did not return after Sessions details check'
        );
        if (returned.dataset.terminalSession !== activeSession) {
          return fail('session details navigation changed terminal selection');
        }
        return resolve('rail + Sessions right-click + keyboard + viewport + focus + navigation');
      };
      void run().catch(reject);
    })
  `)) as string
}
