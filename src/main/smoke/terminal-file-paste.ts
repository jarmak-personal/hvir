import { pathToFileURL } from 'node:url'

import { clipboard, type BrowserWindow } from 'electron'

import { isLocal, joinHostPath, type HostPath } from '../../shared'
import { plainShellProvider } from '../harness/harness-provider'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import { URI_LIST_FORMAT } from '../terminal/electron-clipboard-file-paste'
import { withTerminalSmokeTimeout } from './terminal-smoke-timeout'

const INPUT_ID = '__hvir-terminal-file-paste-probe'
const READY_MARKER = '__HVIR_FILE_PASTE_READY__'
const SUCCESS_MARKER = '__HVIR_FILE_PASTE_OK__'
const FAILURE_PREFIX = '__HVIR_FILE_PASTE_FAIL__:'
const CLOSED_PREFIX = '__HVIR_FILE_PASTE_CLOSED__:'
const CLOSED_SUCCESS_MARKER = `${CLOSED_PREFIX}0`

const FILE_PASTE_PROBE_SOURCE = `
const expected = Buffer.from(process.argv[2], 'base64');
const ready = '${READY_MARKER}';
const success = '${SUCCESS_MARKER}';
const failure = '${FAILURE_PREFIX}';
const closed = '${CLOSED_PREFIX}';
let buffered = Buffer.alloc(0);
let finished = false;
let settle;
const finish = (requestedCode, requestedMessage) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(settle);
  process.stdin.pause();
  let code = requestedCode;
  let message = requestedMessage;
  try {
    process.stdin.setRawMode(false);
  } catch {
    code = 2;
    message = failure + 'tty-restore';
  }
  process.stdout.write('\\r\\n' + message + '\\r\\n' + closed + code + '\\r\\n', () => {
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 100);
};
const fail = (message) => finish(2, failure + message);
const deadline = setTimeout(() => fail('timeout'), 8000);
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  fail('stdin-not-tty');
} else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(3)) return finish(130, failure + 'aborted');
    buffered = Buffer.concat([buffered, chunk]);
    const compared = Math.min(buffered.length, expected.length);
    if (!buffered.subarray(0, compared).equals(expected.subarray(0, compared))) {
      return fail('unexpected-input');
    }
    if (buffered.length > expected.length) return fail('duplicate-input');
    if (buffered.length === expected.length && !settle) {
      settle = setTimeout(() => finish(0, success), 150);
    }
  });
  process.stdout.write(ready + '\\r\\n');
}
`

/**
 * Exercise Linux native clipboard formats through main IPC, ghostty-web, and
 * the exact live PTY. Other local platforms retain the disk-backed Chromium
 * File proof for the synchronous webUtils fallback.
 */
export async function verifyTerminalClipboardFilePaste(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  root: HostPath,
): Promise<void> {
  if (!isLocal(root)) {
    throw new Error('terminal file paste smoke requires a local project path')
  }
  const terminal = requireSolePlainShellTerminal(supervisor, win.webContents.id)
  const fixturePath = joinHostPath(root, 'package.json').path

  const observation = new FilePasteObservation()
  let terminalExit: string | undefined
  let restoreClipboard: (() => void) | undefined
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => observation.consume(data),
    onExit: (exit) => {
      terminalExit = exit.signal ? `signal ${exit.signal}` : `code ${exit.exitCode}`
    },
  })

  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      filePasteProbeLaunchCommand(fixturePath),
    )
    await waitForObservation(
      observation,
      () => terminalExit,
      READY_MARKER,
      'terminal file-paste probe did not become ready',
    )
    if (process.platform === 'linux') {
      restoreClipboard = await dispatchNativeLinuxFilePaste(win, terminal.id, fixturePath)
    } else {
      await dispatchDiskBackedFilePaste(win, terminal.id, fixturePath)
    }
    await waitForObservation(
      observation,
      () => terminalExit,
      SUCCESS_MARKER,
      'terminal file-paste path was not received exactly once',
    )
    await waitForObservation(
      observation,
      () => terminalExit,
      CLOSED_SUCCESS_MARKER,
      'terminal file-paste probe did not restore its terminal state',
    )

    const retained = supervisor.get(terminal.id)
    if (retained?.instanceId !== terminal.instanceId) {
      throw new Error('terminal file paste replaced its Shell PTY')
    }
  } finally {
    if (!observation.hasClosed) {
      try {
        const retained = supervisor.get(terminal.id)
        if (retained?.instanceId === terminal.instanceId) {
          supervisor.write(terminal.id, terminal.ownerId, '\x03')
        }
      } catch {
        // Preserve the original failure; scenario teardown owns an unresponsive PTY.
      }
    }
    restoreClipboard?.()
    await detach()
    await removeProbeInput(win)
  }
}

function requireSolePlainShellTerminal(
  supervisor: PtySupervisor,
  ownerId: number,
): ManagedPty {
  const owned = supervisor.list().filter((terminal) => terminal.ownerId === ownerId)
  if (owned.length !== 1 || owned[0]!.providerId !== plainShellProvider.manifest.id) {
    throw new Error('file paste requires one exact Shell-provider PTY')
  }
  return owned[0]!
}

