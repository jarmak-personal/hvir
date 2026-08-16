import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  observeClaudeContext,
  parseClaudeUsage,
  snapshotClaudeUsage,
} from '../src/main/harness/claude-context-telemetry'
import { calculateHarnessUsageDelta } from '../src/main/harness/agent-work-usage'
import { claudeProjectDirectoryName } from '../src/main/harness/claude-session-artifact'
import type { ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { LOCAL_HOST_ID, localPath, type HarnessTelemetry } from '../src/shared'

const SESSION_ID = '092bd463-4567-4890-abcd-ef0123456789'

afterEach(() => vi.unstubAllEnvs())

describe('Claude Code context telemetry', () => {
  it('deduplicates provider records and calculates exact-session cumulative deltas', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'hvir-claude-usage-'))
    const cwd = join(configDirectory, 'workspace')
    await mkdir(cwd)
    const projectDirectory = join(
      configDirectory,
      'projects',
      claudeProjectDirectoryName(await realpath(cwd)),
    )
    const transcript = join(projectDirectory, `${SESSION_ID}.jsonl`)
    await mkdir(projectDirectory, { recursive: true })
    const first = claudeUsageRecord('request-1', 'message-1', {
      input: 10,
      cacheWrite: 20,
      cacheRead: 30,
      output: 4,
    })
    await writeFile(transcript, `${first}\nmalformed\n${first}\n`)
    const host = new LocalHost()
    const context = {
      sessionId: SESSION_ID,
      cwd: localPath(cwd),
      artifact: {
        identity: 'test',
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        unsetEnvironment: [],
      },
      signal: new AbortController().signal,
    }
    await host.connect()
    try {
      const start = await snapshotClaudeUsage(host, context)
      expect(start).toMatchObject({
        status: 'available',
        providerId: 'claude-code',
        route: { modelId: 'claude-test', reasoningEffort: 'high' },
        counters: {
          freshInputTokens: 10,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 20,
          outputTokens: 4,
        },
      })
      expect(JSON.stringify(start)).not.toMatch(
        new RegExp(`${SESSION_ID}|${configDirectory}|request-1|message-1`),
      )
      expect(start.status === 'available' ? start.counters : {}).not.toHaveProperty(
        'reasoningTokens',
      )

      await appendFile(
        transcript,
        `${claudeUsageRecord('request-2', 'message-2', {
          input: 2,
          cacheWrite: 3,
          cacheRead: 40,
          output: 5,
        })}\n`,
      )
      const end = await snapshotClaudeUsage(host, context)
      expect(calculateHarnessUsageDelta(start, end)).toMatchObject({
        status: 'complete',
        counters: {
          freshInputTokens: 2,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 3,
          outputTokens: 5,
        },
        normalizedTokenTotal: 50,
      })
    } finally {
      await host.dispose()
      await rm(configDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed when a usage record names another session', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'hvir-claude-identity-'))
    const cwd = join(configDirectory, 'workspace')
    await mkdir(cwd)
    const projectDirectory = join(
      configDirectory,
      'projects',
      claudeProjectDirectoryName(await realpath(cwd)),
    )
    await mkdir(projectDirectory, { recursive: true })
    await writeFile(
      join(projectDirectory, `${SESSION_ID}.jsonl`),
      `${claudeUsageRecord(
        'request-1',
        'message-1',
        {
          input: 1,
          cacheWrite: 2,
          cacheRead: 3,
          output: 4,
        },
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      )}\n`,
    )
    const host = new LocalHost()
    await host.connect()
    try {
      await expect(
        snapshotClaudeUsage(host, {
          sessionId: SESSION_ID,
          cwd: localPath(cwd),
          artifact: {
            identity: 'test',
            environment: { CLAUDE_CONFIG_DIR: configDirectory },
            unsetEnvironment: [],
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'invalid-session-identity',
      })
    } finally {
      await host.dispose()
      await rm(configDirectory, { recursive: true, force: true })
    }
  })

  it('reports an unavailable snapshot when the exact transcript is absent', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'hvir-claude-missing-'))
    const cwd = join(configDirectory, 'workspace')
    await mkdir(cwd)
    const host = new LocalHost()
    await host.connect()
    try {
      await expect(
        snapshotClaudeUsage(host, {
          sessionId: SESSION_ID,
          cwd: localPath(cwd),
          artifact: {
            identity: 'test',
            environment: { CLAUDE_CONFIG_DIR: configDirectory },
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
      await rm(configDirectory, { recursive: true, force: true })
    }
  })

  it('reports the current input, cache, and latest output tokens without a guessed limit', () => {
    const parsed = parseClaudeUsage(
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 6_791,
            cache_read_input_tokens: 14_416,
            output_tokens: 417,
          },
        },
      }),
    )
    expect(parsed?.version).toBe(1)
    expect(parsed?.source.providerId).toBe('claude-code')
    expect(parsed?.facets.context).toEqual({
      status: 'available',
      value: { usedTokens: 21_634 },
    })
  })

  it('rejects sidechain, malformed, and incomplete usage records', () => {
    expect(parseClaudeUsage('not-json')).toBeNull()
    expect(
      parseClaudeUsage(
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 1,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
              output_tokens: 4,
            },
          },
        }),
      ),
    ).toBeNull()
    expect(
      parseClaudeUsage(
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            role: 'assistant',
            model: '<synthetic>',
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          },
        }),
      ),
    ).toBeNull()
    expect(
      parseClaudeUsage(
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: { input_tokens: 1, output_tokens: -1 },
          },
        }),
      ),
    ).toBeNull()
  })

  it('waits for and follows the exact preassigned transcript through LocalHost', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'hvir-claude-context-'))
    const cwd = join(configDirectory, 'workspace')
    await mkdir(cwd)
    const projectDirectory = join(
      configDirectory,
      'projects',
      claudeProjectDirectoryName(await realpath(cwd)),
    )
    const transcript = join(projectDirectory, `${SESSION_ID}.jsonl`)
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    const controller = new AbortController()
    await mkdir(projectDirectory, { recursive: true })
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeClaudeContext(host, {
        subscriptionId: SESSION_ID,
        sessionId: SESSION_ID,
        cwd: localPath(cwd),
        artifact: {
          identity: 'test',
          environment: { CLAUDE_CONFIG_DIR: configDirectory },
          unsetEnvironment: [],
        },
        signal: controller.signal,
        emit: (telemetry) => {
          if (telemetry) emitted.push(telemetry)
        },
      })
      expect(emitted[0]?.facets.context).toEqual({
        status: 'pending',
        reason: 'Waiting for Claude context telemetry',
      })
      await appendFile(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 1_000,
              cache_creation_input_tokens: 2_000,
              cache_read_input_tokens: 30_000,
              output_tokens: 400,
            },
          },
        })}\n`,
      )
      await vi.waitFor(
        () => {
          const context = emitted.at(-1)?.facets.context
          expect(
            context?.status === 'available' ? context.value.usedTokens : undefined,
          ).toBe(33_400)
        },
        {
          timeout: 4_000,
        },
      )
      expect(
        emitted.filter((telemetry) => telemetry.facets.context.status === 'pending'),
      ).toHaveLength(1)
    } finally {
      await stop?.()
      await host.dispose()
      await rm(configDirectory, { recursive: true, force: true })
    }
  })

  it('stops quietly while a zero-turn transcript has not materialized', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'hvir-claude-context-'))
    const cwd = join(configDirectory, 'workspace')
    const host = new LocalHost()
    const controller = new AbortController()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await mkdir(cwd)
    await mkdir(join(configDirectory, 'projects'), { recursive: true })
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeClaudeContext(host, {
        subscriptionId: SESSION_ID,
        sessionId: SESSION_ID,
        cwd: localPath(cwd),
        artifact: {
          identity: 'test',
          environment: { CLAUDE_CONFIG_DIR: configDirectory },
          unsetEnvironment: [],
        },
        signal: controller.signal,
        emit: () => undefined,
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      await stop()
      stop = undefined
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(warning).not.toHaveBeenCalled()
    } finally {
      await stop?.()
      await host.dispose()
      warning.mockRestore()
      await rm(configDirectory, { recursive: true, force: true })
    }
  })

  it('reports a fixed unavailable state when the cwd-qualified locator fails', async () => {
    const emit = vi.fn<(telemetry: HarnessTelemetry | undefined) => void>()
    const execStream = vi.fn<ProjectHost['execStream']>()
    const host = {
      hostId: LOCAL_HOST_ID,
      exec: vi.fn(() =>
        Promise.resolve({ code: 1, signal: null, stdout: '', stderr: '' }),
      ),
      execStream,
    } as unknown as ProjectHost

    await observeClaudeContext(host, {
      subscriptionId: SESSION_ID,
      sessionId: SESSION_ID,
      cwd: localPath('/tmp/project'),
      artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
      signal: new AbortController().signal,
      emit,
    })

    expect(emit.mock.calls.map(([telemetry]) => telemetry?.facets.context)).toEqual([
      { status: 'pending', reason: 'Waiting for Claude context telemetry' },
      { status: 'unavailable', reason: 'Claude context location unavailable' },
    ])
    expect(execStream).not.toHaveBeenCalled()
  })
})

function claudeUsageRecord(
  requestId: string,
  messageId: string,
  counters: {
    readonly input: number
    readonly cacheWrite: number
    readonly cacheRead: number
    readonly output: number
  },
  sessionId = SESSION_ID,
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    session_id: sessionId,
    requestId,
    effort: 'high',
    isSidechain: false,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-test',
      usage: {
        input_tokens: counters.input,
        cache_creation_input_tokens: counters.cacheWrite,
        cache_read_input_tokens: counters.cacheRead,
        output_tokens: counters.output,
      },
    },
  })
}
