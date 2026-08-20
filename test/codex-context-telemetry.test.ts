import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  observeCodexContext,
  parseCodexTokenCount,
  snapshotCodexUsage,
} from '../src/main/harness/codex-context-telemetry'
import { calculateHarnessUsageDelta } from '../src/main/harness/agent-work-usage'
import { BoundedLineReader } from '../src/main/harness/bounded-line-reader'
import { HARNESS_USAGE_RECORD_BYTE_LIMIT } from '../src/main/harness/harness-usage-artifact'
import type { ExecStreamHandle, ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath, type HarnessTelemetry } from '../src/shared'

const SESSION_ID = '019ab123-4567-7890-abcd-ef0123456789'

describe('Codex context telemetry', () => {
  it('takes exact-session cumulative snapshots and calculates a real counter delta', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-usage-'))
    const canonicalDirectory = await realpath(directory)
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    const context = {
      sessionId: SESSION_ID,
      cwd: localPath(directory),
      sessionData: { rolloutPath: path },
      artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
      signal: new AbortController().signal,
    }
    await writeFile(
      path.path,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: SESSION_ID,
            cwd: canonicalDirectory,
            originator: 'codex-tui',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-test', effort: 'high' },
        }),
        'malformed',
        cumulativeCodexUsage(130, 100, 10, 30, 5),
      ].join('\n') + '\n',
    )
    await host.connect()
    try {
      const start = await snapshotCodexUsage(host, context)
      expect(start).toMatchObject({
        status: 'available',
        providerId: 'codex',
        route: { modelId: 'gpt-test', reasoningEffort: 'high' },
        counters: {
          freshInputTokens: 20,
          cacheReadInputTokens: 100,
          cacheWriteInputTokens: 10,
          outputTokens: 30,
          reasoningTokens: 5,
        },
      })
      expect(JSON.stringify(start)).not.toContain(SESSION_ID)
      expect(JSON.stringify(start)).not.toContain(directory)

      await appendFile(path.path, `${cumulativeCodexUsage(170, 120, 15, 40, 8)}\n`)
      const end = await snapshotCodexUsage(host, context)
      expect(calculateHarnessUsageDelta(start, end)).toMatchObject({
        status: 'complete',
        counters: {
          freshInputTokens: 15,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 5,
          outputTokens: 10,
          reasoningTokens: 3,
        },
        normalizedTokenTotal: 50,
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads exact cumulative counters after a rollout grows beyond 8 MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-large-usage-'))
    const canonicalDirectory = await realpath(directory)
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    const ignoredRecord = `${JSON.stringify({
      type: 'response_item',
      payload: { opaque: 'x'.repeat(1024) },
    })}\n`
    const repetitions = Math.ceil((8 * 1024 * 1024 + 1) / ignoredRecord.length)
    await writeFile(
      path.path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: canonicalDirectory,
          originator: 'codex-tui',
        },
      })}\n`,
    )
    await appendFile(path.path, ignoredRecord.repeat(repetitions))
    await appendFile(path.path, `${cumulativeCodexUsage(170, 120, 15, 40, 8)}\n`)
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, usageContext(directory, path)),
      ).resolves.toMatchObject({
        status: 'available',
        counters: {
          freshInputTokens: 35,
          cacheReadInputTokens: 120,
          cacheWriteInputTokens: 15,
          outputTokens: 40,
          reasoningTokens: 8,
        },
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('invalidates stale facts at an oversized record and restores later cumulative facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-oversized-'))
    const canonicalDirectory = await realpath(directory)
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: { opaque: 'x'.repeat(HARNESS_USAGE_RECORD_BYTE_LIMIT) },
    })
    await writeFile(
      path.path,
      [
        sessionMeta(canonicalDirectory),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'stale-model', effort: 'high' },
        }),
        cumulativeCodexUsage(5, 2, 1, 3, 1),
        oversized,
        cumulativeCodexUsage(9, 4, 1, 5, 2),
      ].join('\n') + '\n',
    )
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, usageContext(directory, path)),
      ).resolves.toMatchObject({
        status: 'available',
        route: {},
        counters: {
          freshInputTokens: 4,
          cacheReadInputTokens: 4,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          reasoningTokens: 2,
        },
      })

      await appendFile(
        path.path,
        `${JSON.stringify({
          type: 'turn_context',
          payload: { model: 'restored-model', effort: 'medium' },
        })}\n${cumulativeCodexUsage(12, 5, 2, 6, 3)}\n`,
      )
      await expect(
        snapshotCodexUsage(host, usageContext(directory, path)),
      ).resolves.toMatchObject({
        status: 'available',
        route: { modelId: 'restored-model', reasoningEffort: 'medium' },
        counters: { freshInputTokens: 5 },
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when no cumulative counter follows an oversized record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-stale-usage-'))
    const canonicalDirectory = await realpath(directory)
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    await writeFile(
      path.path,
      `${sessionMeta(canonicalDirectory)}\n${cumulativeCodexUsage(5, 2, 1, 3, 1)}\n${'x'.repeat(
        HARNESS_USAGE_RECORD_BYTE_LIMIT + 1,
      )}`,
    )
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, usageContext(directory, path)),
      ).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'usage-unavailable',
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reassembles records across host chunks and ignores a truncated final record', async () => {
    const cwd = localPath('/tmp/project')
    const path = localPath(`/tmp/rollout-session-${SESSION_ID}.jsonl`)
    const content = `${sessionMeta(cwd.path)}\nmalformed\n${cumulativeCodexUsage(
      9,
      4,
      1,
      5,
      2,
    )}\n{"type":"event_msg","payload":{"type":"token_count"`
    const bytes = Buffer.from(content)
    const readFileChunks = vi.fn(() =>
      (async function* (): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        for (const end of [1, 7, 63, 64, 65, bytes.length]) {
          const start = end === 1 ? 0 : ([1, 7, 63, 64, 65].findLast((n) => n < end) ?? 0)
          if (end > start) yield bytes.subarray(start, end)
        }
      })(),
    )
    const host = {
      hostId: cwd.hostId,
      realpath: vi.fn(() => Promise.resolve(cwd)),
      fileTransfer: { readFileChunks },
    } as unknown as ProjectHost
    const signal = new AbortController().signal

    await expect(
      snapshotCodexUsage(host, {
        ...usageContext(cwd.path, path),
        signal,
      }),
    ).resolves.toMatchObject({
      status: 'available',
      counters: { freshInputTokens: 4, outputTokens: 5 },
    })
    expect(readFileChunks).toHaveBeenCalledWith(path, { signal })
  })

  it('rejects a rollout whose qualified record does not match the exact session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-identity-'))
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    const host = new LocalHost()
    await writeFile(
      path.path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          cwd: directory,
          originator: 'codex-tui',
        },
      })}\n${cumulativeCodexUsage(1, 0, 0, 1, 0)}\n`,
    )
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, {
          sessionId: SESSION_ID,
          cwd: localPath(directory),
          sessionData: { rolloutPath: path },
          artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'invalid-session-identity',
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('qualifies exact session identity through a canonical symlinked cwd', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-canonical-cwd-'))
    const canonicalCwd = join(directory, 'workspace')
    const linkedCwd = join(directory, 'workspace-link')
    await mkdir(canonicalCwd)
    await symlink(canonicalCwd, linkedCwd)
    const path = localPath(join(directory, `rollout-session-${SESSION_ID}.jsonl`))
    await writeFile(
      path.path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: await realpath(canonicalCwd),
          originator: 'codex-tui',
        },
      })}\n${cumulativeCodexUsage(5, 2, 1, 3, 1)}\n`,
    )
    const host = new LocalHost()
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, {
          sessionId: SESSION_ID,
          cwd: localPath(linkedCwd),
          sessionData: { rolloutPath: path },
          artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'available',
        counters: { freshInputTokens: 2 },
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports an unavailable snapshot when the exact rollout artifact is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-missing-'))
    const host = new LocalHost()
    await host.connect()
    try {
      await expect(
        snapshotCodexUsage(host, {
          sessionId: SESSION_ID,
          cwd: localPath(directory),
          artifact: {
            identity: 'test',
            environment: { CODEX_HOME: directory },
            unsetEnvironment: [],
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'artifact-unavailable',
      })
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports an unavailable snapshot when exact-session discovery throws', async () => {
    const cwd = localPath('/tmp/project')
    const readFileChunks = vi.fn()
    const host = {
      hostId: cwd.hostId,
      realpath: vi.fn(() => Promise.resolve(cwd)),
      exec: vi.fn<ProjectHost['exec']>(() =>
        Promise.reject(new Error('session discovery failed')),
      ),
      fileTransfer: { readFileChunks },
    } as unknown as ProjectHost

    await expect(
      snapshotCodexUsage(host, {
        sessionId: SESSION_ID,
        cwd,
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'artifact-unavailable',
    })
    expect(readFileChunks).not.toHaveBeenCalled()
  })

  it('rejects a possibly ambiguous path from truncated session discovery', async () => {
    const cwd = localPath('/tmp/project')
    const readFileChunks = vi.fn()
    const host = {
      hostId: cwd.hostId,
      realpath: vi.fn(() => Promise.resolve(cwd)),
      exec: vi.fn<ProjectHost['exec']>(() =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: `/tmp/rollout-session-${SESSION_ID}.jsonl\0`,
          stderr: '',
          outputTruncated: true,
        }),
      ),
      fileTransfer: { readFileChunks },
    } as unknown as ProjectHost

    await expect(
      snapshotCodexUsage(host, {
        sessionId: SESSION_ID,
        cwd,
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'artifact-unavailable',
    })
    expect(readFileChunks).not.toHaveBeenCalled()
  })

  it('rejects an artifact read that completes after snapshot revocation', async () => {
    const controller = new AbortController()
    const path = localPath(`/tmp/rollout-session-${SESSION_ID}.jsonl`)
    const content = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: SESSION_ID, cwd: '/tmp/project', originator: 'codex-tui' },
    })}\n${cumulativeCodexUsage(5, 2, 1, 3, 1)}\n`
    const host = {
      hostId: path.hostId,
      realpath: vi.fn((value) => Promise.resolve(value)),
      fileTransfer: {
        readFileChunks: vi.fn(() =>
          (async function* (): AsyncIterable<Uint8Array> {
            await Promise.resolve()
            yield Buffer.from(content)
            controller.abort()
          })(),
        ),
      },
    } as unknown as ProjectHost

    await expect(
      snapshotCodexUsage(host, {
        sessionId: SESSION_ID,
        cwd: localPath('/tmp/project'),
        sessionData: { rolloutPath: path },
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'artifact-unavailable',
    })
  })

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
      cwd: localPath('/tmp/project'),
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

    const health = `H\t${epoch}\t${generation}\t${SESSION_ID}\t${SESSION_ID}\tunavailable\tfollower-exited\n`
    for (const listener of stdoutListeners) listener(health)
    expect(emitted.mock.calls.at(-1)?.[0]?.facets.context).toEqual({
      status: 'unavailable',
      reason: 'Codex context follower unavailable',
    })

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
        cwd: localPath(directory),
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

function usageContext(cwd: string, rolloutPath: ReturnType<typeof localPath>) {
  return {
    sessionId: SESSION_ID,
    cwd: localPath(cwd),
    sessionData: { rolloutPath },
    artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
    signal: new AbortController().signal,
  }
}

function sessionMeta(cwd: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id: SESSION_ID, cwd, originator: 'codex-tui' },
  })
}

function cumulativeCodexUsage(
  input: number,
  cached: number,
  cacheWrite: number,
  output: number,
  reasoning: number,
): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: cacheWrite,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      },
    },
  })
}

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