function filePasteProbeLaunchCommand(expectedPath: string): string {
  const source = Buffer.from(FILE_PASTE_PROBE_SOURCE).toString('base64')
  const expected = Buffer.from(expectedPath).toString('base64')
  return `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${source}' '${expected}'\n`
}

async function dispatchNativeLinuxFilePaste(
  win: BrowserWindow,
  terminalId: string,
  fixturePath: string,
): Promise<() => void> {
  const restore = captureClipboardRestore()
  try {
    clipboard.writeBuffer(
      URI_LIST_FORMAT,
      Buffer.from(`${pathToFileURL(fixturePath).href}\r\n`),
    )
    const focused: unknown = await win.webContents.executeJavaScript(`
      (() => {
        const surface = document.querySelector(
          '.terminal-surface[data-terminal-session="' +
            CSS.escape(${JSON.stringify(terminalId)}) + '"]'
        );
        const textarea = surface?.querySelector('.terminal-engine-host textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.focus();
        return document.activeElement === textarea;
      })()
    `)
    if (focused !== true) throw new Error('terminal file-paste input was not focused')

    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'V',
      modifiers: ['control', 'shift'],
    })
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'V',
      modifiers: ['control', 'shift'],
    })
    return restore
  } catch (error) {
    restore()
    throw error
  }
}

function captureClipboardRestore(): () => void {
  const previous = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  }
  return () => {
    const data: Parameters<typeof clipboard.write>[0] = {}
    if (previous.text) data.text = previous.text
    if (previous.html) data.html = previous.html
    if (previous.rtf) data.rtf = previous.rtf
    if (!previous.image.isEmpty()) data.image = previous.image
    if (Object.keys(data).length > 0) clipboard.write(data)
    else clipboard.clear()
  }
}

async function dispatchDiskBackedFilePaste(
  win: BrowserWindow,
  terminalId: string,
  fixturePath: string,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById(${JSON.stringify(INPUT_ID)})?.remove();
      const input = document.createElement('input');
      input.id = ${JSON.stringify(INPUT_ID)};
      input.type = 'file';
      input.hidden = true;
      document.body.append(input);
    })()
  `)

  const protocol = win.webContents.debugger
  if (protocol.isAttached()) {
    throw new Error('terminal file paste cannot borrow an attached debugger')
  }
  protocol.attach('1.3')
  try {
    const document = (await protocol.sendCommand('DOM.getDocument')) as {
      readonly root: { readonly nodeId: number }
    }
    const input = (await protocol.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: `#${INPUT_ID}`,
    })) as { readonly nodeId: number }
    if (!input.nodeId) throw new Error('terminal file-paste input was not found')
    await protocol.sendCommand('DOM.setFileInputFiles', {
      files: [fixturePath],
      nodeId: input.nodeId,
    })
  } finally {
    protocol.detach()
  }

  const result = (await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById(${JSON.stringify(INPUT_ID)});
      const file = input instanceof HTMLInputElement ? input.files?.item(0) : null;
      const surface = document.querySelector(
        '.terminal-surface[data-terminal-session="' +
          CSS.escape(${JSON.stringify(terminalId)}) + '"]'
      );
      const engine = surface?.querySelector('.terminal-engine-host');
      if (!file || !(engine instanceof HTMLElement)) return null;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      const dispatchResult = engine.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        dispatchResult,
        files: transfer.files.length,
        text: transfer.getData('text/plain'),
        types: [...transfer.types],
      };
    })()
  `)) as {
    readonly defaultPrevented: boolean
    readonly dispatchResult: boolean
    readonly files: number
    readonly text: string
    readonly types: readonly string[]
  } | null

  if (
    !result ||
    result.files !== 1 ||
    result.text !== '' ||
    !result.types.includes('Files') ||
    !result.defaultPrevented ||
    result.dispatchResult
  ) {
    throw new Error('Electron did not expose the expected non-plain file paste event')
  }
}

async function removeProbeInput(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    await win.webContents.executeJavaScript(
      `document.getElementById(${JSON.stringify(INPUT_ID)})?.remove()`,
    )
  } catch {
    // Renderer teardown owns an unreachable temporary DOM node.
  }
}

class FilePasteObservation {
  private suffix = ''
  failed = false
  hasClosed = false

  consume(data: string): void {
    const combined = this.suffix + data
    this.failed ||= combined.includes(FAILURE_PREFIX)
    this.hasClosed ||= combined.includes(CLOSED_PREFIX)
    this.suffix = combined.slice(-256)
  }

  has(marker: string): boolean {
    return this.suffix.includes(marker)
  }
}

async function waitForObservation(
  observation: FilePasteObservation,
  readTerminalExit: () => string | undefined,
  marker: string,
  message: string,
): Promise<void> {
  await withTerminalSmokeTimeout(
    new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (observation.failed) {
          reject(new Error(`${message}: probe reported failure`))
          return
        }
        const terminalExit = readTerminalExit()
        if (terminalExit) {
          reject(new Error(`${message}: Shell PTY exited with ${terminalExit}`))
          return
        }
        if (observation.has(marker)) {
          resolve()
          return
        }
        setTimeout(poll, 25)
      }
      poll()
    }),
    message,
    10_000,
  )
}
