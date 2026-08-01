import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'

export async function verifyTerminalProjectReturn(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  oversizedDiffPath?: HostPath,
): Promise<string> {
  const viewerStatus = oversizedDiffPath
    ? await verifyViewerProjectReturn(win, oversizedDiffPath)
    : undefined
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('project return has no live terminal')
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    "printf '\\033]0;Project return buffer\\007\\033[41m\\033[2J\\033[Hproject-return-buffer\\033[0m'; IFS= read -r hvir_project_return\n",
  )
  const status = (await withProjectReturnTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(terminal.id)};
        const deadline = Date.now() + 8000;
        const fail = (message) => reject(new Error(message));
        const projectButton = (name) =>
          [...document.querySelectorAll('.project-tab-main')].find(
            (button) => button.querySelector('strong')?.textContent?.trim() === name
          );
        const waitForBuffer = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const container = surface?.querySelector('.terminal-container');
          const engine = container?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const context = canvas?.getContext('2d');
          const pixel = canvas && context
            ? context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1
              ).data
            : undefined;
          const title = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"] ' +
            '.terminal-list-title'
          )?.textContent?.trim();
          const secondary = projectButton('return-fixture');
          if (
            surface?.classList.contains('active') &&
            container instanceof HTMLElement &&
            engine instanceof HTMLElement &&
            canvas instanceof HTMLCanvasElement &&
            pixel && pixel[0] > 120 && pixel[1] < 160 &&
            title === 'Project return buffer' &&
            secondary instanceof HTMLButtonElement
          ) {
            secondary.click();
            return waitForDetached(surface, container, engine, canvas);
          }
          if (Date.now() > deadline) {
            return fail('project return buffer did not become ready: title=' + title);
          }
          setTimeout(waitForBuffer, 25);
        };
        const waitForDetached = (surface, container, engine, canvas) => {
          const activeProject = document.querySelector(
            '.project-tab.active .project-tab-main strong'
          )?.textContent?.trim();
          const delivery = container.__hvirTerminalDelivery;
          const presentation = engine.__hvirTerminalPerformance;
          if (
            activeProject === 'return-fixture' &&
            !surface.isConnected &&
            !engine.isConnected &&
            delivery?.presentation === 'hidden' &&
            presentation?.paused
          ) {
            const primary = projectButton('hvir');
            if (!(primary instanceof HTMLButtonElement)) {
              return fail('project return primary control disappeared');
            }
            primary.click();
            return waitForReturn(engine, canvas);
          }
          if (Date.now() > deadline) {
            return fail(
              'terminal did not detach hidden: project=' + activeProject +
              ' connected=' + engine.isConnected +
              ' delivery=' + delivery?.presentation +
              ' paused=' + presentation?.paused
            );
          }
          setTimeout(() => waitForDetached(surface, container, engine, canvas), 25);
        };
        const waitForReturn = (engine, canvas) => {
          const activeProject = document.querySelector(
            '.project-tab.active .project-tab-main strong'
          )?.textContent?.trim();
          const current = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const currentContainer = current?.querySelector('.terminal-container');
          const currentEngine = currentContainer?.querySelector('.terminal-engine-host');
          const currentCanvas = currentEngine?.querySelector('canvas');
          const context = currentCanvas?.getContext('2d');
          const pixel = currentCanvas && context
            ? context.getImageData(
                Math.floor(currentCanvas.width / 2),
                Math.floor(currentCanvas.height / 2),
                1,
                1
              ).data
            : undefined;
          const delivery = currentContainer?.__hvirTerminalDelivery;
          const presentation = currentEngine?.__hvirTerminalPerformance;
          if (
            activeProject === 'hvir' &&
            currentEngine === engine &&
            currentCanvas === canvas &&
            current?.classList.contains('active') &&
            delivery?.presentation === 'visible' &&
            presentation && !presentation.paused &&
            pixel && pixel[0] > 120 && pixel[1] < 160 &&
            engine.contains(document.activeElement)
          ) {
            return resolve('same PTY session + retained buffer + focused owner');
          }
          if (Date.now() > deadline) {
            return fail(
              'terminal project return did not restore its owner and buffer: project=' +
              activeProject + ' same=' + [
                currentEngine === engine,
                currentCanvas === canvas
              ].join('/') +
              ' delivery=' + delivery?.presentation +
              ' paused=' + presentation?.paused +
              ' pixel=' + (pixel ? [...pixel].join('/') : 'missing') +
              ' focus=' + engine.contains(document.activeElement)
            );
          }
          setTimeout(() => waitForReturn(engine, canvas), 25);
        };
        waitForBuffer();
      })
    `),
    10_000,
  )) as string
  supervisor.write(terminal.id, terminal.ownerId, '\n')
  const retained = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (retained?.id !== terminal.id || retained.instanceId !== terminal.instanceId) {
    throw new Error('project return replaced the live PTY session')
  }
  return viewerStatus ? `${viewerStatus} · ${status}` : status
}

async function verifyViewerProjectReturn(
  win: BrowserWindow,
  path: HostPath,
): Promise<string> {
  return (await withProjectReturnTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const path = ${JSON.stringify(path.path)};
        const deadline = Date.now() + 20000;
        const fail = (message) => reject(new Error(message + ': ' + JSON.stringify({
          project: document.querySelector('.project-tab.active .project-tab-main strong')
            ?.textContent?.trim(),
          activePath: document.querySelector('.viewer-tab.active .tab-main')
            ?.getAttribute('title'),
          mode: document.querySelector('.mode-control button.active')
            ?.textContent?.trim(),
          fallback: document.querySelector('.diff-fallback')?.textContent?.trim()
            .slice(0, 300),
          merge: Boolean(document.querySelector('.cm-mergeView')),
          source: Boolean(document.querySelector('.source-shell .cm-scroller'))
        })));
        const waitFor = (test, message, next) => {
          const value = test();
          if (value) return next(value);
          if (Date.now() > deadline) return fail(message);
          setTimeout(() => waitFor(test, message, next), 25);
        };
        const projectButton = (name) =>
          [...document.querySelectorAll('.project-tab-main')].find(
            (button) => button.querySelector('strong')?.textContent?.trim() === name
          );
        const modeButton = (mode) =>
          [...document.querySelectorAll('.mode-control button')].find(
            (button) => button.textContent?.trim() === mode
          );
        const activeProject = () => document.querySelector(
          '.project-tab.active .project-tab-main strong'
        )?.textContent?.trim();
        const activePath = () => document.querySelector(
          '.viewer-tab.active .tab-main'
        )?.getAttribute('title');
        const fallbackReady = () => {
          const fallback = document.querySelector('.diff-fallback');
          const text = fallback?.textContent || '';
          return fallback &&
            activePath() === path &&
            text.includes(path) &&
            text.includes('Requested comparison: HEAD → Working tree') &&
            text.includes('partial input') &&
            !document.querySelector('.cm-mergeView')
              ? fallback
              : undefined;
        };
        waitFor(
          () => [...document.querySelectorAll('.file-row')]
            .find((node) => node.getAttribute('title')?.startsWith(path)),
          'oversized diff fixture did not appear in the file tree',
          (file) => {
            file.click();
            waitFor(
              () => activePath() === path && modeButton('diff'),
              'oversized fixture did not open',
              (diff) => {
                diff.click();
                waitFor(
                  fallbackReady,
                  'oversized fixture did not disclose a bounded diff fallback',
                  () => {
                    const secondary = projectButton('return-fixture');
                    if (!(secondary instanceof HTMLButtonElement)) {
                      return fail('secondary project control missing');
                    }
                    secondary.click();
                    waitFor(
                      () => activeProject() === 'return-fixture',
                      'viewer project switch did not leave the primary project',
                      () => {
                        const primary = projectButton('hvir');
                        if (!(primary instanceof HTMLButtonElement)) {
                          return fail('primary project control missing');
                        }
                        primary.click();
                        waitFor(
                          () => activeProject() === 'hvir' && fallbackReady(),
                          'viewer project return did not restore the bounded fallback',
                          () => {
                            const source = modeButton('source');
                            if (!(source instanceof HTMLButtonElement)) {
                              return fail('source navigation control missing after return');
                            }
                            source.click();
                            waitFor(
                              () => document.querySelector('.source-shell .cm-scroller'),
                              'source navigation timed out after project return',
                              () => {
                                const diffAgain = modeButton('diff');
                                if (!(diffAgain instanceof HTMLButtonElement)) {
                                  return fail('diff navigation control missing after return');
                                }
                                diffAgain.click();
                                waitFor(
                                  fallbackReady,
                                  'bounded diff did not return after follow-up navigation',
                                  () => resolve(
                                    'oversized diff fallback + retained viewer + ' +
                                    'source→diff navigation'
                                  )
                                );
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          }
        );
      })
    `),
    22_000,
  )) as string
}

function withProjectReturnTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('terminal project return timed out')),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
