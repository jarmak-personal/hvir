// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type {
  TerminalEvent,
  TerminalPane,
} from '../src/renderer/src/terminal/terminal-pane'
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
  instances: [] as Array<{
    readonly emitTitle: (title: string) => void
    readonly emitEvent: (event: TerminalEvent) => void
    readonly emitClipboardPaste: (fallbackData: string) => void
    readonly focus: ReturnType<typeof vi.fn>
    readonly reparent: ReturnType<typeof vi.fn>
    readonly setPresentation: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../src/renderer/src/terminal/ghostty-terminal-pane', () => ({
  createGhosttyTerminalPane: vi.fn(() => {
    let eventListener: ((event: TerminalEvent) => void) | undefined
    let clipboardPasteListener: ((fallbackData: string) => void) | undefined
    let surface: HTMLDivElement | undefined
    const focus = vi.fn()
    const reparent = vi.fn((container: HTMLElement) => {
      if (surface) container.append(surface)
    })
    const setPresentation = vi.fn()
    const pane = {
      mount: vi.fn((container: HTMLElement) => {
        surface = document.createElement('div')
        surface.className = 'terminal-engine-host'
        container.append(surface)
      }),
      reparent,
      dispose: vi.fn(() => {
        surface?.remove()
        surface = undefined
      }),
      write: vi.fn(),
      resize: vi.fn(),
      setTheme: vi.fn(),
      setTypography: vi.fn(),
      setCursorDefaults: vi.fn(),
      setLigatures: vi.fn(),
      setPresentation,
      redraw: vi.fn(),
      resolveEventProvenance: vi.fn(() => undefined),
      activeEventScreen: vi.fn(() => 'normal' as const),
      revealEventLocation: vi.fn(() => false),
      searchRetainedBuffer: vi.fn(() =>
        Promise.resolve({
          query: '',
          caseSensitive: false,
          matches: [],
          reveal: () => false,
          extract: () => undefined,
          dispose: () => undefined,
        }),
      ),
      cancelRetainedBufferSearch: vi.fn(),
      captureRetainedBufferBoundary: vi.fn(() => undefined),
      extractRetainedBufferRange: vi.fn(() => Promise.resolve('')),
      cancelRetainedBufferExtraction: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ''),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clear: vi.fn(),
      reset: vi.fn(),
      focus,
      events: {
        onData: vi.fn(() => () => undefined),
        onClipboardPaste: vi.fn((listener: (fallbackData: string) => void) => {
          clipboardPasteListener = listener
          return () => undefined
        }),
        onEvent: vi.fn((listener: (event: TerminalEvent) => void) => {
          eventListener = listener
          return () => {
            if (eventListener === listener) eventListener = undefined
          }
        }),
        onResize: vi.fn(() => () => undefined),
        onLink: vi.fn(() => () => undefined),
      },
    } satisfies TerminalPane
    paneState.instances.push({
      emitTitle: (title) => eventListener?.({ type: 'title', title }),
      emitEvent: (event) => eventListener?.(event),
      emitClipboardPaste: (fallbackData) => clipboardPasteListener?.(fallbackData),
      focus,
      reparent,
      setPresentation,
    })
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

  it('keeps a retryable identity-baseline failure visible without claiming startup', async () => {
    invoke.mockResolvedValue({
      outcome: 'launch-unavailable' as const,
      reason: 'identity-baseline-unavailable' as const,
      retryable: true as const,
    })
    const runtimeOptions = {
      ...options(),
      harnessSessionId: undefined,
      resumeOnStart: false,
    }
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    expect(runtime.snapshot()).toEqual({
      title: 'Claude Code · repo',
      status: 'Launch unavailable · session recovery baseline could not be read',
      exited: true,
      recoveryFailure: undefined,
    })
    expect(runtimeOptions.onStarted).not.toHaveBeenCalled()
    expect(runtimeOptions.onIdentity).not.toHaveBeenCalled()

    runtime.restart()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenLastCalledWith(
      'pty:start',
      expect.objectContaining({ resume: false, harnessSessionId: undefined }),
    )
  })

  it('round-trips an explicit clipboard gesture and preserves the native fallback key', async () => {
    invoke.mockResolvedValue(startedResponse())
    const runtimeOptions = {
      ...options(),
      harnessSessionId: undefined,
      resumeOnStart: false,
    }
    const runtime = registry.acquire(runtimeOptions)
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())

    paneState.instances[0]?.emitClipboardPaste('\x16')

    expect(send).toHaveBeenCalledWith('terminal:paste-image', {
      id: 'terminal-1',
      fallbackData: '\x16',
    })
    expect(send).not.toHaveBeenCalledWith(
      'pty:write',
      expect.objectContaining({ data: '\x16' }),
    )
  })

  it('writes decoded OSC 52 text only after the runtime has started', async () => {
    invoke.mockResolvedValue(startedResponse())
    const runtime = registry.acquire({
      ...options(),
      harnessSessionId: undefined,
      resumeOnStart: false,
    })
    runtime.attach(document.createElement('div'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    send.mockClear()

    paneState.instances[0]?.emitEvent({
      type: 'clipboard',
      operation: 'write',
      selection: 'c',
      data: btoa('copied from a live tmux'),
    })

    expect(send).toHaveBeenCalledExactlyOnceWith('terminal:clipboard-write', {
      text: 'copied from a live tmux',
    })
  })

  it('restores search for the same pane and PTY after a hidden detach and reattach', async () => {
    invoke.mockResolvedValue(startedResponse())
    const runtimeOptions = {
      ...options(),
      harnessSessionId: undefined,
      resumeOnStart: false,
    }
    const runtime = registry.acquire(runtimeOptions)
    const initialContainer = document.createElement('div')
    runtime.attach(initialContainer)
    await vi.waitFor(() => expect(runtime.interactions.search.open()).toBe(true))
    runtime.interactions.search.close()

    runtime.update({ ...runtimeOptions, presentation: 'hidden' })
    runtime.synchronizeLifecycle()
    runtime.detach(initialContainer)
    expect(runtime.interactions.search.open()).toBe(false)

    runtime.update(runtimeOptions)
    runtime.synchronizeLifecycle()
    expect(runtime.interactions.search.open()).toBe(false)
    runtime.attach(document.createElement('div'))

    expect(runtime.interactions.search.open()).toBe(true)
    expect(paneState.instances).toHaveLength(1)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'fresh launch',
      configure: () => ({ harnessSessionId: undefined, resumeOnStart: false }),
      resume: false,
    },
    {
      name: 'exact resume',
      configure: () => ({}),
      resume: true,
    },
  ])(
    'keeps delayed $name completion hidden until the retained pane is restored',
    async ({ configure, resume }) => {
      let completeStart: ((result: StartPtyResponse) => void) | undefined
      invoke.mockReturnValueOnce(
        new Promise<StartPtyResponse>((resolve) => {
          completeStart = resolve
        }),
      )
      const runtimeOptions = { ...options(), ...configure() }
      const runtime = registry.acquire(runtimeOptions)
      const initialContainer = document.createElement('div')

      runtime.attach(initialContainer)
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
      expect(invoke).toHaveBeenCalledWith(
        'pty:start',
        expect.objectContaining({ resume }),
      )
      expect(deliveryPresentation(initialContainer)).toBe('visible')

      runtime.update({ ...runtimeOptions, presentation: 'hidden' })
      runtime.synchronizeLifecycle()
      expect(deliveryPresentation(initialContainer)).toBe('hidden')

      completeStart?.(startedResponse())
      await vi.waitFor(() => expect(runtimeOptions.onStarted).toHaveBeenCalledOnce())
      const pane = paneState.instances[0]!
      expect(pane.setPresentation).toHaveBeenLastCalledWith('hidden')
      expect(pane.focus).not.toHaveBeenCalled()
      expect(runtimeOptions.onFocus).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())
      expect(initialContainer.querySelector('.terminal-engine-host')).not.toBeNull()

      runtime.update(runtimeOptions)
      runtime.synchronizeLifecycle()
      runtime.focus()

      expect(invoke).toHaveBeenCalledOnce()
      expect(pane.reparent).not.toHaveBeenCalled()
      expect(pane.setPresentation).toHaveBeenLastCalledWith('visible')
      expect(deliveryPresentation(initialContainer)).toBe('visible')
      expect(pane.focus).toHaveBeenCalledOnce()
    },
  )

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
    paneState.instances[0]?.emitTitle('Harness title')
    expect(runtimeOptions.onTitle).toHaveBeenCalledExactlyOnceWith('Harness title')
    expect(runtime.snapshot()).toEqual({
      title: 'Harness title',
      status: 'Resume unavailable · session data is missing',
      exited: true,
      recoveryFailure: {
        kind: 'resume-unavailable',
        reason: 'artifact-missing',
      },
    })
    const authorityFreeEvents: TerminalEvent[] = [
      { type: 'working-directory', uri: 'file://untrusted/path' },
      {
        type: 'notification',
        source: 'osc-777',
        title: 'Untrusted request',
        body: 'No attention authority',
      },
      { type: 'progress', state: 'set', progress: 50 },
      {
        type: 'semantic',
        action: 'prompt-start',
        options: '',
        provenance: { id: 1, screen: 'normal', row: 2, column: 0 },
      },
      {
        type: 'palette',
        operation: 3,
        request: { type: 'reset-palette' },
      },
      { type: 'clipboard', operation: 'read', selection: 'c' },
      {
        type: 'clipboard',
        operation: 'write',
        selection: 'c',
        data: btoa('must not escape a non-live pane'),
      },
    ]
    for (const event of authorityFreeEvents) paneState.instances[0]?.emitEvent(event)
    expect(runtimeOptions.onBell).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    paneState.instances[0]?.emitEvent({
      type: 'notification',
      source: 'osc-9',
      title: '',
      body: 'Legacy attention',
    })
    expect(runtimeOptions.onBell).toHaveBeenCalledOnce()
    paneState.instances[0]?.emitEvent({ type: 'bell' })
    expect(runtimeOptions.onBell).toHaveBeenCalledTimes(2)

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
      reattached: false,
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
      instanceId: 'fresh-instance-1',
      pid: 4321,
      resumed: false,
      reattached: false,
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
      instanceId: 'fresh-instance-2',
      pid: 4321,
      resumed: false,
      reattached: false,
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
      reattached: false,
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

  it('distinguishes same-process renderer reattachment from harness resume', async () => {
    invoke.mockResolvedValueOnce({
      outcome: 'started' as const,
      id: 'terminal-1',
      pid: 4321,
      resumed: false,
      reattached: true,
      harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
      identityStatus: 'identified' as const,
      capabilities: {
        sessionIdentity: 'preassigned' as const,
        exactResume: true,
        contextPresentation: 'count-only' as const,
      },
    })
    const runtime = registry.acquire(options())
    runtime.attach(document.createElement('div'))

    await vi.waitFor(() =>
      expect(runtime.snapshot()).toEqual({
        title: 'Claude Code · repo',
        status: 'Reattached · pid 4321',
        exited: false,
      }),
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
      profileGuidance: { reservedArguments: [] },
    }
    const profile = {
      id: runtimeOptions.profileId,
      displayName: 'Claude Code',
    } as unknown as HarnessProfile
    const session: TerminalSession = {
      id: runtimeOptions.sessionId,
      providerId: provider.id,
      profileId: runtimeOptions.profileId,
      launchRevision: runtimeOptions.launchRevision,
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

function startedResponse(): StartPtyResponse {
  return {
    outcome: 'started',
    id: 'terminal-1',
    instanceId: 'terminal-instance-1',
    pid: 4321,
    resumed: false,
    reattached: false,
    identityStatus: 'identified',
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    },
  }
}

function deliveryPresentation(container: object): 'visible' | 'hidden' | undefined {
  return (
    container as {
      readonly __hvirTerminalDelivery?: {
        readonly presentation: 'visible' | 'hidden'
      }
    }
  ).__hvirTerminalDelivery?.presentation
}

function options(): TerminalRuntimeOptions {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('claude-code-default'),
    launchRevision: 1,
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
    theme: terminalThemeForAppearance('dark'),
    typography: { fontFamily: 'ui-monospace, monospace', fontSize: 13 },
    cursorDefaults: { shape: 'block', blink: 'terminal' },
    ligatures: true,
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
