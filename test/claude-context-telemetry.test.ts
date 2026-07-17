import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  observeClaudeContext,
  parseClaudeUsage,
} from '../src/main/harness/claude-context-telemetry'
import { LocalHost } from '../src/main/project-host/local-host'
import type { HarnessTelemetry } from '../src/shared'

const SESSION_ID = '092bd463-4567-4890-abcd-ef0123456789'

afterEach(() => vi.unstubAllEnvs())

describe('Claude Code context telemetry', () => {
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
    const projectDirectory = join(configDirectory, 'projects', '-tmp-project')
    const transcript = join(projectDirectory, `${SESSION_ID}.jsonl`)
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    const controller = new AbortController()
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDirectory)
    await mkdir(projectDirectory, { recursive: true })
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeClaudeContext(host, {
        subscriptionId: SESSION_ID,
        sessionId: SESSION_ID,
        artifact: { identity: 'test', environment: {}, unsetEnvironment: [] },
        signal: controller.signal,
        emit: (telemetry) => {
          if (telemetry) emitted.push(telemetry)
        },
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
    } finally {
      await stop?.()
      await host.dispose()
      await rm(configDirectory, { recursive: true, force: true })
    }
  })
})
