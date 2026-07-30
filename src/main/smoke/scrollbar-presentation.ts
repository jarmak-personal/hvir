import type { BrowserWindow } from 'electron'

interface ScrollbarFixtureSnapshot {
  readonly point: readonly [number, number]
  readonly emptyPoint: readonly [number, number]
  readonly clippedPoint: readonly [number, number]
  readonly trackPoint: readonly [number, number]
  readonly thumbPoint: readonly [number, number]
  readonly thumbDragPoint: readonly [number, number]
  readonly clientWidth: number
  readonly clientHeight: number
  readonly scrollWidth: number
  readonly scrollHeight: number
  readonly verticalGutter: number
  readonly horizontalGutter: number
  readonly emptyVerticalGutter: number
  readonly emptyHorizontalGutter: number
  readonly scrollbarColor: string
  readonly scrollbarWidth: string
}

interface ScrollbarVisibilitySnapshot {
  readonly clientWidth: number
  readonly clientHeight: number
  readonly verticalVisible: boolean
  readonly horizontalVisible: boolean
}

const FIXTURE_ID = 'hvir-scrollbar-smoke-fixture'
const SURFACE_ID = 'hvir-scrollbar-smoke-surface'
const VISIBILITY_TIMEOUT_MS = 3_000
const VISIBILITY_POLL_MS = 25

/** Exercise the real overlay geometry and native scroll input path in Electron. */
export async function verifyScrollbarPresentation(win: BrowserWindow): Promise<string> {
  const snapshot = await installFixture(win)
  try {
    assertOverlayGeometry(snapshot)
    win.focus()
    win.webContents.focus()

    await new Promise((resolve) => setTimeout(resolve, 1_200))
    moveMouse(win, snapshot.emptyPoint)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const nonOverflowing = await fixtureDimensions(win)
    if (nonOverflowing.verticalVisible || nonOverflowing.horizontalVisible) {
      throw new Error(
        `non-overflowing surface exposed an overlay (${JSON.stringify(nonOverflowing)})`,
      )
    }

    moveMouse(win, snapshot.clippedPoint)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const clipped = await fixtureDimensions(win)
    if (!clipped.verticalVisible || clipped.horizontalVisible) {
      throw new Error(
        `clipped axis exposed the wrong overlays (${JSON.stringify(clipped)})`,
      )
    }

    moveMouse(win, snapshot.point)
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(snapshot.point[0]),
      y: Math.round(snapshot.point[1]),
      deltaY: -120,
    })
    await waitForScrollTop(win, (position) => position > 0, 'wheel input')

    await resetFixture(win)
    moveMouse(win, snapshot.trackPoint)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assertOverlayTarget(win, snapshot.trackPoint, 'track')
    clickMouse(win, snapshot.trackPoint)
    await waitForScrollTop(win, (position) => position > 0, 'scrollbar track input')

    await resetFixture(win)
    moveMouse(win, snapshot.thumbPoint)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assertOverlayTarget(win, snapshot.thumbPoint, 'thumb')
    dragMouse(win, snapshot.thumbPoint, snapshot.thumbDragPoint)
    await waitForScrollTop(win, (position) => position > 0, 'scrollbar thumb drag')

    await resetAndFocusFixture(win)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'END' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'END' })
    await waitForScrollTop(
      win,
      (position, maximum) => position >= maximum - 1,
      'keyboard input',
    )

    const active = await waitForFixtureVisibility(win, true, true, 'scrollbar activity')
    moveMouse(win, snapshot.emptyPoint)
    const idle = await waitForFixtureVisibility(win, false, false, 'scrollbar idle')
    if (
      active.clientWidth !== snapshot.clientWidth ||
      active.clientHeight !== snapshot.clientHeight ||
      idle.clientWidth !== snapshot.clientWidth ||
      idle.clientHeight !== snapshot.clientHeight ||
      !active.verticalVisible ||
      !active.horizontalVisible ||
      idle.verticalVisible ||
      idle.horizontalVisible
    ) {
      throw new Error(
        `scrollbar active/idle presentation contract failed ` +
          `(initial=${snapshot.clientWidth}x${snapshot.clientHeight}, ` +
          `active=${JSON.stringify(active)}, idle=${JSON.stringify(idle)})`,
      )
    }

    await resizeFixture(win, 141)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const resizedWhileIdle = await fixtureDimensions(win)
    if (resizedWhileIdle.verticalVisible || resizedWhileIdle.horizontalVisible) {
      throw new Error(
        `idle resize resurrected the overlay (${JSON.stringify(resizedWhileIdle)})`,
      )
    }
    await resizeFixture(win, 140)

    const horizontal = await reachHorizontalEnd(win)
    if (horizontal.position < horizontal.maximum - 1) {
      throw new Error(
        `horizontal scrollbar content was unreachable ` +
          `(position=${horizontal.position}, maximum=${horizontal.maximum})`,
      )
    }
    await verifyForcedColors(win)
    return 'overlay geometry + wheel/track/thumb/keyboard reach + active/idle stability'
  } finally {
    await removeFixture(win)
  }
}

