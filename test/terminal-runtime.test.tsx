import { describe, expect, it, vi } from 'vitest'

import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeOptions,
} from '../src/renderer/src/terminal/terminal-runtime'
import {
  asHarnessProfileId,
  localPath,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'

function options(
  workspaceRoot: HostPath,
  connectionState: HostConnectionState = 'connected',
): TerminalRuntimeOptions {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    riskAcknowledged: false,
    supportsResume: true,
    fallbackTitle: 'Codex · repo',
    harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
    resumeOnStart: false,
    position: 0,
    active: true,
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: false,
    composerSubmitMode: 'enter',
    cwd: localPath('/repo'),
    workspaceRoot,
    connectionState,
    onTitle: vi.fn(),
    onStatus: vi.fn(),
    onTelemetry: vi.fn(),
    onIdentity: vi.fn(),
    onStarted: vi.fn(),
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}

describe('TerminalRuntimeRegistry', () => {
  it('retains one live runtime while its workspace presentation changes', () => {
    const registry = new TerminalRuntimeRegistry()
    const source = options(localPath('/repo'))
    const first = registry.acquire(source)
    const target = options(localPath('/repo-feature'))
    const moved = registry.acquire(target)

    expect(moved).toBe(first)
    expect(moved.workspaceRoot).toEqual(target.workspaceRoot)
    expect(() => moved.update({ ...target, cwd: localPath('/repo-feature') })).toThrow(
      'launch context cannot change',
    )
    registry.dispose()
  })

  it('publishes an initial disconnected host state before a pane mounts', () => {
    const runtimeOptions = options(localPath('/repo'), 'disconnected')
    const runtime = new TerminalRuntimeRegistry().acquire(runtimeOptions)

    runtime.synchronizeConnection()

    expect(runtime.snapshot()).toMatchObject({
      title: 'Codex · repo',
      status: 'disconnected',
      exited: false,
    })
    expect(runtimeOptions.onStatus).toHaveBeenCalledWith('disconnected')
    expect(runtimeOptions.onTelemetry).toHaveBeenCalledWith(undefined)
  })
})
