// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type { TerminalPane } from '../src/renderer/src/terminal/terminal-pane'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
  type StartPtyResponse,
} from '../src/shared'

const paneState = vi.hoisted(() => ({
  instances: [] as Array<{ readonly emitTitle: (title: string) => void }>,
}))

vi.mock('../src/renderer/src/terminal/ghostty-terminal-pane', () => ({
  createGhosttyTerminalPane: vi.fn(() => {
    let titleListener: ((title: string) => void) | undefined
    let surface: HTMLDivElement | undefined
    const pane = {
      mount: vi.fn((container: HTMLElement) => {
        surface = document.createElement('div')
        surface.className = 'terminal-engine-host'
        container.append(surface)
      }),
      reparent: vi.fn((container: HTMLElement) => {
        if (surface) container.append(surface)
      }),
      dispose: vi.fn(() => {
        surface?.remove()
        surface = undefined
      }),
      write: vi.fn(),
      resize: vi.fn(),
      setTheme: vi.fn(),
      setPresentation: vi.fn(),
      redraw: vi.fn(),
      focus: vi.fn(),
      events: {
        onData: vi.fn(() => () => undefined),
        onTitle: vi.fn((listener: (title: string) => void) => {
          titleListener = listener
          return () => undefined
        }),
        onBell: vi.fn(() => () => undefined),
        onOsc: vi.fn(() => () => undefined),
        onResize: vi.fn(() => () => undefined),
        onLink: vi.fn(() => () => undefined),
      },
    } satisfies TerminalPane
    paneState.instances.push({ emitTitle: (title) => titleListener?.(title) })
    return Promise.resolve(pane)
  }),
}))

