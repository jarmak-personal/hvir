import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  observeCodexContext,
  parseCodexTokenCount,
} from '../src/main/harness/codex-context-telemetry'
import { BoundedLineReader } from '../src/main/harness/bounded-line-reader'
import type { ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type HarnessTelemetry } from '../src/shared'

const SESSION_ID = '019ab123-4567-7890-abcd-ef0123456789'

describe('Codex context telemetry', () => {
  it('uses current input usage rather than cumulative token totals', () => {
    expectContextSnapshot(
      parseCodexTokenCount(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 3_375_392 },
              last_token_usage: {
                input_tokens: 107_459,
                cached_input_tokens: 102_272,
              },
              model_context_window: 258_400,
            },
          },
        }),
      ),
      107_459,
      258_400,
    )
  })

  it('prefers the latest active context total when Codex provides it', () => {
    expectContextSnapshot(
      parseCodexTokenCount(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 15_377, total_tokens: 15_437 },
              model_context_window: 258_400,
            },
          },
        }),
      ),
      15_437,
      258_400,
    )
  })

  it('rejects malformed, unrelated, and unavailable usage records', () => {
    expect(parseCodexTokenCount('not-json')).toBeNull()
    expect(
      parseCodexTokenCount(JSON.stringify({ type: 'event_msg', payload: {} })),
    ).toBeNull()
    expectContextSnapshot(
      parseCodexTokenCount(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 0 },
              model_context_window: 258_400,
            },
          },
        }),
      ),
      0,
      258_400,
    )
  })

  it('drops an oversized record without losing the next bounded line', () => {
    const onLine = vi.fn<(line: string) => void>()
    const reader = new BoundedLineReader(onLine)

    reader.push(`${'x'.repeat(256 * 1024 + 1)}\nvalid`)
    reader.push('\n')

    expect(onLine).toHaveBeenCalledOnce()
    expect(onLine).toHaveBeenCalledWith('valid')
  })

  it('follows the exact discovered rollout path and disposes its stream', async () => {
    const stdoutListeners = new Set<(chunk: string) => void>()
    const exitListeners = new Set<
      (result: { code: number | null; signal: string | null }) => void
    >()
    const dispose = vi.fn()
    const write = vi.fn<ExecStreamHandle['write']>(() => Promise.resolve())
    const end = vi.fn<ExecStreamHandle['end']>(() => {
      queueMicrotask(() => {
        for (const listener of exitListeners) listener({ code: 0, signal: null })
      })
      return Promise.resolve()
    })
    const stream: ExecStreamHandle = {
      onStdout: (cb) => {
        stdoutListeners.add(cb)
        return () => {
          stdoutListeners.delete(cb)
        }
      },
      onStderr: () => () => undefined,
      onError: () => () => undefined,
      onExit: (cb) => {
        exitListeners.add(cb)
        return () => {
          exitListeners.delete(cb)
        }
      },
      write,
      end,
      kill: vi.fn(),
      dispose,
    }
    const execStream = vi.fn<ProjectHost['execStream']>(() => stream)
    const host = { hostId: localPath('/').hostId, execStream } as unknown as ProjectHost
    const emitted = vi.fn<(value: HarnessTelemetry | undefined) => void>()
    const controller = new AbortController()
    const rolloutPath = localPath(
      `/home/user/.codex/sessions/rollout-session-${SESSION_ID}.jsonl`,
    )

    const stop = await observeCodexContext(host, {
      subscriptionId: SESSION_ID,
      sessionId: SESSION_ID,
      sessionData: { rolloutPath },
      artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
      signal: controller.signal,
      emit: emitted,
    })
    expect(execStream).toHaveBeenCalledWith('sh', expect.any(Array), {
      keepStdinOpen: true,
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]?.[0]).toContain(
      Buffer.from(rolloutPath.path, 'utf8').toString('base64'),
    )

    const record = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 80_000 },
          model_context_window: 200_000,
        },
      },
    })
    const execArgs = execStream.mock.calls[0]?.[1]
    const epoch = execArgs?.at(-1)
    const generation = write.mock.calls[0]?.[0].split('\t')[1]
    const frame = `E\t${epoch}\t${generation}\t${SESSION_ID}\t${SESSION_ID}\t${Buffer.from(record).toString('base64')}\n`
    for (const listener of stdoutListeners) listener(frame)
    expect(contextPercent(emitted.mock.calls.at(-1)?.[0])).toBe(40)

    void stop()
    expect(end).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })

  it('filters and follows real rollout records through LocalHost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-context-'))
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    const controller = new AbortController()
    const record = (used: number): string =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: used },
            model_context_window: 200_000,
          },
        },
      })

    await writeFile(
      path.path,
      `${JSON.stringify({ type: 'session_meta' })}\n${record(80_000)}\n`,
    )
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeCodexContext(host, {
        subscriptionId: SESSION_ID,
        sessionId: SESSION_ID,
        sessionData: { rolloutPath: path },
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: controller.signal,
        emit: (telemetry) => {
          if (telemetry) emitted.push(telemetry)
        },
      })
      await vi.waitFor(() => expect(contextPercent(emitted.at(-1))).toBe(40), {
        timeout: 4_000,
      })

      await appendFile(path.path, `${record(30_000)}\n`)
      await vi.waitFor(() => expect(contextPercent(emitted.at(-1))).toBe(15), {
        timeout: 4_000,
      })
    } finally {
      await stop?.()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function contextPercent(telemetry: HarnessTelemetry | undefined): number | undefined {
  const context = telemetry?.facets.context
  return context?.status === 'available' || context?.status === 'stale'
    ? context.value.usedPercent
    : undefined
}

function expectContextSnapshot(
  telemetry: HarnessTelemetry | null,
  usedTokens: number,
  windowTokens: number,
): void {
  expect(telemetry?.version).toBe(1)
  expect(telemetry?.source.providerId).toBe('codex')
  expect(telemetry?.facets.context).toEqual({
    status: 'available',
    value: {
      usedTokens,
      windowTokens,
      usedPercent: Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100)),
    },
  })
}
