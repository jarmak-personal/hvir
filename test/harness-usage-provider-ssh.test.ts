import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { observeClaudeUsage } from '../src/main/harness/claude-context-telemetry'
import { claudeProjectDirectoryName } from '../src/main/harness/claude-session-artifact'
import { observeCodexUsage } from '../src/main/harness/codex-context-telemetry'
import type {
  Disposer,
  ExecOptions,
  ExecStreamHandle,
  ProjectHost,
} from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import {
  hostPath,
  localPath,
  type HarnessTelemetry,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

const CODEX_SESSION_ID = '019ab123-4567-7890-abcd-ef0123456789'
const CLAUDE_SESSION_ID = '092bd463-4567-4890-abcd-ef0123456789'
const RECOVERY_SUBSCRIPTION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

describe('provider usage over an SSH-qualified host', () => {
  it('restores exact Codex counters after disconnect and explicit reconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-remote-usage-'))
    const canonicalDirectory = await realpath(directory)
    const rollout = join(directory, `rollout-session-${CODEX_SESSION_ID}.jsonl`)
    await writeFile(
      rollout,
      `${codexSessionMeta(CODEX_SESSION_ID, canonicalDirectory)}\n${codexUsage()}\n`,
    )
    const fixture = await remoteHarnessHost()
    const emitted: HarnessTelemetry[] = []
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let stop: Disposer | undefined
    try {
      stop = await observeCodexUsage(fixture.host, {
        subscriptionId: CODEX_SESSION_ID,
        sessionId: CODEX_SESSION_ID,
        cwd: fixture.path(directory),
        sessionData: { rolloutPath: fixture.path(rollout) },
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: new AbortController().signal,
        emit: (telemetry) => {
          if (telemetry) emitted.push(telemetry)
        },
      })
      await vi.waitFor(() => expect(exactUsageTotal(emitted.at(-1))).toBe(10), {
        timeout: 4_000,
      })

      fixture.disconnect()
      await vi.waitFor(() => expect(emitted.at(-1)?.facets.usage.status).toBe('stale'))
      expect(warning).toHaveBeenCalledWith(
        '[harness:codex] telemetry hub unavailable',
        expect.any(Error),
      )
      await stop()
      stop = undefined
      fixture.reconnect()

      const recovered: HarnessTelemetry[] = []
      stop = await observeCodexUsage(fixture.host, {
        subscriptionId: RECOVERY_SUBSCRIPTION_ID,
        sessionId: CODEX_SESSION_ID,
        cwd: fixture.path(directory),
        sessionData: { rolloutPath: fixture.path(rollout) },
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: new AbortController().signal,
        emit: (telemetry) => {
          if (telemetry) recovered.push(telemetry)
        },
      })
      await vi.waitFor(() => expect(exactUsageTotal(recovered.at(-1))).toBe(10))
      expect(JSON.stringify([...emitted, ...recovered])).not.toContain(CODEX_SESSION_ID)
    } finally {
      await stop?.()
      await fixture.dispose()
      warning.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores exact Claude counters after disconnect and explicit reconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-claude-remote-usage-'))
    const cwd = join(directory, 'workspace')
    await mkdir(cwd)
    const projectDirectory = join(
      directory,
      'projects',
      claudeProjectDirectoryName(await realpath(cwd)),
    )
    await mkdir(projectDirectory, { recursive: true })
    await writeFile(
      join(projectDirectory, `${CLAUDE_SESSION_ID}.jsonl`),
      `${claudeUsage(CLAUDE_SESSION_ID)}\n`,
    )
    const fixture = await remoteHarnessHost()
    const emitted: HarnessTelemetry[] = []
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let stop: Disposer | undefined
    const context = {
      sessionId: CLAUDE_SESSION_ID,
      cwd: fixture.path(cwd),
      artifact: {
        identity: 'test',
        environment: { CLAUDE_CONFIG_DIR: directory },
        unsetEnvironment: [],
      },
    } as const
    try {
      stop = await observeClaudeUsage(fixture.host, {
        ...context,
        subscriptionId: CLAUDE_SESSION_ID,
        signal: new AbortController().signal,
        emit: (telemetry) => {
          if (telemetry) emitted.push(telemetry)
        },
      })
      await vi.waitFor(() => expect(exactUsageTotal(emitted.at(-1))).toBe(10), {
        timeout: 4_000,
      })

      fixture.disconnect()
      await vi.waitFor(() => expect(emitted.at(-1)?.facets.usage.status).toBe('stale'))
      expect(warning).toHaveBeenCalledWith(
        '[harness:claude-code] telemetry hub unavailable',
        expect.any(Error),
      )
      await stop()
      stop = undefined
      fixture.reconnect()

      const recovered: HarnessTelemetry[] = []
      stop = await observeClaudeUsage(fixture.host, {
        ...context,
        subscriptionId: RECOVERY_SUBSCRIPTION_ID,
        signal: new AbortController().signal,
        emit: (telemetry) => {
          if (telemetry) recovered.push(telemetry)
        },
      })
      await vi.waitFor(() => expect(exactUsageTotal(recovered.at(-1))).toBe(10))
      expect(JSON.stringify([...emitted, ...recovered])).not.toContain(CLAUDE_SESSION_ID)
    } finally {
      await stop?.()
      await fixture.dispose()
      warning.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function remoteHarnessHost(): Promise<{
  readonly host: ProjectHost
  path(path: string): HostPath
  disconnect(): void
  reconnect(): void
  dispose(): Promise<void>
}> {
  const local = new LocalHost()
  await local.connect()
  const host = createTestSshHost({
    config: {
      alias: 'usage-provider-test',
      hostname: 'remote.test',
      user: 'picard',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  const remoteId = host.hostId
  let state: HostConnectionState = 'connected'
  const streams = new Set<ReturnType<typeof remoteStream>>()
  const requireConnected = (): void => {
    if (state !== 'connected') throw new Error('SSH test host is disconnected')
  }
  const translatePath = (path: HostPath): HostPath => {
    if (path.hostId !== remoteId) throw new Error('Unexpected host-qualified path')
    return localPath(path.path)
  }
  const translateOptions = (options: ExecOptions | undefined): ExecOptions => ({
    ...options,
    ...(options?.cwd ? { cwd: translatePath(options.cwd) } : {}),
  })
  const connectionState = vi
    .spyOn(host, 'connectionState', 'get')
    .mockImplementation(() => state)
  const exec = vi
    .spyOn(host, 'exec')
    .mockImplementation(
      async (command: string, args: readonly string[], options?: ExecOptions) => {
        requireConnected()
        return local.exec(command, args, translateOptions(options))
      },
    )
  const execStream = vi
    .spyOn(host, 'execStream')
    .mockImplementation(
      (
        command: string,
        args: readonly string[],
        options?: ExecOptions,
      ): ExecStreamHandle => {
        requireConnected()
        const stream = remoteStream(
          local.execStream(command, args, translateOptions(options)),
        )
        streams.add(stream)
        stream.onClosed(() => streams.delete(stream))
        return stream.handle
      },
    )
  const realpath = vi.spyOn(host, 'realpath').mockImplementation(async (path) => {
    requireConnected()
    const resolved = await local.realpath(translatePath(path))
    return hostPath(remoteId, resolved.path)
  })
  const stat = vi.spyOn(host, 'stat').mockImplementation(async (path) => {
    requireConnected()
    return local.stat(translatePath(path))
  })
  const readFileChunks = vi
    .spyOn(host.fileTransfer, 'readFileChunks')
    .mockImplementation((path, options) => {
      requireConnected()
      return local.fileTransfer.readFileChunks(translatePath(path), options)
    })
  return {
    host,
    path: (path) => hostPath(remoteId, path),
    disconnect: () => {
      state = 'disconnected'
      for (const stream of [...streams]) stream.disconnect()
    },
    reconnect: () => {
      state = 'connected'
    },
    dispose: async () => {
      state = 'disconnected'
      for (const stream of [...streams]) stream.disconnect()
      readFileChunks.mockRestore()
      stat.mockRestore()
      realpath.mockRestore()
      execStream.mockRestore()
      exec.mockRestore()
      connectionState.mockRestore()
      await host.dispose()
      await local.dispose()
    },
  }
}

function remoteStream(source: ExecStreamHandle): {
  readonly handle: ExecStreamHandle
  disconnect(): void
  onClosed(callback: () => void): void
} {
  const errorListeners = new Set<(error: Error) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    source.dispose()
    for (const callback of closeListeners) callback()
  }
  const handle: ExecStreamHandle = {
    onStdout: (callback) => source.onStdout(callback),
    onStderr: (callback) => source.onStderr(callback),
    onError: (callback) => {
      errorListeners.add(callback)
      const dispose = source.onError(callback)
      return () => {
        errorListeners.delete(callback)
        void dispose()
      }
    },
    onExit: (callback) => source.onExit(callback),
    write: (value) => source.write(value),
    end: (value) => source.end(value),
    kill: (signal) => source.kill(signal),
    dispose: close,
  }
  return {
    handle,
    disconnect: () => {
      if (closed) return
      for (const callback of errorListeners) callback(new Error('SSH disconnected'))
      close()
    },
    onClosed: (callback) => closeListeners.add(callback),
  }
}

function codexSessionMeta(sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd, originator: 'codex-tui' },
  })
}

function codexUsage(): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 8,
          cached_input_tokens: 3,
          cache_write_input_tokens: 1,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
      },
    },
  })
}

function claudeUsage(sessionId: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId,
    requestId: 'request-1',
    effort: 'high',
    message: {
      id: 'message-1',
      role: 'assistant',
      model: 'claude-test',
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    },
  })
}

function exactUsageTotal(telemetry: HarnessTelemetry | undefined): number | undefined {
  const usage = telemetry?.facets.usage
  return usage?.status === 'exact' ? usage.value.normalizedTokenTotal : undefined
}