describe('terminal resume unavailable state', () => {
  let invoke: ReturnType<typeof vi.fn>
  let send: ReturnType<typeof vi.fn>
  let registry: TerminalRuntimeRegistry

  beforeEach(() => {
    paneState.instances.splice(0)
    invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'resume-unavailable' as const,
        reason: 'artifact-missing' as const,
      }),
    )
    send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: vi.fn(() => () => undefined),
      },
    })
    registry = new TerminalRuntimeRegistry()
  })

  afterEach(() => {
    registry.dispose()
    Reflect.deleteProperty(window, 'hvir')
    vi.restoreAllMocks()
  })

  it('keeps typed missing-artifact state sticky while preserving the retained identity', async () => {
    const runtimeOptions = options()
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    expect(runtime.snapshot()).toEqual({
      title: 'Claude Code · repo',
      status: 'Resume unavailable · session data is missing',
      exited: true,
      recoveryFailure: {
        kind: 'resume-unavailable',
        reason: 'artifact-missing',
      },
    })
    expect(runtimeOptions.onStatus).toHaveBeenCalledWith(
      'Resume unavailable · session data is missing',
    )
    expect(runtimeOptions.onStarted).not.toHaveBeenCalled()
    expect(runtimeOptions.onIdentity).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    paneState.instances[0]?.emitTitle('Harness title')
    expect(runtime.snapshot()).toEqual({
      title: 'Harness title',
      status: 'Resume unavailable · session data is missing',
      exited: true,
      recoveryFailure: {
        kind: 'resume-unavailable',
        reason: 'artifact-missing',
      },
    })

    runtime.restart()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenLastCalledWith(
      'pty:start',
      expect.objectContaining({
        sessionId: 'terminal-1',
        resume: true,
        harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
      }),
    )
    expect(runtimeOptions.onIdentity).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())
  })

  it('starts fresh under new terminal and harness identities after explicit choice', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d33b09dd-bf6a-4fab-b198-446017d5f8c9')
    const runtimeOptions = options()
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    invoke.mockResolvedValueOnce({
      outcome: 'started' as const,
      id: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      pid: 4321,
      resumed: false,
      harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      identityStatus: 'identified' as const,
      capabilities: {
        sessionIdentity: 'preassigned' as const,
        exactResume: true,
        contextPresentation: 'count' as const,
      },
    })

    runtime.startFresh()

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenLastCalledWith('pty:start', {
      sessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      replacesSessionId: 'terminal-1',
      profileId: runtimeOptions.profileId,
      launchRevision: runtimeOptions.launchRevision,
      cwd: runtimeOptions.cwd,
      cols: 80,
      rows: 24,
      title: 'Claude Code · repo',
      position: 0,
      active: true,
      composerSubmitMode: 'enter',
      admission: 'interactive',
      resume: false,
      harnessSessionId: undefined,
      acknowledgeRisk: false,
    })
    expect(runtimeOptions.onFreshStarted).toHaveBeenCalledWith({
      sessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      status: 'New session · pid 4321',
      harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      identityStatus: 'identified',
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'count',
      },
    })
    expect(runtimeOptions.onStarted).not.toHaveBeenCalled()
    expect(
      registry.acquire({
        ...runtimeOptions,
        sessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
        harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
        resumeOnStart: false,
      }),
    ).toBe(runtime)
  })

  it('keeps the original exact recovery retryable when fresh start fails', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d33b09dd-bf6a-4fab-b198-446017d5f8c9')
    const runtimeOptions = options()
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    invoke.mockRejectedValueOnce(new Error('fresh launch failed'))

    runtime.startFresh()
    await vi.waitFor(() =>
      expect(runtime.snapshot()).toMatchObject({
        status: 'fresh launch failed',
        exited: true,
      }),
    )
    expect(runtimeOptions.onFreshStarted).not.toHaveBeenCalled()

    runtime.restart()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3))
    expect(invoke).toHaveBeenLastCalledWith(
      'pty:start',
      expect.objectContaining({
        sessionId: 'terminal-1',
        replacesSessionId: undefined,
        resume: true,
        harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
      }),
    )
  })

  it('delivers a pending fresh handoff to remounted session callbacks', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d33b09dd-bf6a-4fab-b198-446017d5f8c9')
    let resolveFresh: ((value: StartPtyResponse) => void) | undefined
    const pendingFresh = new Promise<StartPtyResponse>((resolve) => {
      resolveFresh = resolve
    })
    const initialOptions = options()
    const runtime = registry.acquire(initialOptions)
    const initialContainer = document.createElement('div')
    runtime.attach(initialContainer)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    invoke.mockReturnValueOnce(pendingFresh)
    runtime.startFresh()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))

    runtime.detach(initialContainer)
    const remountedOptions = options()
    const remounted = registry.acquire(remountedOptions)
    remounted.attach(document.createElement('div'))
    resolveFresh?.({
      outcome: 'started',
      id: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      pid: 4321,
      resumed: false,
      harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      identityStatus: 'identified',
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'count',
      },
    })

    await vi.waitFor(() => expect(remountedOptions.onFreshStarted).toHaveBeenCalledOnce())
    expect(initialOptions.onFreshStarted).not.toHaveBeenCalled()
  })

  it('exposes the provisional identity for close cancellation and kills a late start', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d33b09dd-bf6a-4fab-b198-446017d5f8c9')
    let resolveFresh: ((value: StartPtyResponse) => void) | undefined
    const pendingFresh = new Promise<StartPtyResponse>((resolve) => {
      resolveFresh = resolve
    })
    const runtimeOptions = options()
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    invoke.mockReturnValueOnce(pendingFresh)
    runtime.startFresh()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))

    expect(registry.disposeSession('terminal-1')).toBe(
      'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
    )
    resolveFresh?.({
      outcome: 'started',
      id: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      pid: 4321,
      resumed: false,
      harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      identityStatus: 'identified',
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'count',
      },
    })

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('pty:kill', {
        id: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
      }),
    )
    expect(runtimeOptions.onFreshStarted).not.toHaveBeenCalled()
  })

  it('automatically resumes a retained exact session when main starts it', async () => {
    invoke.mockResolvedValueOnce({
      outcome: 'started' as const,
      id: 'terminal-1',
      pid: 4321,
      resumed: true,
      harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
      identityStatus: 'identified' as const,
      capabilities: {
        sessionIdentity: 'preassigned' as const,
        exactResume: true,
        contextPresentation: 'count-only' as const,
      },
    })
    const runtimeOptions = options()
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))

    await vi.waitFor(() =>
      expect(runtime.snapshot()).toEqual({
        title: 'Claude Code · repo',
        status: 'Resumed · pid 4321',
        exited: false,
      }),
    )
    expect(invoke).toHaveBeenCalledWith(
      'pty:start',
      expect.objectContaining({
        resume: true,
        harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
      }),
    )
    expect(runtimeOptions.onStarted).toHaveBeenCalledOnce()
    expect(runtimeOptions.onIdentity).toHaveBeenCalledWith(
      '05ea41ff-026f-4ab6-b930-64eb3b497806',
      'identified',
    )
  })

  it('shows unavailable recovery distinctly in the terminal rail', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const runtimeOptions = options()
    const provider: HarnessProviderDescriptor = {
      id: asHarnessProviderId('claude-code'),
      displayName: 'Claude Code',
      default: false,
      capabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'none',
      },
      terminalInput: {
        modifiedKeyProtocol: 'modify-other-keys',
        metaEnterAliasesControl: true,
      },
      profileGuidance: { reservedArguments: [], riskClassification: 'best-effort' },
    }
    const profile = {
      id: runtimeOptions.profileId,
      displayName: 'Claude Code',
      risk: 'standard',
    } as unknown as HarnessProfile
    const session: TerminalSession = {
      id: runtimeOptions.sessionId,
      providerId: provider.id,
      profileId: runtimeOptions.profileId,
      launchRevision: runtimeOptions.launchRevision,
      riskAcknowledged: false,
      capabilities: provider.capabilities,
      fallbackTitle: runtimeOptions.fallbackTitle,
      title: 'Retained conversation',
      status: 'Resume unavailable · session data is missing',
      harnessSessionId: runtimeOptions.harnessSessionId,
      identityStatus: 'identified',
      resumeOnStart: true,
      pane: 'primary',
      cwd: runtimeOptions.cwd,
    }

    act(() => {
      root.render(
        <TerminalRail
          label="repo"
          visible
          compact={false}
          onCompact={vi.fn()}
          terminalTheme="app"
          recoveryReady
          available
          menuOpen={false}
          moveMenuOpen={false}
          moveTargets={[]}
          launchMenuEntries={[]}
          checkingHiddenProfiles={false}
          split={false}
          sessions={[session]}
          activeId={session.id}
          providers={[provider]}
          profiles={[profile]}
          onSplit={vi.fn()}
          onOpenSettings={vi.fn()}
          onToggleMenu={vi.fn()}
          onToggleMoveMenu={vi.fn()}
          onPlanMove={vi.fn()}
          onDismissNewTargets={vi.fn()}
          onAddSession={vi.fn()}
          onAddHarness={vi.fn()}
          onRefreshProbes={vi.fn()}
          onOpenHarnessSettings={vi.fn()}
          onResumeAll={vi.fn()}
          onFocusSession={vi.fn()}
          onMoveSession={vi.fn()}
          onCloseSession={vi.fn()}
        />,
      )
    })

    expect(host.querySelector('.terminal-list-title')?.textContent).toBe(
      'Retained conversation',
    )
    expect(host.querySelector('.terminal-list-meta')?.textContent).toContain(
      'Resume unavailable · session data is missing',
    )
    act(() => root.unmount())
    host.remove()
  })
})

function options(): TerminalRuntimeOptions {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('claude-code-default'),
    launchRevision: 1,
    riskAcknowledged: false,
    supportsResume: true,
    fallbackTitle: 'Claude Code · repo',
    harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
    resumeOnStart: true,
    startMode: 'interactive',
    position: 0,
    active: true,
    presentation: 'visible',
    modifiedKeyProtocol: 'modify-other-keys',
    metaEnterAliasesControl: true,
    composerSubmitMode: 'enter',
    cwd: localPath('/repo'),
    workspaceRoot: localPath('/repo'),
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
