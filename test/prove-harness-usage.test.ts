import { describe, expect, it, vi } from 'vitest'

import {
  captureHarnessUsageSnapshot,
  isProofHarnessUsageSnapshot,
} from '../scripts/prove-harness-usage-runner.mts'
import type { ProjectHost } from '../src/main/project-host'
import {
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_UNAVAILABLE_REASONS,
  localPath,
} from '../src/shared'

const SESSION_ID = '12345678-1234-4234-8234-123456789abc'

describe('harness usage proof input', () => {
  const snapshot = {
    version: 1,
    status: 'available',
    providerId: 'codex',
    observedAt: 10,
    route: { modelId: 'gpt-test', reasoningEffort: 'high' },
    counters: { outputTokens: 1 },
    timing: {},
  }

  it('accepts only the exact content-free snapshot schema', () => {
    expect(isProofHarnessUsageSnapshot(snapshot)).toBe(true)
    expect(
      isProofHarnessUsageSnapshot({ ...snapshot, sessionId: 'private-session' }),
    ).toBe(false)
    expect(
      isProofHarnessUsageSnapshot({
        ...snapshot,
        counters: { outputTokens: -1 },
      }),
    ).toBe(false)
  })

  it('admits every shared counter and unavailable reason without a proof-local vocabulary', () => {
    expect(
      isProofHarnessUsageSnapshot({
        ...snapshot,
        counters: Object.fromEntries(
          AGENT_WORK_TOKEN_COUNTER_NAMES.map((name) => [name, 1]),
        ),
      }),
    ).toBe(true)

    for (const reason of HARNESS_USAGE_UNAVAILABLE_REASONS) {
      expect(
        isProofHarnessUsageSnapshot({
          version: 1,
          status: 'unavailable',
          providerId: 'codex',
          observedAt: 10,
          reason,
        }),
      ).toBe(true)
    }
  })
})

describe('harness usage proof capture', () => {
  it('bounds a stalled provider read and emits only the fixed unavailable result', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const cwd = localPath('/tmp/hvir-proof-project')
    const rolloutPath = `/tmp/rollout-test-${SESSION_ID}.jsonl`
    const connect = vi.fn(() => Promise.resolve())
    const dispose = vi.fn(() => Promise.resolve())
    const readFileChunks = vi.fn((_path, options?: { readonly signal?: AbortSignal }) =>
      (async function* (): AsyncIterable<Uint8Array> {
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.signal
          if (signal?.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Harness usage capture aborted'),
            )
            return
          }
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Harness usage capture aborted'),
              ),
            { once: true },
          )
        })
        yield new Uint8Array()
      })(),
    )
    const host = {
      hostId: cwd.hostId,
      connect,
      dispose,
      realpath: vi.fn(() => Promise.resolve(cwd)),
      exec: vi.fn(() =>
        Promise.resolve({
          stdout: `${rolloutPath}\0`,
          stderr: '',
          code: 0,
          signal: null,
          outputTruncated: false,
        }),
      ),
      fileTransfer: { readFileChunks },
    } as unknown as ProjectHost

    try {
      const capture = captureHarnessUsageSnapshot(
        'codex',
        {
          sessionId: SESSION_ID,
          cwd: cwd.path,
          artifactEnvironment: {},
        },
        { createHost: () => host },
      )
      await vi.waitFor(() => expect(readFileChunks).toHaveBeenCalledOnce())
      expect(timeoutSpy).toHaveBeenCalledWith(30_000)

      timeout.abort(new Error('Proof deadline elapsed'))

      const snapshot = await capture
      expect(snapshot).toMatchObject({
        status: 'unavailable',
        providerId: 'codex',
        reason: 'artifact-unavailable',
      })
      expect(JSON.stringify(snapshot)).not.toContain(SESSION_ID)
      expect(JSON.stringify(snapshot)).not.toContain(cwd.path)
      expect(connect).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