async function installFixture(win: BrowserWindow): Promise<ScrollbarFixtureSnapshot> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      document.getElementById(${JSON.stringify(FIXTURE_ID)})?.remove();
      const root = document.getElementById('root');
      if (!root) return reject(new Error('scrollbar smoke root missing'));

      const fixture = document.createElement('div');
      fixture.id = ${JSON.stringify(FIXTURE_ID)};
      Object.assign(fixture.style, {
        position: 'fixed',
        zIndex: '1050',
        top: '12px',
        left: '12px',
        display: 'flex',
        gap: '12px',
        pointerEvents: 'auto'
      });

      const surface = document.createElement('div');
      surface.id = ${JSON.stringify(SURFACE_ID)};
      surface.tabIndex = 0;
      Object.assign(surface.style, {
        width: '140px',
        height: '100px',
        overflow: 'auto',
        background: '#17202b',
        outline: 'none'
      });
      const content = document.createElement('div');
      Object.assign(content.style, {
        width: '420px',
        height: '400px',
        background: '#17202b'
      });
      surface.append(content);

      const empty = document.createElement('div');
      Object.assign(empty.style, {
        width: '140px',
        height: '100px',
        overflow: 'auto',
        background: '#17202b'
      });

      const clipped = document.createElement('div');
      Object.assign(clipped.style, {
        width: '140px',
        height: '100px',
        overflowX: 'hidden',
        overflowY: 'auto',
        background: '#17202b'
      });
      const clippedContent = content.cloneNode();
      clipped.append(clippedContent);
      fixture.append(surface, empty, clipped);
      root.append(fixture);

      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        const emptyRect = empty.getBoundingClientRect();
        const clippedRect = clipped.getBoundingClientRect();
        const style = getComputedStyle(surface);
        resolve({
          point: [rect.left + rect.width / 2, rect.top + rect.height / 2],
          emptyPoint: [emptyRect.left + emptyRect.width / 2, emptyRect.top + emptyRect.height / 2],
          clippedPoint: [
            clippedRect.left + clippedRect.width / 2,
            clippedRect.top + clippedRect.height / 2
          ],
          trackPoint: [rect.right - 7, rect.top + 72],
          thumbPoint: [rect.right - 7, rect.top + 7],
          thumbDragPoint: [rect.right - 7, rect.top + 58],
          clientWidth: surface.clientWidth,
          clientHeight: surface.clientHeight,
          scrollWidth: surface.scrollWidth,
          scrollHeight: surface.scrollHeight,
          verticalGutter: surface.offsetWidth - surface.clientWidth,
          horizontalGutter: surface.offsetHeight - surface.clientHeight,
          emptyVerticalGutter: empty.offsetWidth - empty.clientWidth,
          emptyHorizontalGutter: empty.offsetHeight - empty.clientHeight,
          scrollbarColor: style.scrollbarColor,
          scrollbarWidth: style.scrollbarWidth
        });
      }));
    })
  `)) as ScrollbarFixtureSnapshot
}

async function assertOverlayTarget(
  win: BrowserWindow,
  point: readonly [number, number],
  expected: 'track' | 'thumb',
): Promise<void> {
  const className = (await win.webContents.executeJavaScript(`
    document.elementFromPoint(${Math.round(point[0])}, ${Math.round(point[1])})?.className
  `)) as unknown
  const expectedClass = expected === 'track' ? 'hvir-scrollbar' : 'hvir-scrollbar-thumb'
  if (typeof className !== 'string' || !className.split(/\s+/).includes(expectedClass)) {
    throw new Error(
      `overlay ${expected} was not pointer reachable at ${point.join(',')} ` +
        `(target=${String(className)})`,
    )
  }
}

function assertOverlayGeometry(snapshot: ScrollbarFixtureSnapshot): void {
  if (
    snapshot.scrollWidth <= snapshot.clientWidth ||
    snapshot.scrollHeight <= snapshot.clientHeight
  ) {
    throw new Error(`scrollbar fixture did not overflow (${JSON.stringify(snapshot)})`)
  }
  if (
    snapshot.verticalGutter !== 0 ||
    snapshot.horizontalGutter !== 0 ||
    snapshot.emptyVerticalGutter !== 0 ||
    snapshot.emptyHorizontalGutter !== 0
  ) {
    throw new Error(`scrollbar reserved layout space (${JSON.stringify(snapshot)})`)
  }
  if (snapshot.scrollbarWidth !== 'none') {
    throw new Error(
      `shared scrollbar gutter suppression was not applied (${JSON.stringify(snapshot)})`,
    )
  }
}

function moveMouse(win: BrowserWindow, [x, y]: readonly [number, number]): void {
  const point = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({ type: 'mouseEnter', ...point })
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
}

function clickMouse(win: BrowserWindow, [x, y]: readonly [number, number]): void {
  const point = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...point,
  })
}

function dragMouse(
  win: BrowserWindow,
  [fromX, fromY]: readonly [number, number],
  [toX, toY]: readonly [number, number],
): void {
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    x: Math.round(fromX),
    y: Math.round(fromY),
  })
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    x: Math.round(toX),
    y: Math.round(toY),
    movementX: Math.round(toX - fromX),
    movementY: Math.round(toY - fromY),
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    x: Math.round(toX),
    y: Math.round(toY),
  })
}

async function resetFixture(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
      if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
      surface.scrollTop = 0;
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}

async function resetAndFocusFixture(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
      if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
      surface.scrollTop = 0;
      surface.focus();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}

async function waitForScrollTop(
  win: BrowserWindow,
  complete: (position: number, maximum: number) => boolean,
  interaction: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const position = (await win.webContents.executeJavaScript(`
      (() => {
        const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
        if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
        return { position: surface.scrollTop, maximum: surface.scrollHeight - surface.clientHeight };
      })()
    `)) as { readonly position: number; readonly maximum: number }
    if (complete(position.position, position.maximum)) return
    if (Date.now() > deadline) {
      throw new Error(
        `${interaction} did not move the scroll surface ` +
          `(position=${position.position}, maximum=${position.maximum})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function fixtureDimensions(
  win: BrowserWindow,
): Promise<ScrollbarVisibilitySnapshot> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
      if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
      return {
        clientWidth: surface.clientWidth,
        clientHeight: surface.clientHeight,
        verticalVisible:
          document.querySelector('.hvir-scrollbar[data-axis="vertical"]')?.dataset.visible === 'true',
        horizontalVisible:
          document.querySelector('.hvir-scrollbar[data-axis="horizontal"]')?.dataset.visible === 'true'
      };
    })()
  `)) as ScrollbarVisibilitySnapshot
}

async function waitForFixtureVisibility(
  win: BrowserWindow,
  verticalVisible: boolean,
  horizontalVisible: boolean,
  state: string,
): Promise<ScrollbarVisibilitySnapshot> {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS
  for (;;) {
    const snapshot = await fixtureDimensions(win)
    if (
      snapshot.verticalVisible === verticalVisible &&
      snapshot.horizontalVisible === horizontalVisible
    ) {
      return snapshot
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${state} did not reach expected overlay visibility ` +
          `(vertical=${verticalVisible}, horizontal=${horizontalVisible}, ` +
          `last=${JSON.stringify(snapshot)})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, VISIBILITY_POLL_MS))
  }
}

async function resizeFixture(win: BrowserWindow, width: number): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
      if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
      surface.style.width = ${JSON.stringify(`${width}px`)};
    })()
  `)
}

