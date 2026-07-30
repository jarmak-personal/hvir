import { net, protocol, type BrowserWindow } from 'electron'

import { HTML_PREVIEW_SCHEME } from '../../shared'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { verifyScrollbarPresentation } from './scrollbar-presentation'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'

interface RectSnapshot {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
  readonly width: number
  readonly height: number
}

interface PlatformContractSnapshot {
  readonly terminalStatus: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly workbench: RectSnapshot
  readonly terminalPanel: RectSnapshot
  readonly terminalHost: RectSnapshot
  readonly terminalCanvas: RectSnapshot
  readonly terminalDivider: RectSnapshot
  readonly paddingRight: number
  readonly paddingBottom: number
}

type PaneDividerPoint = readonly [number, number]
type PaneDividerVisibility = readonly [number, number, number, number, number, number]

interface PaneDividerControlPoints {
  readonly safe: PaneDividerPoint
  readonly tree: PaneDividerPoint
  readonly terminal: PaneDividerPoint
}

const PANE_DIVIDER_STATE_TIMEOUT_MS = 2_000
const PANE_DIVIDER_STATE_POLL_MS = 25

/** Prove the real platform contracts retained by unpackaged and installed smoke. */
export async function verifyPlatformContracts({
  htmlPreviews,
  supervisor,
  win,
}: {
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly supervisor: PtySupervisor
  readonly win: BrowserWindow
}): Promise<string> {
  const explicitLaunch = await ensureExplicitBareShellLaunch(win, supervisor)
  const snapshot = await platformContractSnapshot(win)
  assertPlatformGeometry(snapshot)
  const paneDividerStatus = await verifyPaneDividerControlVisibility(win)
  const scrollbarStatus = await verifyScrollbarPresentation(win)
  const processSandboxStatus =
    process.env['HVIR_SMOKE_REQUIRE_PROCESS_SANDBOX'] === '1'
      ? await verifyRequiredProcessSandbox(win)
      : ''

  const terminals = supervisor.list()
  if (terminals.length !== 1) {
    throw new Error(
      `platform contract expected one explicitly launched PTY, found ${terminals.length} ` +
        `(snapshot=${JSON.stringify(snapshot)})`,
    )
  }
  const terminal = terminals[0]!
  if (!snapshot.terminalStatus.includes(String(terminal.pid))) {
    throw new Error(
      `platform terminal status did not identify supervised pid ${terminal.pid} ` +
        `(snapshot=${JSON.stringify(snapshot)})`,
    )
  }

  const protocolStatus = await verifyPreviewProtocol(htmlPreviews)
  const rightRemainder =
    snapshot.terminalHost.right - snapshot.paddingRight - snapshot.terminalCanvas.right
  const bottomRemainder =
    snapshot.terminalHost.bottom - snapshot.paddingBottom - snapshot.terminalCanvas.bottom
  return (
    `${process.platform} ${process.arch} · ${snapshot.viewport.width}×${snapshot.viewport.height} ` +
    `· terminal ${Math.round(snapshot.terminalPanel.height)}px · ` +
    `canvas remainder ${rightRemainder.toFixed(1)}×${bottomRemainder.toFixed(1)}px ` +
    `${processSandboxStatus}· ${paneDividerStatus} · ${scrollbarStatus} ` +
    `· ${explicitLaunch} · ${protocolStatus}`
  )
}

async function verifyPaneDividerControlVisibility(win: BrowserWindow): Promise<string> {
  const points = await paneDividerControlPoints(win)
  const originalTheme = (await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('data-theme')`,
  )) as string | null
  const hidden = [0, 0, 0, 0, 0, 0] as const
  const treeRevealed = [1, 1, 0, 0, 0, 0] as const
  const terminalRevealed = [0, 0, 0, 1, 1, 0] as const
  try {
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      `)
      await expectPaneDividerVisibility(win, points.safe, hidden, `${theme} inactive`)
      await expectPaneDividerVisibility(
        win,
        points.tree,
        treeRevealed,
        `${theme} tree hover`,
      )
      await expectPaneDividerVisibility(
        win,
        points.terminal,
        terminalRevealed,
        `${theme} terminal hover`,
      )
    }

    moveMouse(win, points.safe)
    win.focus()
    win.webContents.focus()
    await focusPaneDividerAction(win, '.tree-resizer')
    await waitForPaneDividerVisibility(
      win,
      [1, 1, 1, 0, 0, 0],
      'tree keyboard focus',
    )

    await focusPaneDividerAction(win, '.terminal-resizer')
    await waitForPaneDividerVisibility(
      win,
      [0, 0, 0, 1, 1, 1],
      'terminal keyboard focus',
    )
  } finally {
    await win.webContents.executeJavaScript(`
      if (${JSON.stringify(originalTheme)} === null) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(originalTheme)});
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    `)
    moveMouse(win, points.safe)
  }
  return 'pane controls dark/light hover + keyboard focus'
}

