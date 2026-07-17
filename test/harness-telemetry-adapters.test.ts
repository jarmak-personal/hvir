import { describe, expect, it, vi } from 'vitest'

import { observeClaudeContext } from '../src/main/harness/claude-context-telemetry'
import { observeCodexContext } from '../src/main/harness/codex-context-telemetry'
import type { Disposer, ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import { LOCAL_HOST_ID, localPath } from '../src/shared'

describe('adapter-owned telemetry multiplexing', () => {
  it('uses one Codex and one Claude stream for ten live sessions each', async () => {
    const codex = fakeStream()
    const claude = fakeStream()
    const execStream = vi
      .fn<ProjectHost['execStream']>()
      .mockReturnValueOnce(codex.handle)
      .mockReturnValueOnce(claude.handle)
    const host = {
      hostId: LOCAL_HOST_ID,
      execStream,
      exec: vi.fn(() =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: '/tmp/claude-projects',
          stderr: '',
        }),
      ),
    } as unknown as ProjectHost
    const controllers = Array.from({ length: 20 }, () => new AbortController())

    const codexStops = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const id = sessionId(1, index)
        return observeCodexContext(host, {
          subscriptionId: id,
          sessionId: id,
          sessionData: { rolloutPath: localPath(`/tmp/codex-${index}.jsonl`) },
          artifact: { identity: 'codex-test', environment: {}, unsetEnvironment: [] },
          signal: controllers[index]!.signal,
          emit: () => undefined,
        })
      }),
    )
    const claudeStops = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const id = sessionId(2, index)
        return observeClaudeContext(host, {
          subscriptionId: id,
          sessionId: id,
          artifact: {
            identity: 'claude-test',
            environment: {},
            unsetEnvironment: [],
          },
          signal: controllers[index + 10]!.signal,
          emit: () => undefined,
        })
      }),
    )

    await vi.waitFor(() => expect(codex.writes).toHaveLength(11))
    await vi.waitFor(() => expect(claude.writes).toHaveLength(11))
    expect(execStream).toHaveBeenCalledTimes(2)
    expect(codex.writes[0]).toBe('R\t1\t10\n')
    expect(claude.writes[0]).toBe('R\t1\t10\n')

    await disposeAll([...codexStops, ...claudeStops])
    expect(codex.end).toHaveBeenCalledOnce()
    expect(claude.end).toHaveBeenCalledOnce()
  })
})

function sessionId(adapter: number, index: number): string {
  return `${adapter}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function fakeStream(): {
  readonly handle: ExecStreamHandle
  readonly writes: string[]
  readonly end: ReturnType<typeof vi.fn>
} {
  const writes: string[] = []
  const end = vi.fn(() => Promise.resolve())
  return {
    writes,
    end,
    handle: {
      onStdout: () => () => undefined,
      onStderr: () => () => undefined,
      onError: () => () => undefined,
      onExit: () => () => undefined,
      write: (value) => {
        writes.push(value)
        return Promise.resolve()
      },
      end,
      kill: () => undefined,
      dispose: () => undefined,
    },
  }
}

async function disposeAll(disposers: readonly Disposer[]): Promise<void> {
  await Promise.all(disposers.map(async (dispose) => dispose()))
}
