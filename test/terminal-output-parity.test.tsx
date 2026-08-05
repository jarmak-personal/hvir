// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  TerminalEventHandlers,
  TerminalEventRoute,
  TerminalEventRouter,
} from '../src/renderer/src/terminal/terminal-event-router'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'
import { TerminalRuntime } from '../src/renderer/src/terminal/terminal-runtime'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import {
  asHarnessProfileId,
  asHostId,
  hostPath,
  localPath,
  type HostPath,
} from '../src/shared'

const paneState = vi.hoisted(() => ({
  panes: [] as Array<{
    writes: string[]
    presentations: string[]
    pastes: string[]
    terminalActions: string[]
    emitData(data: string): void
    disposed: boolean
  }>,
}))

vi.mock('../src/renderer/src/terminal/terminal-pane-factory', () => ({
  createTerminalRuntimePane: vi.fn(() => Promise.resolve(createPane())),
}))

describe('terminal output host parity', () => {
  afterEach(() => {
    paneState.panes.splice(0)
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
  })

  it('delivers identical native chunks directly for local and SSH terminals', async () => {
    const chunks = ['\u001b[?20', '26hpartial\u001b]2;parsed\u0007', 'final\u001b[?2026l']

    const local = await deliver(localPath('/repo'), 'local-terminal', chunks)
    const ssh = await deliver(
      hostPath(asHostId('ssh-parity'), '/srv/repo'),
      'ssh-terminal',
      chunks,
    )

    expect(local.writes).toEqual(chunks)
    expect(ssh.writes).toEqual(chunks)
    expect(ssh.writes).toEqual(local.writes)
    expect(local.outputEvents).toBe(chunks.length)
    expect(ssh.outputEvents).toBe(chunks.length)
    expect(local.disposed).toBe(true)
    expect(ssh.disposed).toBe(true)
    expect(local.presentations).toEqual(['hidden', 'visible', 'hidden'])
    expect(ssh.presentations).toEqual(local.presentations)
    expect(local.pastes).toEqual(['line one\nline two'])
    expect(ssh.pastes).toEqual(local.pastes)
    expect(local.terminalActions).toEqual(['select-all', 'clear', 'reset'])
    expect(ssh.terminalActions).toEqual(local.terminalActions)
    expect(local.ptyWrites).toEqual(['line one\nline two'])
    expect(ssh.ptyWrites).toEqual(local.ptyWrites)
  })
})

