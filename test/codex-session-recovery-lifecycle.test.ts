import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'

import { createCodexSessionDiscovery } from '../src/main/harness/codex-session-discovery'
import {
  codexProvider,
  type HarnessArtifactContext,
  type HarnessProvider,
} from '../src/main/harness/harness-provider'
import { LocalHost } from '../src/main/project-host/local-host'
import type {
  PtyExit,
  PtyProcess,
  SpawnPtyOptions,
} from '../src/main/project-host'
import { PtySupervisor, type ManagedPty } from '../src/main/pty/pty-supervisor'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import { asHarnessProfileId, hostPath, localPath } from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

const TERMINAL_ID = 'codex-lifecycle-terminal'
const SESSION_ID = '019ab123-4567-7890-abcd-ef0123456789'
const PROFILE_ID = asHarnessProfileId('codex-default')

class LifecyclePty implements PtyProcess {
  readonly pid = 305
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(exit: PtyExit) => void>()

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  write(): void {
    return
  }
  writeConfirmed(): Promise<void> {
    return Promise.resolve()
  }
  resize(): void {
    return
  }
  kill(): void {
    return
  }
}

class LifecycleLocalHost extends LocalHost {
  readonly pty = new LifecyclePty()
  readonly ptySpawns: SpawnPtyOptions[] = []

  override spawnPty(options: SpawnPtyOptions): Promise<PtyProcess> {
    this.ptySpawns.push(options)
    return Promise.resolve(this.pty)
  }
}

function bufferedExecChannel(stdout: string) {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn(() => channel.emit('close')),
    end: vi.fn(() =>
      queueMicrotask(() => {
        if (stdout) channel.emit('data', Buffer.from(stdout))
        channel.emit('exit', 0)
        channel.emit('close')
      }),
    ),
  })
  return channel
}

