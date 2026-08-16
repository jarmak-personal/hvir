// @vitest-environment happy-dom

import { act, useCallback, useReducer, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import type { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import {
  initialTerminalWorkspaceModel,
  terminalWorkspaceReducer,
  type TerminalWorkspaceAction,
} from '../src/renderer/src/terminal/terminal-workspace-model'
import { useTerminalSessionCommands } from '../src/renderer/src/terminal/use-terminal-session-commands'
import {
  asHarnessProfileId,
  localPath,
  type HarnessProfile,
  type HarnessProviderDescriptor,
} from '../src/shared'

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  invoke = vi.fn(() => Promise.resolve())
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
})

function CommandsHarness() {
  const profile = defaultProfile()
  const chosen = customProfile()
  const provider = shellProvider(profile)
  const [model, dispatch] = useReducer(
    terminalWorkspaceReducer,
    initialTerminalWorkspaceModel,
  )
  const modelRef = useRef(model)
  modelRef.current = model
  const send = useCallback((action: TerminalWorkspaceAction) => {
    modelRef.current = terminalWorkspaceReducer(modelRef.current, action)
    dispatch(action)
  }, [])
  const runtimes = useRef({
    disposeSession: vi.fn(() => undefined),
  } as unknown as TerminalRuntimeRegistry)
  const commands = useTerminalSessionCommands({
    available: true,
    workspaceRoot: localPath('/repo'),
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
  })
  return (
    <>
      <span data-testid="profiles">
        {model.sessions.map(({ profileId }) => profileId).join(',')}
      </span>
      <span data-testid="panes">{model.sessions.map(({ pane }) => pane).join(',')}</span>
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
        data-testid="close-active"
        onClick={() => {
          if (model.activeId) commands.close(model.activeId)
        }}
      />
    </>
  )
}

function renderHarness(): void {
  act(() => root.render(<CommandsHarness />))
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