async function paneDividerControlPoints(
  win: BrowserWindow,
): Promise<PaneDividerControlPoints> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const viewer = document.querySelector('.viewer-panel');
      const tree = document.querySelector('.tree-collapse-toggle');
      const terminal = document.querySelector('.terminal-focus-toggle');
      if (!(viewer instanceof HTMLElement) ||
          !(tree instanceof HTMLElement) ||
          !(terminal instanceof HTMLElement)) {
        throw new Error('pane divider controls missing');
      }
      const point = (node) => {
        const rect = node.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
      };
      const viewerRect = viewer.getBoundingClientRect();
      return {
        safe: [viewerRect.right - 24, viewerRect.top + 24],
        tree: point(tree),
        terminal: point(terminal)
      };
    })()
  `)) as PaneDividerControlPoints
}

async function paneDividerVisibility(win: BrowserWindow): Promise<PaneDividerVisibility> {
  return (await win.webContents.executeJavaScript(`
    (() => {
      const read = (dividerSelector, controlSelector, actionSelector) => {
        const divider = document.querySelector(dividerSelector);
        const control = document.querySelector(controlSelector);
        const action = document.querySelector(actionSelector);
        if (!(divider instanceof HTMLElement) ||
            !(control instanceof HTMLElement) ||
            !(action instanceof HTMLElement)) {
          throw new Error('pane divider visibility target missing');
        }
        return [
          Number(getComputedStyle(control).opacity),
          Number(getComputedStyle(divider, '::after').opacity),
          Number(action.matches(':focus-visible'))
        ];
      };
      return [
        ...read('.tree-resizer', '.tree-collapse-toggle', '.tree-collapse-toggle'),
        ...read(
          '.terminal-resizer',
          '.terminal-mode-controls',
          '.terminal-focus-toggle'
        )
      ];
    })()
  `)) as PaneDividerVisibility
}

async function expectPaneDividerVisibility(
  win: BrowserWindow,
  point: PaneDividerPoint,
  expected: PaneDividerVisibility,
  context: string,
): Promise<void> {
  moveMouse(win, point)
  await waitForPaneDividerVisibility(win, expected, context)
}

async function waitForPaneDividerVisibility(
  win: BrowserWindow,
  expected: PaneDividerVisibility,
  context: string,
): Promise<void> {
  const deadline = Date.now() + PANE_DIVIDER_STATE_TIMEOUT_MS
  let actual = await paneDividerVisibility(win)
  while (!paneDividerVisibilityMatches(actual, expected)) {
    if (Date.now() > deadline) {
      assertPaneDividerVisibility(actual, expected, context)
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_DIVIDER_STATE_POLL_MS))
    actual = await paneDividerVisibility(win)
  }
}

function assertPaneDividerVisibility(
  actual: PaneDividerVisibility,
  expected: PaneDividerVisibility,
  context: string,
): void {
  if (!paneDividerVisibilityMatches(actual, expected)) {
    throw new Error(
      `${context} state was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    )
  }
}

function paneDividerVisibilityMatches(
  actual: PaneDividerVisibility,
  expected: PaneDividerVisibility,
): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= 0.01)
}

function moveMouse(win: BrowserWindow, [x, y]: PaneDividerPoint): void {
  const input = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({
    ...input,
    type: 'mouseEnter',
  })
  win.webContents.sendInputEvent({
    ...input,
    type: 'mouseMove',
  })
}

