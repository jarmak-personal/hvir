// @vitest-environment happy-dom

import { act, useCallback, useReducer, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import type { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import {
  initialTerminalWorkspaceModel,
  terminalWorkspaceReducer,
  type TerminalSession,
  type TerminalWorkspaceAction,
  type TerminalWorkspaceModel,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import { useTerminalSessionCommands } from '../src/renderer/src/terminal/use-terminal-session-commands'
import {
  asHostId,
  asHarnessProfileId,
  asHarnessProviderId,
  hostPath,
  localPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
  type HostPath,
} from '../src/shared'

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let reportError: ReturnType<typeof vi.fn<(message: string) => void>>
let disposeSession: ReturnType<typeof vi.fn<(id: string) => string | undefined>>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  invoke = vi.fn(() => Promise.resolve())
  reportError = vi.fn<(message: string) => void>()
  disposeSession = vi.fn<(id: string) => string | undefined>(() => undefined)
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke, on: vi.fn(), send: vi.fn() },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('terminal session commands', () => {
  it('admits one Bare Shell for a repeated empty-state launch gesture', () => {
    renderHarness()

    act(() => button('start-default').click())

    expect(text('profiles')).toBe(defaultProfile().id)
    expect(text('panes')).toBe('primary')
  })

  it('starts the chosen profile without first adding Bare Shell', () => {
    renderHarness()

    act(() => button('start-custom').click())

    expect(text('profiles')).toBe(customProfile().id)
    expect(host.querySelectorAll('[data-session]')).toHaveLength(1)
  })

  it('returns to an empty model after the last terminal closes', () => {
    renderHarness()
    act(() => button('start-default').click())

    act(() => button('close-active').click())

    expect(text('profiles')).toBe('')
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]?.[0]).toBe('terminal:forget')
  })

  it('turns an empty split request into one primary Bare Shell', () => {
    renderHarness()

    act(() => button('split').click())

    expect(text('profiles')).toBe(defaultProfile().id)
    expect(text('panes')).toBe('primary')
  })

  it.each([
    ['local', localPath('/repo')],
    ['deterministic SSH', hostPath(asHostId('ssh-test'), '/repo')],
  ])(
    'stages one adjacent unfocused sibling with inherited %s launch authority',
    (_name, workspaceRoot) => {
      renderHarness({ fork: true, workspaceRoot })

      act(() => button('fork-source-twice').click())

      expect(text('ids')?.split(',')).toHaveLength(2)
      expect(text('active')).toBe('source')
      expect(text('fork-source')).toBe('source')
      expect(text('fork-parent')).toBe('019ab123-4567-7890-abcd-ef0123456789')
      expect(text('fork-host')).toBe(workspaceRoot.hostId)
      expect(text('fork-cwd')).toBe(workspaceRoot.path)
      expect(text('source-pending')).toBe('true')

      act(() => button('identify-fork').click())

      expect(text('source-pending')).toBe('false')
      expect(text('fork-source')).toBe('')
      expect(text('fork-identity')).toBe('129ab123-4567-7890-abcd-ef0123456789')
      expect(text('active')).toBe('source')
    },
  )

  it.each([
    ['local', localPath('/repo')],
    ['deterministic SSH', hostPath(asHostId('ssh-test'), '/repo')],
  ])('cleans up a refused %s sibling and reports the failure', (_name, workspaceRoot) => {
    renderHarness({ fork: true, workspaceRoot })
    act(() => button('fork-source-twice').click())
    const forkId = text('fork-id')
    if (!forkId) throw new Error('fork fixture missing')

    act(() => button('fail-fork').click())

    expect(text('ids')).toBe('source')
    expect(text('source-pending')).toBe('false')
    expect(disposeSession).toHaveBeenCalledExactlyOnceWith(forkId)
    expect(reportError).toHaveBeenCalledWith(
      'Conversation fork failed: admission refused',
    )
    expect(invoke).toHaveBeenCalledWith('terminal:forget', {
      root: workspaceRoot,
      id: forkId,
    })
  })

  it.each([
    ['local', localPath('/repo')],
    ['deterministic SSH', hostPath(asHostId('ssh-test'), '/repo')],
  ])(
    'cancels a pending %s sibling when its source exits and rejects a late identity',
    (_name, workspaceRoot) => {
      renderHarness({ fork: true, workspaceRoot })
      act(() => button('fork-source-twice').click())
      const forkId = text('fork-id')
      if (!forkId) throw new Error('fork fixture missing')

      act(() => button('exit-source-and-identify-late').click())

      expect(text('ids')).toBe('source')
      expect(text('source-pending')).toBe('false')
      expect(disposeSession).toHaveBeenCalledExactlyOnceWith(forkId)
      expect(reportError).toHaveBeenCalledWith(
        expect.stringContaining('source terminal exited'),
      )
    },
  )

  it('cancels the pending sibling before closing its source', () => {
    renderHarness({ fork: true })
    act(() => button('fork-source-twice').click())
    const forkId = text('fork-id')
    if (!forkId) throw new Error('fork fixture missing')

    act(() => button('close-active').click())

    expect(text('ids')).toBe('')
    expect(disposeSession).toHaveBeenCalledWith(forkId)
    expect(disposeSession).toHaveBeenCalledWith('source')
  })
})

