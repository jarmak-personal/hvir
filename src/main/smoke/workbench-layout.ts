import type { BrowserWindow } from 'electron'

export async function verifyWorkbenchLayout(win: BrowserWindow): Promise<void> {
  const railNavigationStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const railButtons = [...document.querySelectorAll('.rail-nav button')];
        const byLabel = (label) =>
          railButtons.find((node) => node.textContent?.trim().startsWith(label));
        const files = byLabel('Files');
        const sessions = document.querySelector('.sessions-destination');
        const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
          .find((node) => node.querySelector(':scope > .directory-row')
            ?.getAttribute('title')?.endsWith('/src'));
        if (!files || !(sessions instanceof HTMLButtonElement) || !directory) {
          return reject(new Error('stable rail navigation controls missing'));
        }
        const directoryRow = directory.querySelector(':scope > .directory-row');
        if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
        const tabsBefore = document.querySelectorAll('.viewer-tab').length;
        sessions.click();
        const waitForSessions = () => {
          const overview = document.querySelector('.sessions-overview');
          const workbench = document.querySelector('.workbench');
          if (
            sessions.disabled ||
            !sessions.classList.contains('active') ||
            sessions.getAttribute('aria-current') !== 'page' ||
            !overview ||
            !(workbench instanceof HTMLElement) ||
            !workbench.hidden
          ) {
            return setTimeout(waitForSessions, 25);
          }
          const project = document.querySelector('.project-tab-main');
          if (!(project instanceof HTMLButtonElement)) {
            return reject(new Error('project navigation control missing'));
          }
          project.click();
          const waitForFiles = () => {
            const currentFiles = [...document.querySelectorAll('.rail-nav button')]
              .find((node) => node.textContent?.trim().startsWith('Files'));
            const ready = directory.isConnected &&
              directoryRow?.getAttribute('aria-expanded') === 'true' &&
              document.querySelectorAll('.viewer-tab').length === tabsBefore &&
              currentFiles?.classList.contains('active') &&
              !sessions.disabled &&
              !document.querySelector('.sessions-overview');
            if (ready) {
              return resolve(
                'stable tabs · Files state preserved · Sessions full-page round trip'
              );
            }

            setTimeout(waitForFiles, 25);
          };
          waitForFiles();
        };
        waitForSessions();
      })
    `)) as string
  console.log(`[smoke] rail navigation OK (${railNavigationStatus})`)

  const resizeStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const tree = document.querySelector('.tree-panel');
        const workbench = document.querySelector('.workbench');
        const viewer = document.querySelector('.viewer-panel');
        const terminal = document.querySelector('.terminal-panel');
        const terminalRail = document.querySelector('.terminal-rail');
        const terminalControls = document.querySelector('.terminal-mode-controls');
        const treeDivider = document.querySelector('.tree-resizer');
        const terminalDivider = document.querySelector('.terminal-resizer');
        const treeToggle = document.querySelector('.tree-collapse-toggle');
        const terminalToggle = document.querySelector('.terminal-focus-toggle');
        const terminalCollapse = document.querySelector('.terminal-collapse-toggle');
        if (
          !tree || !workbench || !viewer || !terminal || !terminalRail ||
          !treeDivider || !terminalDivider || !treeToggle || !terminalToggle ||
          !terminalCollapse || !terminalControls
        ) {
          return reject(new Error('pane dividers missing'));
        }
        const workbenchRect = workbench.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        const terminalRect = terminal.getBoundingClientRect();
        const terminalRailRect = terminalRail.getBoundingClientRect();
        const terminalDividerRect = terminalDivider.getBoundingClientRect();
        if (
          Math.abs(viewerRect.right - workbenchRect.right) > 1 ||
          Math.abs(terminalDividerRect.right - workbenchRect.right) > 1 ||
          Math.abs(terminalRailRect.top - terminalRect.top) > 1 ||
          Math.abs(terminalRailRect.bottom - terminalRect.bottom) > 1
        ) {
          return reject(new Error('terminal rail is not aligned to the terminal row'));
        }
        const treeBefore = tree.getBoundingClientRect().width;
        const terminalBefore = terminal.getBoundingClientRect().height;
        treeDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        terminalDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const treeAfter = tree.getBoundingClientRect().width;
          const terminalAfter = terminal.getBoundingClientRect().height;
          if (treeAfter <= treeBefore || terminalAfter <= terminalBefore) {
            return reject(new Error('pane keyboard resize did not change tracks'));
          }
          for (let index = 0; index < 32; index += 1) {
            terminalDivider.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowUp', bubbles: true
            }));
          }
          const terminalAtLimit = terminal.getBoundingClientRect();
          const workbenchAtLimit = workbench.getBoundingClientRect();
          if (terminalAtLimit.bottom > workbenchAtLimit.bottom + 1) {
            return reject(new Error(
              'terminal resize escaped the viewport: terminal=' + terminalAtLimit.bottom +
              ' workbench=' + workbenchAtLimit.bottom
            ));
          }
          treeDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          terminalDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const restoredTreeWidth = tree.getBoundingClientRect().width;
            treeToggle.click();
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (
                !workbench.classList.contains('tree-collapsed') ||
                tree.getBoundingClientRect().width > 1 ||
                getComputedStyle(tree).visibility !== 'hidden'
              ) {
                return reject(new Error('file explorer did not collapse'));
              }
              terminalToggle.click();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (
                  !workbench.classList.contains('tree-collapsed') ||
                  !workbench.classList.contains('terminal-focused') ||
                  getComputedStyle(viewer).visibility !== 'hidden'
                ) {
                  return reject(new Error('pane focus modes did not compose'));
                }
                terminalCollapse.click();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const controlsRect = terminalControls.getBoundingClientRect();
                  const collapsedWorkbenchRect = workbench.getBoundingClientRect();
                  if (
                    workbench.classList.contains('terminal-focused') ||
                    !workbench.classList.contains('terminal-collapsed') ||
                    getComputedStyle(viewer).visibility === 'hidden' ||
                    getComputedStyle(terminalRail).visibility !== 'hidden' ||
                    controlsRect.bottom > collapsedWorkbenchRect.bottom + 1
                  ) {
                    return reject(new Error('terminal did not collapse from maximized state'));
                  }
                  terminalToggle.click();
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (
                      !workbench.classList.contains('terminal-focused') ||
                      workbench.classList.contains('terminal-collapsed')
                    ) {
                      return reject(new Error('terminal did not maximize from collapsed state'));
                    }
                    terminalToggle.click();
                    treeToggle.click();
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                      const finalTreeWidth = tree.getBoundingClientRect().width;
                      if (
                        workbench.classList.contains('tree-collapsed') ||
                        workbench.classList.contains('terminal-focused') ||
                        workbench.classList.contains('terminal-collapsed') ||
                        Math.abs(finalTreeWidth - restoredTreeWidth) > 1 ||
                        getComputedStyle(tree).visibility === 'hidden'
                      ) {
                        return reject(new Error('pane focus modes did not restore'));
                      }
                      resolve(
                        Math.round(treeBefore) + '→' + Math.round(treeAfter) + 'px tree; ' +
                        Math.round(terminalBefore) + '→' + Math.round(terminalAfter) +
                        'px terminal; three-state controls composed and restored'
                      );
                    }));
                  }));
                }));
              }));
            }));
          }));
        }));
      })
    `)) as string
  console.log(`[smoke] pane dividers OK (${resizeStatus})`)

  const resizerActionStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const frames = () => new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done))
        );
        const pointer = (target, type, id, x, y) => target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: id,
            isPrimary: true,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y
          })
        );
        const run = async () => {
          const workbench = document.querySelector('.workbench');
          const terminal = document.querySelector('.terminal-panel');
          const terminalDivider = document.querySelector('.terminal-resizer');
          const terminalToggle = document.querySelector('.terminal-focus-toggle');
          const tree = document.querySelector('.tree-panel');
          const treeToggle = document.querySelector('.tree-collapse-toggle');
          if (
            !workbench || !terminal || !terminalDivider || !terminalToggle ||
            !tree || !treeToggle
          ) {
            throw new Error('resizer action controls missing');
          }

          terminalToggle.click();
          await frames();
          if (!workbench.classList.contains('terminal-focused')) {
            throw new Error('terminal did not maximize before action drag');
          }
          const terminalButtonRect = terminalToggle.getBoundingClientRect();
          const workbenchRect = workbench.getBoundingClientRect();
          const terminalTargetY = workbenchRect.bottom - 280;
          const terminalStartX = terminalButtonRect.left + terminalButtonRect.width / 2;
          const terminalStartY = terminalButtonRect.top + terminalButtonRect.height / 2;
          pointer(terminalToggle, 'pointerdown', 41, terminalStartX, terminalStartY);
          pointer(terminalToggle, 'pointermove', 41, terminalStartX, terminalTargetY);
          pointer(terminalToggle, 'pointerup', 41, terminalStartX, terminalTargetY);
          terminalToggle.click();
          await frames();
          const terminalHeight = terminal.getBoundingClientRect().height;
          if (
            workbench.classList.contains('terminal-focused') ||
            workbench.classList.contains('terminal-collapsed') ||
            Math.abs(terminalHeight - 280) > 2
          ) {
            throw new Error(
              'terminal action drag toggled instead of resizing: ' + terminalHeight
            );
          }

          treeToggle.click();
          await frames();
          if (!workbench.classList.contains('tree-collapsed')) {
            throw new Error('tree did not collapse before action drag');
          }
          const treeButtonRect = treeToggle.getBoundingClientRect();
          const treeTargetX = workbenchRect.left + 260;
          const treeStartX = treeButtonRect.left + treeButtonRect.width / 2;
          const treeStartY = treeButtonRect.top + treeButtonRect.height / 2;
          pointer(treeToggle, 'pointerdown', 42, treeStartX, treeStartY);
          pointer(treeToggle, 'pointermove', 42, treeTargetX, treeStartY);
          pointer(treeToggle, 'pointerup', 42, treeTargetX, treeStartY);
          treeToggle.click();
          await frames();
          const treeWidth = tree.getBoundingClientRect().width;
          if (
            workbench.classList.contains('tree-collapsed') ||
            Math.abs(treeWidth - 260) > 2 ||
            document.body.classList.contains('pane-resizing')
          ) {
            throw new Error('tree action drag toggled instead of resizing: ' + treeWidth);
          }
          resolve(
            Math.round(terminalHeight) + 'px terminal; ' +
            Math.round(treeWidth) + 'px tree; action drags suppressed clicks'
          );
        };
        void run().catch(reject);
      })
    `)) as string
  console.log(`[smoke] pane action drags OK (${resizerActionStatus})`)
}
