import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { codexAssistantOutput } from '../src/main/harness/codex-assistant-output'
import type { Disposer, ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import {
  LOCAL_HOST_ID,
  asHostId,
  hostPath,
  type AssistantOutputEvent,
  type HostConnectionState,
  type HostId,
} from '../src/shared'

class TestExecStream implements ExecStreamHandle {
  readonly stdout = new Set<(chunk: string) => void>()
  readonly stderr = new Set<(chunk: string) => void>()
  readonly errors = new Set<(error: Error) => void>()
  readonly exits = new Set<
    (result: { code: number | null; signal: string | null }) => void
  >()
  readonly writes: string[] = []
  readonly kill = vi.fn()
  readonly dispose = vi.fn()

  onStdout(cb: (chunk: string) => void): Disposer {
    this.stdout.add(cb)
    return () => {
      this.stdout.delete(cb)
    }
  }
  onStderr(cb: (chunk: string) => void): Disposer {
    this.stderr.add(cb)
    return () => {
      this.stderr.delete(cb)
    }
  }
  onError(cb: (error: Error) => void): Disposer {
    this.errors.add(cb)
    return () => {
      this.errors.delete(cb)
    }
  }
  onExit(cb: (result: { code: number | null; signal: string | null }) => void): Disposer {
    this.exits.add(cb)
    return () => {
      this.exits.delete(cb)
    }
  }
  write(data: string): Promise<void> {
    this.writes.push(data)
    return Promise.resolve()
  }
  end(data?: string): Promise<void> {
    if (data) this.writes.push(data)
    return Promise.resolve()
  }
  emitStdout(chunk: string): void {
    for (const cb of this.stdout) cb(chunk)
  }
  emitExit(): void {
    for (const cb of [...this.exits]) cb({ code: 1, signal: null })
  }
}

function hostFixture(hostId: HostId) {
  const streams: TestExecStream[] = []
  const connectionListeners = new Set<(state: HostConnectionState) => void>()
  const socketDirectory =
    hostId === LOCAL_HOST_ID
      ? '/private/tmp/hvir-codex.ABC123'
      : '/tmp/hvir-codex.XYZ789'
  const exec = vi.fn<ProjectHost['exec']>((command, args) => {
    if (command === '/bin/zsh') {
      return Promise.resolve(execResult('codex-cli 0.146.0'))
    }
    if (command === 'sh' && args[2] === 'hvir-codex-mktemp') {
      return Promise.resolve(execResult(`${socketDirectory}\n`))
    }
    return Promise.resolve(execResult())
  })
  const execStream = vi.fn<ProjectHost['execStream']>(() => {
    const stream = new TestExecStream()
    streams.push(stream)
    return stream
  })
  const host = {
    hostId,
    connectionState: 'connected',
    exec,
    execStream,
    onConnectionState(cb: (state: HostConnectionState) => void) {
      connectionListeners.add(cb)
      return () => {
        connectionListeners.delete(cb)
      }
    },
  } as unknown as ProjectHost
  return {
    host,
    exec,
    execStream,
    streams,
    connectionListeners,
    socketDirectory,
  }
}

function execResult(stdout = '', code = 0) {
  return { code, signal: null, stdout, stderr: '' }
}

function sourceFrame(
  order: number,
  kind: 'start' | 'delta' | 'end',
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    revision: 1,
    sourceId: `record-${order}`,
    order,
    kind,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'message-1',
    ...extra,
  })}\n`
}

describe('Codex assistant-output runtime', () => {
  it.each([LOCAL_HOST_ID, asHostId('ssh:test-host')])(
    'uses the same transient ProjectHost lifecycle on %s',
    async (hostId) => {
      const fixture = hostFixture(hostId)
      const runtime = await codexAssistantOutput.prepare(fixture.host, {
        terminalId: 'terminal-1',
        generation: 7,
        cwd: hostPath(hostId, '/work/project'),
        defaultShell: '/bin/zsh',
        launchSpec: {
          file: 'codex',
          args: ['--config', 'tui.terminal_title=["thread-title"]'],
          shellEnvironment: true,
        },
        unsetEnvironment: ['CODEX_HOME'],
        signal: new AbortController().signal,
      })

      expect(runtime).toBeDefined()
      expect(fixture.streams).toHaveLength(2)
      expect(fixture.execStream.mock.calls[0]?.[0]).toBe('/bin/zsh')
      expect(fixture.execStream.mock.calls[1]?.[0]).toBe('python3')
      expect(runtime?.launchSpec.args[0]).toBe('--remote')
      expect(runtime?.launchSpec.args[1]).toBe(
        `unix://${fixture.socketDirectory}/client.sock`,
      )
      expect(fixture.exec).toHaveBeenCalledWith(
        'sh',
        [
          '-c',
          expect.stringContaining('mktemp -d /tmp/hvir-codex.XXXXXX'),
          'hvir-codex-mktemp',
        ],
        expect.objectContaining({ maxBuffer: 1024 }),
      )

      const events: AssistantOutputEvent[] = []
      runtime?.observe((event) => events.push(event))
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'availability',
          state: 'available',
          hostId,
          providerId: 'codex',
          generation: 7,
        }),
      ])
      expect(await runtime?.setMode(true)).toBe(false)
      expect(runtime?.admitSession('thread-1')).toBe(true)
      expect(await runtime?.setMode(true)).toBe(true)
      expect(fixture.streams[1]?.writes).toContain('MODE\t1\n')

      runtime?.dispose()
      await vi.waitFor(() =>
        expect(fixture.exec).toHaveBeenCalledWith(
          'sh',
          [
            '-c',
            expect.stringContaining('rmdir -- "$3"'),
            'hvir-codex-clean',
            `${fixture.socketDirectory}/server.sock`,
            `${fixture.socketDirectory}/client.sock`,
            fixture.socketDirectory,
          ],
          expect.objectContaining({ maxBuffer: 1024 }),
        ),
      )
      expect(
        fixture.streams.every((stream) => stream.dispose.mock.calls.length === 1),
      ).toBe(true)
    },
  )

  it('routes only admitted live frames and rejects late source output', async () => {
    const fixture = hostFixture(LOCAL_HOST_ID)
    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 8,
      cwd: hostPath(LOCAL_HOST_ID, '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: [], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })
    const events: AssistantOutputEvent[] = []
    runtime?.observe((event) => events.push(event))
    runtime?.admitSession('thread-1')
    const proxy = fixture.streams[1]!
    proxy.emitStdout(sourceFrame(1, 'start'))
    proxy.emitStdout(sourceFrame(2, 'delta', { text: 'hello' }))
    const finalDigest = createHash('sha256').update('hello').digest('hex')
    proxy.emitStdout(sourceFrame(3, 'end', { finalBytes: 5, finalDigest }))
    proxy.emitExit()
    proxy.emitStdout(sourceFrame(4, 'start', { itemId: 'late' }))

    expect(events.map((event) => event.kind)).toEqual([
      'availability',
      'start',
      'delta',
      'end',
      'availability',
    ])
    expect(events.at(-1)).toMatchObject({
      kind: 'availability',
      state: 'unavailable',
    })
  })

  it('reports unsupported helper setup without changing the requested launch', async () => {
    const fixture = hostFixture(LOCAL_HOST_ID)
    fixture.exec
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: 'codex-cli 0.146.0',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 1, signal: null, stdout: '', stderr: '' })

    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 9,
      cwd: hostPath(LOCAL_HOST_ID, '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: ['resume'], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })

    expect(runtime).toBeUndefined()
    expect(fixture.execStream).not.toHaveBeenCalled()
  })

  it('rechecks the exact executable version at launch time', async () => {
    const fixture = hostFixture(LOCAL_HOST_ID)
    fixture.exec.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: 'codex-cli 0.147.0',
      stderr: '',
    })

    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 10,
      cwd: hostPath(LOCAL_HOST_ID, '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: [], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })

    expect(runtime).toBeUndefined()
    expect(fixture.execStream).not.toHaveBeenCalled()
  })

  it('fails closed when the private socket directory is not exact', async () => {
    const fixture = hostFixture(LOCAL_HOST_ID)
    fixture.exec
      .mockResolvedValueOnce(execResult('codex-cli 0.146.0'))
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult('/private/tmp/not-provider-owned\n'))

    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 10,
      cwd: hostPath(LOCAL_HOST_ID, '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: [], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })

    expect(runtime).toBeUndefined()
    expect(fixture.execStream).not.toHaveBeenCalled()
  })

  it('revokes observation across a host reconnect without tearing down transport', async () => {
    const fixture = hostFixture(asHostId('ssh:test-host'))
    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 11,
      cwd: hostPath(asHostId('ssh:test-host'), '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: [], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })
    const events: AssistantOutputEvent[] = []
    runtime?.observe((event) => events.push(event))
    runtime?.admitSession('thread-1')
    fixture.streams[1]?.emitStdout(sourceFrame(1, 'start'))

    for (const listener of fixture.connectionListeners) listener('disconnected')
    for (const listener of fixture.connectionListeners) listener('connected')
    fixture.streams[1]?.emitStdout(sourceFrame(2, 'delta', { text: 'late' }))

    expect(events.map((event) => event.kind)).toEqual([
      'availability',
      'start',
      'abort',
      'availability',
    ])
    expect(events.at(-1)).toMatchObject({
      kind: 'availability',
      state: 'unavailable',
    })
    expect(fixture.streams[1]?.writes).toContain('REVOKE\n')
    expect(fixture.streams.every((stream) => !stream.dispose.mock.calls.length)).toBe(
      true,
    )
  })

  it('releases runtime listeners when preparation aborts after proxy creation', async () => {
    const fixture = hostFixture(LOCAL_HOST_ID)
    fixture.exec
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: 'codex-cli 0.146.0',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: `${fixture.socketDirectory}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('aborted'))

    const runtime = await codexAssistantOutput.prepare(fixture.host, {
      terminalId: 'terminal-1',
      generation: 12,
      cwd: hostPath(LOCAL_HOST_ID, '/work/project'),
      defaultShell: '/bin/zsh',
      launchSpec: { file: 'codex', args: [], shellEnvironment: true },
      unsetEnvironment: [],
      signal: new AbortController().signal,
    })

    expect(runtime).toBeUndefined()
    expect(fixture.connectionListeners.size).toBe(0)
    expect(
      fixture.streams.every((stream) => stream.dispose.mock.calls.length === 1),
    ).toBe(true)
  })
})