async function deliver(
  root: HostPath,
  sessionId: string,
  chunks: readonly string[],
): Promise<{
  readonly writes: readonly string[]
  readonly outputEvents: number
  readonly presentations: readonly string[]
  readonly pastes: readonly string[]
  readonly terminalActions: readonly string[]
  readonly ptyWrites: readonly string[]
  readonly disposed: boolean
}> {
  let handlers: TerminalEventHandlers | undefined
  let routeDisposed = false
  const route: TerminalEventRoute = {
    setPresentation: () => undefined,
    snapshot: () => ({
      nativeDataEvents: 0,
      deliveryCallbacks: 0,
      receivedBytes: 0,
      deliveredBytes: 0,
      peakBufferedBytes: 0,
      bufferedBytes: 0,
      pending: false,
      presentation: 'visible',
    }),
    exposeStats: () => undefined,
    dispose: () => {
      routeDisposed = true
    },
  }
  const router = {
    register: (
      registeredId: string,
      _presentation: 'visible' | 'hidden',
      registeredHandlers: TerminalEventHandlers,
    ) => {
      expect(registeredId).toBe(sessionId)
      handlers = registeredHandlers
      return route
    },
  } as unknown as TerminalEventRouter
  const options = runtimeOptions(root, sessionId)
  const invoke = vi.fn(() =>
    Promise.resolve({
      outcome: 'started' as const,
      id: sessionId,
      pid: 42,
      resumed: false,
      reattached: false,
      harnessSessionId: undefined,
      identityStatus: 'unsupported' as const,
      capabilities: {
        sessionIdentity: 'none' as const,
        exactResume: false,
        contextPresentation: 'none' as const,
      },
    }),
  )
  const send = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke, send, on: vi.fn(() => () => undefined) },
  })
  const runtime = new TerminalRuntime(
    options,
    () => router,
    () => undefined,
    () => Promise.resolve(() => undefined),
  )
  const container = document.createElement('div')
  document.body.append(container)
  runtime.attach(container)
  await vi.waitFor(() => expect(handlers).toBeDefined())
  await vi.waitFor(() => expect(runtime.contextMenuTarget()).toBeDefined())
  expect(invoke).toHaveBeenCalledWith(
    'pty:start',
    expect.objectContaining({ cwd: root, sessionId }),
  )

  const target = runtime.contextMenuTarget()!
  expect(target.paste('line one\nline two')).toBe(true)
  expect(target.selectAll()).toBe(true)
  expect(target.clear()).toBe(true)
  expect(target.reset()).toBe(true)

  for (const chunk of chunks) handlers!.onData(chunk)
  const pane = paneState.panes.at(-1)!
  runtime.dispose()

  expect(routeDisposed).toBe(true)
  return {
    writes: pane.writes,
    outputEvents: vi.mocked(options.onOutput).mock.calls.length,
    presentations: pane.presentations,
    pastes: pane.pastes,
    terminalActions: pane.terminalActions,
    ptyWrites: send.mock.calls
      .filter(([channel]) => channel === 'pty:write')
      .map(([, payload]) => (payload as { readonly data: string }).data),
    disposed: pane.disposed,
  }
}

function createPane(): TerminalPane {
  const state = {
    writes: [] as string[],
    presentations: [] as string[],
    pastes: [] as string[],
    terminalActions: [] as string[],
    emitData: (_data: string): void => undefined,
    disposed: false,
  }
  paneState.panes.push(state)
  const listen = () => () => undefined
  return {
    mount: () => undefined,
    reparent: () => undefined,
    dispose: () => {
      state.disposed = true
    },
    write: (data) => state.writes.push(data),
    resize: () => undefined,
    setTheme: () => undefined,
    setTypography: () => undefined,
    setPresentation: (presentation) => state.presentations.push(presentation),
    redraw: () => undefined,
    resolveEventProvenance: () => undefined,
    activeEventScreen: () => 'normal',
    revealEventLocation: () => false,
    hasSelection: () => false,
    getSelection: () => '',
    paste: (data) => {
      state.pastes.push(data)
      state.emitData(data)
    },
    selectAll: () => void state.terminalActions.push('select-all'),
    clear: () => void state.terminalActions.push('clear'),
    reset: () => void state.terminalActions.push('reset'),
    focus: () => undefined,
    events: {
      onData: (callback) => {
        state.emitData = callback
        return () => {
          state.emitData = () => undefined
        }
      },
      onClipboardPaste: listen,
      onEvent: listen,
      onResize: listen,
      onLink: listen,
    },
  }
}

function runtimeOptions(root: HostPath, sessionId: string): TerminalRuntimeOptions {
  return {
    sessionId,
    profileId: asHarnessProfileId('bare-shell'),
    launchRevision: 1,
    riskAcknowledged: false,
    supportsResume: false,
    fallbackTitle: 'Shell',
    resumeOnStart: false,
    startMode: 'interactive',
    position: 0,
    active: true,
    presentation: 'visible',
    modifiedKeyProtocol: 'none',
    metaEnterAliasesControl: false,
    composerSubmitMode: 'enter',
    typography: { fontFamily: 'monospace', fontSize: 13 },
    cwd: root,
    workspaceRoot: root,
    connectionState: 'connected',
    onTitle: vi.fn(),
    onStatus: vi.fn(),
    onTelemetry: vi.fn(),
    onIdentity: vi.fn(),
    onStarted: vi.fn(),
    onFreshStarted: vi.fn(),
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}