async function reachHorizontalEnd(
  win: BrowserWindow,
): Promise<{ readonly position: number; readonly maximum: number }> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
      if (!(surface instanceof HTMLElement)) throw new Error('scrollbar fixture missing');
      surface.scrollLeft = surface.scrollWidth;
      return { position: surface.scrollLeft, maximum: surface.scrollWidth - surface.clientWidth };
    })()
  `)) as { readonly position: number; readonly maximum: number }
}

async function verifyForcedColors(win: BrowserWindow): Promise<void> {
  const chromiumDebugger = win.webContents.debugger
  const ownsDebugger = !chromiumDebugger.isAttached()
  if (ownsDebugger) chromiumDebugger.attach('1.3')
  try {
    await chromiumDebugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'forced-colors', value: 'active' }],
    })
    const presentation = (await win.webContents.executeJavaScript(`
      (() => {
        const surface = document.getElementById(${JSON.stringify(SURFACE_ID)});
        const overlay = document.querySelector('.hvir-scrollbar');
        if (!(surface instanceof HTMLElement) || !(overlay instanceof HTMLElement)) {
          throw new Error('forced-colors scrollbar fixture missing');
        }
        return {
          scrollbarColor: getComputedStyle(surface).scrollbarColor,
          scrollbarWidth: getComputedStyle(surface).scrollbarWidth,
          overlayDisplay: getComputedStyle(overlay).display
        };
      })()
    `)) as {
      readonly scrollbarColor: string
      readonly scrollbarWidth: string
      readonly overlayDisplay: string
    }
    if (
      presentation.scrollbarColor !== 'auto' ||
      presentation.scrollbarWidth !== 'auto' ||
      presentation.overlayDisplay !== 'none'
    ) {
      throw new Error(
        `forced-colors did not restore native scrollbar presentation ` +
          `(${JSON.stringify(presentation)})`,
      )
    }
  } finally {
    try {
      await chromiumDebugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    } finally {
      if (ownsDebugger && chromiumDebugger.isAttached()) chromiumDebugger.detach()
    }
  }
}

async function removeFixture(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  await win.webContents
    .executeJavaScript(`document.getElementById(${JSON.stringify(FIXTURE_ID)})?.remove()`)
    .catch(() => undefined)
}
