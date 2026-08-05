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
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke, send: vi.fn(), on: vi.fn(() => () => undefined) },
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
  expect(invoke).toHaveBeenCalledWith(
    'pty:start',
    expect.objectContaining({ cwd: root, sessionId }),
  )

  for (const chunk of chunks) handlers!.onData(chunk)
  const pane = paneState.panes.at(-1)!
  runtime.dispose()

  expect(routeDisposed).toBe(true)
  return {
    writes: pane.writes,
    outputEvents: vi.mocked(options.onOutput).mock.calls.length,
    presentations: pane.presentations,
    disposed: pane.disposed,
  }
}

function createPane(): TerminalPane {
  const state = { writes: [] as string[], presentations: [] as string[], disposed: false }
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
    focus: () => undefined,
    events: {
      onData: listen,
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