function CommandsHarness({
  fork = false,
  workspaceRoot = localPath('/repo'),
}: {
  readonly fork?: boolean
  readonly workspaceRoot?: HostPath
}) {
  const profile = fork ? forkProfile() : defaultProfile()
  const chosen = customProfile()
  const provider = fork ? forkProvider() : shellProvider(profile)
  const initialModel: TerminalWorkspaceModel = fork
    ? {
        ...initialTerminalWorkspaceModel,
        sessions: [forkSource(profile, workspaceRoot)],
        activeId: 'source',
        activeByPane: { primary: 'source', secondary: undefined },
      }
    : initialTerminalWorkspaceModel
  const [model, dispatch] = useReducer(terminalWorkspaceReducer, initialModel)
  const modelRef = useRef(model)
  modelRef.current = model
  const send = useCallback((action: TerminalWorkspaceAction) => {
    modelRef.current = terminalWorkspaceReducer(modelRef.current, action)
    dispatch(action)
  }, [])
  const runtimes = useRef({
    disposeSession,
    isSessionLive: vi.fn(() => true),
  } as unknown as TerminalRuntimeRegistry)
  const commands = useTerminalSessionCommands({
    available: true,
    workspaceRoot,
    profiles: [profile, chosen],
    providers: [provider],
    probes: [],
    defaultProfile: profile,
    defaultProvider: provider,
    modelRef,
    send,
    closeLaunchMenu: vi.fn(),
    focusAttention: vi.fn(),
    forgetAttention: vi.fn(),
    runtimes: runtimes.current,
    onError: reportError,
  })
  const pendingFork = model.sessions.find((session) => session.forkRequest)
  const source = model.sessions.find((session) => session.id === 'source')
  return (
    <>
      <span data-testid="profiles">
        {model.sessions.map(({ profileId }) => profileId).join(',')}
      </span>
      <span data-testid="panes">{model.sessions.map(({ pane }) => pane).join(',')}</span>
      <span data-testid="ids">{model.sessions.map(({ id }) => id).join(',')}</span>
      <span data-testid="active">{model.activeId}</span>
      <span data-testid="source-pending">{String(source?.forkPending === true)}</span>
      <span data-testid="fork-id">{pendingFork?.id}</span>
      <span data-testid="fork-source">{pendingFork?.forkRequest?.sourceSessionId}</span>
      <span data-testid="fork-parent">
        {pendingFork?.forkRequest?.parentHarnessSessionId}
      </span>
      <span data-testid="fork-host">{pendingFork?.cwd.hostId}</span>
      <span data-testid="fork-cwd">{pendingFork?.cwd.path}</span>
      <span data-testid="fork-identity">
        {model.sessions.find((session) => session.id !== 'source')?.harnessSessionId}
      </span>
      {model.sessions.map(({ id }) => (
        <span key={id} data-session={id} />
      ))}
      <button
        type="button"
        data-testid="start-default"
        onClick={() => {
          commands.startDefault()
          commands.startDefault()
        }}
      />
      <button
        type="button"
        data-testid="start-custom"
        onClick={() => commands.add(chosen.id)}
      />
      <button type="button" data-testid="split" onClick={commands.split} />
      <button
        type="button"
        data-testid="fork-source-twice"
        onClick={() => {
          commands.fork('source')
          commands.fork('source')
        }}
      />
      <button
        type="button"
        data-testid="identify-fork"
        onClick={() => {
          if (pendingFork) {
            commands.acceptForkIdentity(
              pendingFork.id,
              '129ab123-4567-7890-abcd-ef0123456789',
              'identified',
            )
          }
        }}
      />
      <button
        type="button"
        data-testid="fail-fork"
        onClick={() => {
          if (pendingFork) commands.failForkStart(pendingFork.id, 'admission refused')
        }}
      />
      <button
        type="button"
        data-testid="exit-source-and-identify-late"
        onClick={() => {
          if (!pendingFork) return
          commands.handleExit('source', 1)
          commands.acceptForkIdentity(
            pendingFork.id,
            '129ab123-4567-7890-abcd-ef0123456789',
            'identified',
          )
        }}
      />
      <button
        type="button"
        data-testid="close-active"
        onClick={() => {
          if (model.activeId) commands.close(model.activeId)
        }}
      />
    </>
  )
}