describe('Codex session recovery lifecycle', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
  })

  it('persists a lazily materialized rollout and reloads its exact resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-codex-lifecycle-'))
    cleanups.push(root)
    const workspace = join(root, 'project')
    const codexHome = join(root, 'codex-home')
    const sessionsDirectory = join(codexHome, 'sessions', '2026', '07', '28')
    await mkdir(workspace, { recursive: true })
    await mkdir(sessionsDirectory, { recursive: true })

    const host = new LifecycleLocalHost()
    const registryFile = localPath(join(root, 'terminal-sessions.json'))
    const cwd = localPath(workspace)
    const registry = await TerminalSessionRegistry.load(host, registryFile)
    const provider: HarnessProvider = {
      ...codexProvider,
      sessionDiscovery: createCodexSessionDiscovery({
        timeoutMs: 2_000,
        initialPollMs: 5,
        maxPollMs: 20,
        settleMs: 5,
      }),
      telemetry: undefined,
    }
    const artifact: HarnessArtifactContext = {
      identity: 'a'.repeat(24),
      environment: { CODEX_HOME: codexHome },
      unsetEnvironment: [],
    }
    const supervisor = new PtySupervisor({
      registerSessionIdentity: (terminalId, harnessSessionId) =>
        registry.recordIdentity(terminalId, harnessSessionId),
      cancelSessionIdentityRegistration: (terminalId) =>
        registry.cancelIdentityRegistration(terminalId),
    })
    const identities: ManagedPty[] = []
    supervisor.onSessionIdentity((info) => identities.push(info))

    const fresh = await supervisor.spawn({
      host,
      provider,
      launchSpec: { file: 'codex-fixture', args: ['launch'] },
      artifact,
      cwd,
      ownerId: 305,
      sessionId: TERMINAL_ID,
    })
    expect(fresh).toMatchObject({
      identityStatus: 'discovering',
      harnessSessionId: undefined,
    })
    expect(host.ptySpawns).toHaveLength(1)
    await registry.recordSpawn({
      id: fresh.id,
      providerId: provider.manifest.id,
      profileId: PROFILE_ID,
      launchRevision: 1,
      artifactIdentity: artifact.identity,
      workspaceRoot: cwd,
      cwd,
      title: 'Codex · lifecycle',
      position: 0,
      active: true,
    })

    const rollout = localPath(
      join(sessionsDirectory, `rollout-2026-07-28T17-00-00-${SESSION_ID}.jsonl`),
    )
    await host.writeFile(
      rollout,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          timestamp: new Date().toISOString(),
          cwd: cwd.path,
          originator: 'codex-tui',
        },
      })}\n`,
    )

    await vi.waitFor(
      () =>
        expect(identities.at(-1)).toMatchObject({
          id: TERMINAL_ID,
          harnessSessionId: SESSION_ID,
          identityStatus: 'identified',
        }),
      { timeout: 2_000 },
    )
    await supervisor.disposeAllAndWait(1)
    await registry.flush()

    const reloaded = await TerminalSessionRegistry.load(host, registryFile)
    const retained = reloaded.get(TERMINAL_ID)
    expect(retained).toMatchObject({
      harnessSessionId: SESSION_ID,
      hostId: cwd.hostId,
      workspaceRoot: cwd,
      cwd,
    })
    const resume = provider.resume({
      sessionId: retained!.harnessSessionId!,
      cwd,
      defaultShell: '/bin/sh',
      composerSubmitMode: 'enter',
    })
    expect(resume.file).toBe('codex')
    expect(resume.args.slice(-2)).toEqual(['resume', SESSION_ID])
    await host.dispose()
  })

  it('keeps discovery and registry identity host-qualified through SshHost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-codex-ssh-lifecycle-'))
    cleanups.push(root)
    const metadataHost = new LocalHost()
    const registry = await TerminalSessionRegistry.load(
      metadataHost,
      localPath(join(root, 'terminal-sessions.json')),
    )
    const channel = Object.assign(new EventEmitter(), {
      close: vi.fn(() => channel.emit('close')),
      setWindow: vi.fn(),
      write: vi.fn(),
    })
    const terminalClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(() => queueMicrotask(() => terminalClient.emit('ready'))),
      exec: vi.fn(
        (
          _command: string,
          _options: unknown,
          callback: (error: Error | undefined, value: unknown) => void,
        ) => callback(undefined, channel),
      ),
      end: vi.fn(() => terminalClient.emit('close')),
      destroy: vi.fn(() => terminalClient.emit('close')),
    })
    const remoteTimestampSeconds = Math.floor(Date.now() / 1_000)
    const remoteRollout =
      `/srv/codex-home/sessions/2026/07/28/` +
      `rollout-2026-07-28T17-00-00-${SESSION_ID}.jsonl`
    const remoteMetadata = `${JSON.stringify({
      timestamp: new Date(remoteTimestampSeconds * 1_000).toISOString(),
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        timestamp: new Date(remoteTimestampSeconds * 1_000).toISOString(),
        cwd: '/srv/project',
        originator: 'codex-tui',
      },
    })}\n`
    let scanCount = 0
    const remoteCommands: string[] = []
    const primaryClient = Object.assign(new EventEmitter(), {
      exec: vi.fn(
        (
          command: string,
          callback: (error: Error | undefined, value: unknown) => void,
        ) => {
          remoteCommands.push(command)
          if (command.includes("'head'")) {
            callback(undefined, bufferedExecChannel(remoteMetadata))
            return
          }
          if (command.includes("'sh'")) {
            scanCount += 1
            const paths = scanCount === 1 ? '' : `${remoteRollout}\0`
            callback(
              undefined,
              bufferedExecChannel(`hvir-clock:${remoteTimestampSeconds}\0${paths}`),
            )
            return
          }
          callback(new Error(`Unexpected remote command: ${command}`), undefined)
        },
      ),
      end: vi.fn(() => primaryClient.emit('close')),
      destroy: vi.fn(() => primaryClient.emit('close')),
    })
    const sshHost = createTestSshHost({
      config: {
        alias: 'codex-recovery',
        hostname: 'remote.test',
        user: 'agent',
        port: 22,
        identityFiles: [],
      },
      prompter: { prompt: () => Promise.resolve(undefined) },
      clientFactory: () => terminalClient as unknown as Client,
    })
    vi.spyOn(sshHost, 'defaultShell').mockResolvedValue('/bin/sh')
    const internals = sshHost as unknown as { state: 'connected'; client: Client }
    internals.state = 'connected'
    internals.client = primaryClient as unknown as Client
    const cwd = hostPath(sshHost.hostId, '/srv/project')
    const artifact: HarnessArtifactContext = {
      identity: 'b'.repeat(24),
      environment: { CODEX_HOME: '/srv/codex-home' },
      unsetEnvironment: [],
    }
    const provider: HarnessProvider = {
      ...codexProvider,
      sessionDiscovery: createCodexSessionDiscovery({
        timeoutMs: 500,
        initialPollMs: 1,
        maxPollMs: 5,
        settleMs: 0,
      }),
      telemetry: undefined,
    }
    const supervisor = new PtySupervisor({
      registerSessionIdentity: (terminalId, harnessSessionId) =>
        registry.recordIdentity(terminalId, harnessSessionId),
      cancelSessionIdentityRegistration: (terminalId) =>
        registry.cancelIdentityRegistration(terminalId),
    })
    const identities: ManagedPty[] = []
    supervisor.onSessionIdentity((info) => identities.push(info))

    const fresh = await supervisor.spawn({
      host: sshHost,
      provider,
      launchSpec: { file: 'codex', args: ['launch'] },
      artifact,
      cwd,
      workspaceRoot: cwd,
      ownerId: 305,
      sessionId: 'codex-ssh-terminal',
    })
    await registry.recordSpawn({
      id: fresh.id,
      providerId: provider.manifest.id,
      profileId: PROFILE_ID,
      launchRevision: 1,
      artifactIdentity: artifact.identity,
      workspaceRoot: cwd,
      cwd,
      title: 'Codex · remote',
      position: 0,
      active: true,
    })

    await vi.waitFor(() =>
      expect(identities.at(-1)).toMatchObject({
        id: fresh.id,
        hostId: sshHost.hostId,
        cwd,
        workspaceRoot: cwd,
        harnessSessionId: SESSION_ID,
        identityStatus: 'identified',
      }),
    )
    expect(remoteCommands.filter((command) => command.includes("'sh'"))).toHaveLength(2)
    expect(
      remoteCommands.some((command) =>
        command.includes("CODEX_HOME='/srv/codex-home'"),
      ),
    ).toBe(true)
    expect(
      remoteCommands.some(
        (command) => command.includes("'head'") && command.includes(remoteRollout),
      ),
    ).toBe(true)
    expect(registry.get(fresh.id)).toMatchObject({
      hostId: sshHost.hostId,
      workspaceRoot: cwd,
      cwd,
      harnessSessionId: SESSION_ID,
    })
    await supervisor.disposeAllAndWait(10)
    await registry.flush()
    await sshHost.dispose()
    await metadataHost.dispose()
  })
})
