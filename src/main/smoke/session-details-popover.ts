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
        const initialRowHeight = row.getBoundingClientRect().height;
        if (row.querySelector('.compaction-markers')) {
          return fail('bare shell rendered a compaction marker strip');
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
        let pointerBounds;
        const pointerPopover = await waitFor(
          () => {
            const candidate = document.querySelector('.session-details-popover');
            if (!candidate) return undefined;
            const candidateBounds = candidate.getBoundingClientRect();
            pointerBounds = {
              left: candidateBounds.left,
              top: candidateBounds.top,
              right: candidateBounds.right,
              bottom: candidateBounds.bottom,
              width: innerWidth,
              height: innerHeight,
              visibility: getComputedStyle(candidate).visibility,
            };
            return candidateBounds.left >= 0 && candidateBounds.top >= 0 &&
              candidateBounds.right <= innerWidth && candidateBounds.bottom <= innerHeight
              ? candidate
              : undefined;
          },
          'right-click session details did not settle inside the viewport'
        ).catch(() => fail(
          'right-click session details did not settle inside the viewport: ' +
          JSON.stringify(pointerBounds)
        ));
        const bounds = pointerPopover.getBoundingClientRect();
        if (
          bounds.left < 0 || bounds.top < 0 ||
          bounds.right > innerWidth || bounds.bottom > innerHeight
        ) return fail('session details escaped the viewport: ' + JSON.stringify({
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          width: innerWidth,
          height: innerHeight,
        }));
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
          () => {
            const candidate = document.querySelector('.session-details-popover');
            return candidate && getComputedStyle(candidate).visibility !== 'hidden'
              ? candidate
              : undefined;
          },
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
        if (card.querySelector('.compaction-markers')) {
          return fail('bare-shell Sessions card rendered a compaction marker strip');
        }
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: innerWidth - 2,
          clientY: innerHeight - 2,
        }));
        let cardPointerBounds;
        const cardPopover = await waitFor(
          () => {
            const candidate = document.querySelector('.session-details-popover');
            if (!candidate) return undefined;
            const candidateBounds = candidate.getBoundingClientRect();
            cardPointerBounds = {
              left: candidateBounds.left,
              top: candidateBounds.top,
              right: candidateBounds.right,
              bottom: candidateBounds.bottom,
              width: innerWidth,
              height: innerHeight,
              visibility: getComputedStyle(candidate).visibility,
            };
            return candidateBounds.left >= 0 && candidateBounds.top >= 0 &&
              candidateBounds.right <= innerWidth && candidateBounds.bottom <= innerHeight
              ? candidate
              : undefined;
          },
          'Sessions right-click details did not settle inside the viewport'
        ).catch(() => fail(
          'Sessions right-click details did not settle inside the viewport: ' +
          JSON.stringify(cardPointerBounds)
        ));
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
          () => {
            const candidate = document.querySelector('.session-details-popover');
            return candidate && getComputedStyle(candidate).visibility !== 'hidden'
              ? candidate
              : undefined;
          },
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
        const returnedRow = returned.closest('.terminal-list-row');
        if (
          !(returnedRow instanceof HTMLElement) ||
          returnedRow.getBoundingClientRect().height !== initialRowHeight
        ) return fail('session details changed terminal row geometry');
        return resolve('rail + Sessions right-click + keyboard + viewport + focus + navigation');
      };
      void run().catch(reject);
    })
  `)) as string
}
