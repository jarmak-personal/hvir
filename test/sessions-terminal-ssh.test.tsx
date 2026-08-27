// @vitest-environment happy-dom

import { EventEmitter } from 'node:events'

import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import {
  asHarnessProfileId,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceRuntimeId,
  hostPath,
  sessionsWorkspaceQualifier,
} from '../src/shared'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'
import { createTestSshHost } from './ssh-host-test-fixture'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

describe('Sessions terminal detail over deterministic SSH', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
    ghosttyState.instances.splice(0)
  })

  it('reuses one remote transport, writes to its exact PTY, and restores before disconnect revocation without reconnecting', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn(() => channel.emit('close')),
      setWindow: vi.fn(),
      write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
        callback?.()
        return true
      }),
    })
    const terminalClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(() => queueMicrotask(() => terminalClient.emit('ready'))),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (error: Error | undefined, stream: typeof channel) => void,
        ) => callback(undefined, channel),
      ),
      end: vi.fn(() => terminalClient.emit('close')),
      destroy: vi.fn(() => terminalClient.emit('close')),
    })
    const primaryClient = Object.assign(new EventEmitter(), {
      end: vi.fn(() => primaryClient.emit('close')),
      destroy: vi.fn(() => primaryClient.emit('close')),
    })
    const clientFactory = vi.fn(() => terminalClient as unknown as Client)
    const host = createTestSshHost({
      config: {
        alias: 'remote-detail',
        hostname: 'remote.test',
        user: 'picard',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory,
    })
    vi.spyOn(host, 'defaultShell').mockResolvedValue('/bin/sh')
    const hostInternals = host as unknown as { state: 'connected'; client: Client }
    hostInternals.state = 'connected'
    hostInternals.client = primaryClient as unknown as Client

    const supervisor = new PtySupervisor()
    const rendererEvents = new Map<string, Set<(event: unknown) => void>>()
    const publish = (channelName: string, event: unknown): void => {
      for (const listener of rendererEvents.get(channelName) ?? []) listener(event)
    }
    let detachStream: (() => void | Promise<void>) | undefined
    const invoke = vi.fn(async (channelName: string, request: Record<string, unknown>) => {
      if (channelName !== 'pty:start') throw new Error(`Unexpected ${channelName}`)
      const info = await supervisor.spawn({
        host,
        provider: plainShellProvider,
        cwd: request.cwd as ReturnType<typeof hostPath>,
        workspaceRoot: request.cwd as ReturnType<typeof hostPath>,
        ownerId: 7,
        ownerGeneration: 2,
        sessionId: String(request.sessionId),
        cols: Number(request.cols),
        rows: Number(request.rows),
      })
      detachStream = supervisor.attach(
        info.id,
        7,
        {
          onData: (data) => publish('pty:data', { id: info.id, data }),
          onExit: (exit) =>
            publish('pty:exit', {
              id: info.id,
              exitCode: exit.exitCode,
              signal: exit.signal,
            }),
        },
        2,
      )
      return {
        outcome: 'started' as const,
        id: info.id,
        instanceId: info.instanceId,
        pid: info.pid,
        resumed: info.resumed,
        reattached: false,
        harnessSessionId: info.harnessSessionId,
        identityStatus: info.identityStatus,
        capabilities: info.capabilities,
      }
    })
    const send = vi.fn((channelName: string, request: Record<string, unknown>) => {
      if (channelName === 'pty:write') {
        supervisor.write(String(request.id), 7, String(request.data), 2)
      } else if (channelName === 'pty:resize') {
        supervisor.resize(
          String(request.id),
          7,
          Number(request.cols),
          Number(request.rows),
          2,
        )
      } else if (channelName === 'pty:kill' && supervisor.get(String(request.id))) {
        supervisor.kill(String(request.id), 7, undefined, 2)
      }
    })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: (channelName: string, listener: (event: unknown) => void) => {
          const listeners = rendererEvents.get(channelName) ?? new Set()
          listeners.add(listener)
          rendererEvents.set(channelName, listeners)
          return () => listeners.delete(listener)
        },
      },
    })

    const registry = new TerminalRuntimeRegistry()
    const remoteRoot = hostPath(host.hostId, '/srv/project')
    let options: TerminalRuntimeOptions = {
      ...ghosttyLifecycleRuntimeOptions(),
      profileId: asHarnessProfileId('plain-shell-default'),
      supportsResume: false,
      harnessSessionId: undefined,
      resumeOnStart: false,
      cwd: remoteRoot,
      workspaceRoot: remoteRoot,
    }
    const runtime = registry.acquire(options)
    const workspace = document.createElement('div')
    const detail = document.createElement('div')
    document.body.append(workspace, detail)
    runtime.attach(workspace)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())

    const instanceId = supervisor.get('terminal-1')!.instanceId
    const surface = workspace.querySelector('.terminal-engine-host')
    const lease = registry.acquireSessionsSurface({
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceQualifier: sessionsWorkspaceQualifier(1, 0, 0),
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-runtime'),
      livePty: {
        handle: asSessionsPtyHandle(instanceId),
        rendererOwnerId: 7,
        rendererGeneration: 2,
      },
      demandGeneration: 1,
      projectionRevision: 1,
      sourceRevision: 1,
    })
    expect(lease?.attach(detail)).toBe(true)
    expect(detail.querySelector('.terminal-engine-host')).toBe(surface)
    expect(ghosttyState.instances).toHaveLength(1)
    expect(clientFactory).toHaveBeenCalledOnce()
    expect(terminalClient.exec).toHaveBeenCalledOnce()
    expect(host.transportDiagnostics()).toHaveLength(2)
    expect(host.transportDiagnostics()).toContainEqual(
      expect.objectContaining({ role: 'terminal', primary: false, channels: 1 }),
    )

    ghosttyState.instances[0]!.emitData('remote detail input')
    expect(channel.write).toHaveBeenCalledWith('remote detail input')
    expect(supervisor.get('terminal-1')?.instanceId).toBe(instanceId)
    expect(clientFactory).toHaveBeenCalledOnce()

    const revoked = vi.fn((reason: string) => {
      // SshHost closes its pinned terminal channel before publishing the final
      // disconnected state, so the exact live PTY revokes first.
      expect(reason).toBe('terminal-unavailable')
      expect(workspace.querySelector('.terminal-engine-host')).toBe(surface)
    })
    lease?.subscribe(revoked)
    const connectionStates: string[] = []
    const stopConnection = host.onConnectionState((connectionState) => {
      connectionStates.push(connectionState)
      options = { ...options, connectionState }
      runtime.update(options)
      runtime.synchronizeLifecycle()
    })
    await host.dispose()

    expect(revoked).toHaveBeenCalledOnce()
    expect(connectionStates).toEqual(['connected', 'disconnected'])
    expect(detail.querySelector('.terminal-engine-host')).toBeNull()
    expect(invoke).toHaveBeenCalledOnce()
    expect(clientFactory).toHaveBeenCalledOnce()
    expect(supervisor.get('terminal-1')).toBeUndefined()
    expect(ghosttyState.instances).toHaveLength(1)
    expect(ghosttyState.instances[0]!.disposed).toBe(true)

    await stopConnection()
    await detachStream?.()
    registry.dispose()
    supervisor.disposeAll()
    vi.unstubAllGlobals()
  })
})
