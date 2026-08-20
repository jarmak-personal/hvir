import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

const OBSERVER_KEY = '__hvirSynchronizedOutputSmoke'

/** Prove native synchronized-output scheduling through a real PTY and retained Canvas. */
export async function verifySynchronizedOutput(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  sessionId: string,
): Promise<string> {
  const terminal = supervisor.list().find((candidate) => candidate.id === sessionId)
  if (!terminal) throw new Error('synchronized-output terminal is not supervised')
  const instanceId = terminal.instanceId
  let commandStarted = false

  const observed = win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(sessionId)};
        const fail = (message) => reject(new Error(message));
        const pixel = (canvas) => {
          const context = canvas?.getContext('2d');
          return canvas && context
            ? [...context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1
              ).data]
            : undefined;
        };
        const samePixel = (left, right) =>
          Boolean(left && right && left.every((value, index) => value === right[index]));
        const fixtures = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const container = surface?.querySelector('.terminal-container');
          const engine = container?.querySelector('.terminal-engine-host');
          const canvas = engine?.querySelector('canvas');
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const row = button?.closest('.terminal-list-row');
          const title = row?.querySelector('.terminal-list-title')?.textContent?.trim();
          const stats = engine?.__hvirTerminalPerformance;
          const delivery = container?.__hvirTerminalDelivery;
          return { surface, container, engine, canvas, button, row, title, stats, delivery };
        };
        const waitForFixtures = () => {
          const current = fixtures();
          const original = document.querySelector(
            '.terminal-list-row.active .terminal-list-main'
          );
          if (
            current.surface instanceof HTMLElement &&
            current.container instanceof HTMLElement &&
            current.engine instanceof HTMLElement &&
            current.canvas instanceof HTMLCanvasElement &&
            current.canvas.width > 0 &&
            current.canvas.height > 0 &&
            current.button instanceof HTMLButtonElement &&
            current.row instanceof HTMLElement &&
            original instanceof HTMLButtonElement &&
            original !== current.button &&
            current.stats?.paused &&
            !current.stats.pendingFrame &&
            current.delivery?.presentation === 'hidden'
          ) {
            const canvas = current.canvas;
            const initialPixel = pixel(canvas);
            const baseline = {
              parsedWrites: current.stats.parsedWrites,
              renderFrames: current.stats.renderFrames,
              fullRenderFrames: current.stats.fullRenderFrames,
              deliveryCallbacks: current.delivery.deliveryCallbacks
            };
            window.${OBSERVER_KEY} = { phase: 'ready' };
            return waitForActive(canvas, initialPixel, baseline, original);
          }
          setTimeout(waitForFixtures, 25);
        };
        const waitForActive = (canvas, initialPixel, baseline, original) => {
          const current = fixtures();
          if (
            current.title === 'Synchronized partial' &&
            current.stats?.synchronizedOutput &&
            current.stats.parsedWrites >= baseline.parsedWrites + 2 &&
            current.delivery?.deliveryCallbacks >= baseline.deliveryCallbacks + 2
          ) {
            if (
              current.canvas !== canvas ||
              current.stats.renderFrames !== baseline.renderFrames ||
              current.stats.fullRenderFrames !== baseline.fullRenderFrames ||
              current.stats.pendingFrame ||
              !current.stats.paused ||
              !samePixel(pixel(canvas), initialPixel)
            ) {
              return fail('hidden synchronized output exposed an intermediate frame');
            }
            current.button.click();
            return waitForActiveReveal(canvas, initialPixel, baseline, original);
          }
          setTimeout(() => waitForActive(canvas, initialPixel, baseline, original), 25);
        };
        const waitForActiveReveal = (canvas, initialPixel, baseline, original) => {
          const current = fixtures();
          if (
            current.row?.classList.contains('active') &&
            current.delivery?.presentation === 'visible' &&
            current.stats &&
            !current.stats.paused
          ) {
            if (
              current.canvas !== canvas ||
              !current.stats.synchronizedOutput ||
              current.stats.renderFrames !== baseline.renderFrames ||
              current.stats.fullRenderFrames !== baseline.fullRenderFrames ||
              current.stats.pendingFrame ||
              !samePixel(pixel(canvas), initialPixel)
            ) {
              return fail('revealing synchronized output exposed a partial Canvas');
            }
            const toggle = document.querySelector('.theme-toggle');
            if (!(toggle instanceof HTMLButtonElement)) {
              return fail('synchronized-output theme control missing');
            }
            const theme = document.documentElement.dataset.theme;
            toggle.click();
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const themed = fixtures();
              if (
                document.documentElement.dataset.theme === theme ||
                themed.canvas !== canvas ||
                !themed.stats?.synchronizedOutput ||
                themed.stats.renderFrames !== baseline.renderFrames ||
                !samePixel(pixel(canvas), initialPixel)
              ) {
                return fail('theme update painted a synchronized partial frame');
              }
              toggle.click();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (document.documentElement.dataset.theme !== theme) {
                  return fail('synchronized-output theme did not restore');
                }
                original.click();
                waitForRehidden(canvas, initialPixel, baseline, original);
              }));
            }));
            return;
          }
          setTimeout(() => waitForActiveReveal(canvas, initialPixel, baseline, original), 25);
        };
        const waitForRehidden = (canvas, initialPixel, baseline, original) => {
          const current = fixtures();
          if (
            current.delivery?.presentation === 'hidden' &&
            current.stats?.paused &&
            current.stats.synchronizedOutput
          ) {
            if (
              current.canvas !== canvas ||
              current.stats.renderFrames !== baseline.renderFrames ||
              current.stats.pendingFrame ||
              !samePixel(pixel(canvas), initialPixel)
            ) {
              return fail('rehidden synchronized output performed presentation work');
            }
            window.${OBSERVER_KEY} = { phase: 'continue' };
            return waitForCompletedHidden(canvas, initialPixel, baseline, original);
          }
          setTimeout(() => waitForRehidden(canvas, initialPixel, baseline, original), 25);
        };
        const waitForCompletedHidden = (canvas, initialPixel, baseline, original) => {
          const current = fixtures();
          if (
            current.title === 'Synchronized final' &&
            current.stats &&
            !current.stats.synchronizedOutput &&
            current.stats.parsedWrites > baseline.parsedWrites + 2
          ) {
            if (
              current.canvas !== canvas ||
              current.delivery?.presentation !== 'hidden' ||
              !current.stats.paused ||
              current.stats.pendingFrame ||
              current.stats.renderFrames !== baseline.renderFrames ||
              current.stats.fullRenderFrames !== baseline.fullRenderFrames ||
              !samePixel(pixel(canvas), initialPixel)
            ) {
              return fail('completed hidden synchronization painted before reveal');
            }
            current.button.click();
            return waitForFinalFrame(canvas, initialPixel, baseline, original);
          }
          setTimeout(
            () => waitForCompletedHidden(canvas, initialPixel, baseline, original),
            25
          );
        };
        const waitForFinalFrame = (canvas, initialPixel, baseline, original) => {
          const current = fixtures();
          const finalPixel = pixel(canvas);
          if (
            current.row?.classList.contains('active') &&
            current.delivery?.presentation === 'visible' &&
            current.stats &&
            !current.stats.paused &&
            !current.stats.pendingFrame &&
            current.stats.renderFrames === baseline.renderFrames + 1 &&
            current.stats.fullRenderFrames === baseline.fullRenderFrames + 1 &&
            finalPixel &&
            finalPixel[1] > finalPixel[0] &&
            finalPixel[1] > finalPixel[2]
          ) {
            if (
              current.canvas !== canvas ||
              current.stats.synchronizedOutput ||
              samePixel(finalPixel, initialPixel)
            ) {
              return fail('final synchronized frame lost Canvas identity or complete state');
            }
            original.click();
            return waitForFinalRehide(canvas, baseline);
          }

          setTimeout(
            () => waitForFinalFrame(canvas, initialPixel, baseline, original),
            25
          );
        };
        const waitForFinalRehide = (canvas, baseline) => {
          const current = fixtures();
          if (
            current.delivery?.presentation === 'hidden' &&
            current.stats?.paused &&
            current.canvas === canvas &&
            current.stats.renderFrames === baseline.renderFrames + 1
          ) {
            return resolve(
              'split mode + parsed while deferred + no partial frame + one final frame'
            );
          }
          setTimeout(() => waitForFinalRehide(canvas, baseline), 25);
        };
        waitForFixtures();
      })
    `) as Promise<string>

  try {
    await waitForObserverPhase(win, 'ready')
    commandStarted = true
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      "stty -echo; printf '\\033[?20'; sleep 0.15; printf '26h\\033[41m\\033[2J\\033[Hpartial-frame\\033]2;Synchronized partial\\007'; IFS= read -r hvir_sync_continue; printf '\\033[42m\\033[2J\\033[Hfinal-frame\\033]2;Synchronized final\\007\\033[?2026l'; stty echo; sleep 5\n",
    )
    await waitForObserverPhase(win, 'continue')
    supervisor.write(terminal.id, terminal.ownerId, 'continue\n')
    const result = await observed
    const retained = supervisor.list().find((candidate) => candidate.id === terminal.id)
    if (!retained || retained.instanceId !== instanceId) {
      throw new Error('synchronized output replaced the supervised PTY')
    }
    return `${result} · retained Canvas and PTY`
  } finally {
    if (commandStarted) supervisor.write(terminal.id, terminal.ownerId, '\u0003')
    await win.webContents.executeJavaScript(`delete window.${OBSERVER_KEY}`)
  }
}

async function waitForObserverPhase(
  win: BrowserWindow,
  expected: 'ready' | 'continue',
): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = async (): Promise<void> => {
      const phase = (await win.webContents.executeJavaScript(
        `window.${OBSERVER_KEY}?.phase`,
      )) as unknown
      if (phase === expected) return resolve()
      setTimeout(() => void poll(), 25)
    }
    void poll()
  })
}
