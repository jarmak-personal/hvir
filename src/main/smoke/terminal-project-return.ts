import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

export async function verifyTerminalProjectReturn(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
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
  return status
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
