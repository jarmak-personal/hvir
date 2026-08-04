import type { BrowserWindow } from 'electron'

import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

export async function verifyTerminalHorizonPresentation(
  win: BrowserWindow,
): Promise<string> {
  return (await withTerminalSmokeTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const workbench = document.querySelector('.workbench');
        const viewer = document.querySelector('.viewer-panel');
        const divider = document.querySelector('.terminal-resizer');
        const maximize = document.querySelector('.terminal-focus-toggle');
        const minimize = document.querySelector('.terminal-collapse-toggle');
        const themeToggle = document.querySelector('.theme-toggle');
        if (
          !(workbench instanceof HTMLElement) ||
          !(viewer instanceof HTMLElement) ||
          !(divider instanceof HTMLElement) ||
          !(maximize instanceof HTMLButtonElement) ||
          !(minimize instanceof HTMLButtonElement) ||
          !(themeToggle instanceof HTMLButtonElement)
        ) {
          throw new Error('terminal horizon fixtures missing');
        }

        const nextPaint = () => new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const resolveColor = (value) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        };
        const tokenColor = (token) => resolveColor(
          getComputedStyle(document.documentElement).getPropertyValue(token)
        );
        const expectColor = (token, state) => {
          const actual = getComputedStyle(divider).backgroundColor;
          const expected = tokenColor(token);
          if (actual !== expected) {
            throw new Error(
              state + ' terminal horizon color mismatch: actual=' + actual +
              ' expected=' + expected
            );
          }
        };
        const readBounds = () => {
          const bounds = divider.getBoundingClientRect();
          return [bounds.left, bounds.right, bounds.width, bounds.height];
        };
        const expectRestored = (theme) => {
          if (
            workbench.classList.contains('terminal-focused') ||
            workbench.classList.contains('terminal-collapsed')
          ) {
            throw new Error(theme + ' terminal horizon is not in restored split view');
          }
          expectColor('--border-strong', theme + ' restored');
          const bounds = readBounds();
          const viewerBounds = viewer.getBoundingClientRect();
          const workbenchBounds = workbench.getBoundingClientRect();
          if (
            Math.abs(bounds[3] - 1) > 0.01 ||
            Math.abs(bounds[0] - viewerBounds.left) > 1 ||
            Math.abs(bounds[1] - workbenchBounds.right) > 1
          ) {
            throw new Error(
              theme + ' terminal horizon geometry mismatch: divider=' +
              bounds.join(',') + ' viewerLeft=' + viewerBounds.left +
              ' workbenchRight=' + workbenchBounds.right
            );
          }
          return bounds;
        };
        const expectSameBounds = (actual, expected, state) => {
          if (actual.some((value, index) => Math.abs(value - expected[index]) > 0.01)) {
            throw new Error(state + ' changed terminal horizon dimensions');
          }
        };
        const initialTheme = document.documentElement.dataset.theme;
        if (initialTheme !== 'dark' && initialTheme !== 'light') {
          throw new Error('terminal horizon initial theme missing');
        }
        const terminalTrack = workbench.style.getPropertyValue('--terminal-track');
        const gridRows = getComputedStyle(workbench).gridTemplateRows;
        const initialBounds = expectRestored(initialTheme);

        themeToggle.click();
        await nextPaint();
        const alternateTheme = document.documentElement.dataset.theme;
        if (alternateTheme === initialTheme) {
          throw new Error('terminal horizon theme did not change');
        }
        expectSameBounds(
          expectRestored(alternateTheme),
          initialBounds,
          'theme switch'
        );
        if (getComputedStyle(workbench).gridTemplateRows !== gridRows) {
          throw new Error('terminal horizon theme switch changed workbench rows');
        }

        themeToggle.click();
        await nextPaint();
        if (document.documentElement.dataset.theme !== initialTheme) {
          throw new Error('terminal horizon theme did not restore');
        }
        expectSameBounds(expectRestored(initialTheme), initialBounds, 'theme restore');

        maximize.click();
        await nextPaint();
        if (
          !workbench.classList.contains('terminal-focused') ||
          workbench.classList.contains('terminal-collapsed')
        ) {
          throw new Error('terminal horizon did not enter maximized mode');
        }
        expectColor('--border-subtle', 'maximized');

        maximize.click();
        await nextPaint();
        expectSameBounds(expectRestored(initialTheme), initialBounds, 'maximize restore');

        minimize.click();
        await nextPaint();
        if (
          workbench.classList.contains('terminal-focused') ||
          !workbench.classList.contains('terminal-collapsed')
        ) {
          throw new Error('terminal horizon did not enter collapsed mode');
        }
        expectColor('--border-subtle', 'collapsed');

        minimize.click();
        await nextPaint();
        expectSameBounds(expectRestored(initialTheme), initialBounds, 'collapse restore');
        if (workbench.style.getPropertyValue('--terminal-track') !== terminalTrack) {
          throw new Error('terminal horizon checks changed the saved terminal track');
        }
        return 'dark/light full-width horizon + quiet hidden-surface modes';
      })()
    `),
    'terminal horizon presentation check timed out',
    6_000,
  )) as string
}
