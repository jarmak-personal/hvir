import type { BrowserWindow } from 'electron'

export async function focusTerminalEngine(
  win: BrowserWindow,
  sessionId: string,
): Promise<void> {
  win.focus()
  win.webContents.focus()
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          if (
            surface?.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'visible' &&
            engine instanceof HTMLElement
          ) {
            engine.focus();
            if (document.activeElement === engine) return resolve();
          }
          if (button instanceof HTMLButtonElement) button.click();
          if (Date.now() > deadline) {
            return reject(new Error('revealed terminal engine did not regain focus'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'revealed terminal engine focus timed out',
  )
}

export async function verifyActiveCursorCadence(
  win: BrowserWindow,
  sessionId: string,
): Promise<string> {
  const idleHiddenFrame = await waitForCursorPhase(
    win,
    sessionId,
    false,
    -1,
    'cursor did not enter its idle hidden phase',
  )

  let activeVisibleFrame = idleHiddenFrame
  for (let index = 0; index < 6; index += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
    activeVisibleFrame = await waitForCursorPhase(
      win,
      sessionId,
      true,
      activeVisibleFrame,
      'sustained input did not keep the cursor visible',
    )
    if (index < 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  }
  const resumedHiddenFrame = await waitForCursorPhase(
    win,
    sessionId,
    false,
    activeVisibleFrame,
    'cursor did not resume blinking after input',
  )
  await waitForCursorPhase(
    win,
    sessionId,
    true,
    resumedHiddenFrame,
    'cursor blink cadence did not return to visible',
  )

  // Remove the probe character before the surrounding canonical read submits.
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'U',
    modifiers: ['control'],
  })
  win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'U',
    modifiers: ['control'],
  })
  return 'active cursor + idle blink'
}

async function waitForCursorPhase(
  win: BrowserWindow,
  sessionId: string,
  visible: boolean,
  afterFrame: number,
  failure: string,
): Promise<number> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 2500;
        const sessionId = ${JSON.stringify(sessionId)};
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          if (
            stats && !stats.paused && !stats.pendingFrame &&
            stats.cursorVisible === ${JSON.stringify(visible)} &&
            stats.renderFrames > ${JSON.stringify(afterFrame)}
          ) {
            return resolve(stats.renderFrames);
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              ${JSON.stringify(failure)} + ': last=' + JSON.stringify({
                engineFocused: document.activeElement === engine,
                hasStats: Boolean(stats),
                paused: stats?.paused,
                pendingFrame: stats?.pendingFrame,
                cursorVisible: stats?.cursorVisible,
                renderFrames: stats?.renderFrames,
                renderRequests: stats?.renderRequests
              })
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    failure,
    3_000,
  )) as number
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