function renderHarness(options: Parameters<typeof CommandsHarness>[0] = {}): void {
  act(() => root.render(<CommandsHarness {...options} />))
}

function button(testId: string): HTMLButtonElement {
  const value = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  if (!value) throw new Error(`Missing button ${testId}`)
  return value
}

function text(testId: string): string | null {
  return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
}

function defaultProfile(): HarnessProfile {
  const profile = builtInProfiles()[0]
  if (!profile) throw new Error('Bare Shell profile unavailable')
  return profile
}

function customProfile(): HarnessProfile {
  return {
    ...defaultProfile(),
    id: asHarnessProfileId('chosen-harness'),
    builtIn: false,
    displayName: 'Chosen harness',
    order: 1,
  }
}

function shellProvider(profile: HarnessProfile): HarnessProviderDescriptor {
  return {
    id: profile.providerId,
    displayName: 'Shell',
    default: true,
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    terminalInput: {
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
    },
    profileGuidance: {
      reservedArguments: [],
    },
  }
}

function forkProfile(): HarnessProfile {
  return {
    ...defaultProfile(),
    id: asHarnessProfileId('codex-default'),
    providerId: asHarnessProviderId('codex'),
    builtIn: false,
    displayName: 'Codex',
    order: 1,
  }
}

function forkProvider(): HarnessProviderDescriptor {
  return {
    ...shellProvider(forkProfile()),
    id: asHarnessProviderId('codex'),
    displayName: 'Codex',
    exactForkLaunch: true,
  }
}

function forkSource(profile: HarnessProfile, cwd: HostPath): TerminalSession {
  return {
    id: 'source',
    providerId: profile.providerId,
    profileId: profile.id,
    launchRevision: profile.launchRevision,
    capabilities: {
      sessionIdentity: 'discovered' as const,
      exactResume: true,
      exactFork: true as const,
      contextPresentation: 'pressure' as const,
    },
    fallbackTitle: 'Codex · repo',
    title: 'Source',
    status: 'Ready',
    harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
    identityStatus: 'identified' as const,
    resumeOnStart: false,
    pane: 'primary' as const,
    cwd,
  }
}
