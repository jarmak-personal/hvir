import { net, protocol, type BrowserWindow } from 'electron'

import { HTML_PREVIEW_SCHEME } from '../../shared'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { PtySupervisor } from '../pty/pty-supervisor'

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
  const snapshot = await platformContractSnapshot(win)
  assertPlatformGeometry(snapshot)
  const processSandboxStatus =
    process.env['HVIR_SMOKE_REQUIRE_PROCESS_SANDBOX'] === '1'
      ? await verifyRequiredProcessSandbox(win)
      : ''

  const terminals = supervisor.list()
  if (terminals.length !== 1) {
    throw new Error(
      `platform contract expected one automatically launched PTY, found ${terminals.length} ` +
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
    `${processSandboxStatus}· pid ${terminal.pid} · ${protocolStatus}`
  )
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