async function focusPaneDividerAction(
  win: BrowserWindow,
  dividerSelector: string,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const divider = document.querySelector(${JSON.stringify(dividerSelector)});
      if (!(divider instanceof HTMLElement)) throw new Error('pane divider missing');
      divider.focus();
    })()
  `)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
}

async function verifyRequiredProcessSandbox(win: BrowserWindow): Promise<string> {
  if (process.argv.includes('--no-sandbox')) {
    throw new Error('required Chromium process sandbox was disabled by --no-sandbox')
  }
  const rendererSandboxed = (await win.webContents.executeJavaScript(`
    window.hvir?.diagnostics?.processSandboxed === true
  `)) as boolean
  if (!rendererSandboxed) {
    throw new Error('required Chromium renderer sandbox is not active')
  }
  return '· renderer sandbox active '
}

async function verifyPreviewProtocol(htmlPreviews: HtmlPreviewProtocol): Promise<string> {
  if (!protocol.isProtocolHandled(HTML_PREVIEW_SCHEME)) {
    throw new Error(`${HTML_PREVIEW_SCHEME} protocol is not handled`)
  }
  const marker = 'hvir-platform-protocol-ok'
  const preview = htmlPreviews.create(`<!doctype html><p>${marker}</p>`)
  try {
    const response = await net.fetch(preview.url)
    const body = await response.text()
    const csp = response.headers.get('content-security-policy')
    if (!response.ok || !body.includes(marker) || !csp) {
      throw new Error(
        `${HTML_PREVIEW_SCHEME} response was invalid ` +
          `(status=${response.status}, marker=${body.includes(marker)}, csp=${Boolean(csp)})`,
      )
    }
  } finally {
    htmlPreviews.release(preview.id)
  }
  return `${HTML_PREVIEW_SCHEME} handled`
}

async function platformContractSnapshot(
  win: BrowserWindow,
): Promise<PlatformContractSnapshot> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      let lastSnapshot = { terminalStatus: 'not mounted' };
      const rect = (node) => {
        if (!(node instanceof Element)) return undefined;
        const value = node.getBoundingClientRect();
        return {
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          left: value.left,
          width: value.width,
          height: value.height
        };
      };
      const snapshot = () => {
        const panel = document.querySelector('.terminal-panel');
        const host = document.querySelector('.terminal-container');
        const canvas = host?.querySelector('canvas');
        const workbench = document.querySelector('.workbench');
        const divider = document.querySelector('.terminal-resizer');
        const hostStyle = host instanceof HTMLElement ? getComputedStyle(host) : undefined;
        return {
          terminalStatus: panel?.getAttribute('data-terminal-status') || '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
          workbench: rect(workbench),
          terminalPanel: rect(panel),
          terminalHost: rect(host),
          terminalCanvas: rect(canvas),
          terminalDivider: rect(divider),
          paddingRight: parseFloat(hostStyle?.paddingRight || '0') || 0,
          paddingBottom: parseFloat(hostStyle?.paddingBottom || '0') || 0
        };
      };
      const poll = () => {
        lastSnapshot = snapshot();
        if (
          lastSnapshot.terminalStatus.startsWith('pid ') &&
          lastSnapshot.workbench &&
          lastSnapshot.terminalPanel &&
          lastSnapshot.terminalHost &&
          lastSnapshot.terminalCanvas &&
          lastSnapshot.terminalDivider
        ) {
          return resolve(lastSnapshot);
        }
        if (
          lastSnapshot.terminalStatus &&
          lastSnapshot.terminalStatus !== 'Starting…'
        ) {
          return reject(new Error(
            'platform terminal failed to start: ' + JSON.stringify(lastSnapshot)
          ));
        }
        if (Date.now() > deadline) {
          return reject(new Error(
            'platform contracts did not materialize: ' + JSON.stringify(lastSnapshot)
          ));
        }
        setTimeout(poll, 25);
      };
      poll();
    })
  `)) as PlatformContractSnapshot
}

function assertPlatformGeometry(snapshot: PlatformContractSnapshot): void {
  const fail = (message: string): never => {
    throw new Error(`${message} (snapshot=${JSON.stringify(snapshot)})`)
  }
  if (
    Math.abs(snapshot.workbench.bottom - snapshot.viewport.height) > 1 ||
    Math.abs(snapshot.terminalHost.bottom - snapshot.viewport.height) > 1
  ) {
    fail('terminal extends outside the content viewport')
  }
  for (const [name, rect] of [
    ['workbench', snapshot.workbench],
    ['terminal panel', snapshot.terminalPanel],
    ['terminal host', snapshot.terminalHost],
  ] as const) {
    if (
      rect.top < -1 ||
      rect.left < -1 ||
      rect.right > snapshot.viewport.width + 1 ||
      rect.bottom > snapshot.viewport.height + 1
    ) {
      fail(`${name} is not contained by the content viewport`)
    }
  }

  const defaultTerminalShare = 3.8 / (4 + 3.8)
  const requiredTerminalHeight = Math.min(
    325,
    Math.max(
      260,
      Math.floor(
        (snapshot.workbench.height - snapshot.terminalDivider.height) *
          defaultTerminalShare -
          2,
      ),
    ),
  )
  if (snapshot.terminalPanel.height + 1 < requiredTerminalHeight) {
    fail(
      `default terminal is too short: ${Math.round(snapshot.terminalPanel.height)}px < ` +
        `${requiredTerminalHeight}px`,
    )
  }

  const rightRemainder =
    snapshot.terminalHost.right - snapshot.paddingRight - snapshot.terminalCanvas.right
  const bottomRemainder =
    snapshot.terminalHost.bottom - snapshot.paddingBottom - snapshot.terminalCanvas.bottom
  if (rightRemainder < -1 || bottomRemainder < -1) {
    fail(
      `terminal canvas exceeds its content box: right=${rightRemainder}, bottom=${bottomRemainder}`,
    )
  }
  if (rightRemainder >= 12 || bottomRemainder >= 20) {
    fail(
      `terminal fit wastes more than one cell: right=${rightRemainder}, bottom=${bottomRemainder}`,
    )
  }
}
