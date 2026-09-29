import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  localPath,
  type HarnessTelemetry,
} from '../src/shared'
import {
  HarnessCompactionObservation,
  HarnessCompactionObservationRegistry,
} from '../src/main/harness/harness-compaction-observation'
import {
  observeCodexContext,
  parseCodexCompletedCompaction,
} from '../src/main/harness/codex-context-telemetry'
import {
  observeClaudeContext,
  parseClaudeCompletedCompaction,
} from '../src/main/harness/claude-context-telemetry'
import { claudeProjectDirectoryName } from '../src/main/harness/claude-session-artifact'
import { codexProvider } from '../src/main/harness/providers/codex'
import { claudeCodeProvider } from '../src/main/harness/providers/claude-code'
import type { ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'

const startedAt = Date.parse('2026-09-28T12:00:00.000Z')

describe('completed harness compaction observation', () => {
  it('counts completed identities independent of provider clock skew, deduplicates replay, and retains gaps', () => {
    const observation = new HarnessCompactionObservation(true, () => startedAt)
    const base = telemetry()

    const first = observation.accept(base, {
      identity: 'window-1',
      observedAt: startedAt - 60_000,
    })!
    expect(first.facets.compactions).toEqual({
      status: 'available',
      value: {
        observedCount: 1,
        periodStartedAt: startedAt,
        lastObservedAt: startedAt,
        coverage: 'continuous',
      },
    })
    expect(
      observation.accept(first, {
        identity: 'window-1',
        observedAt: startedAt - 60_000,
      }),
    ).toBeUndefined()
    expect(observation.gap(first).facets.compactions).toMatchObject({
      value: { observedCount: 1, coverage: 'gapped' },
    })
  })

  it('retains one exact host/artifact/conversation count across reconnects', () => {
    const registry = new HarnessCompactionObservationRegistry()
    const host = { hostId: 'local' } as ProjectHost
    const original = registry.acquire(host, 'codex:default', 'session-1', true)
    const accepted = original.accept(telemetry(), {
      identity: 'window-1',
      observedAt: Date.now() + 1_000,
    })
    expect(accepted?.facets.compactions).toMatchObject({
      value: { observedCount: 1, coverage: 'continuous' },
    })

    const reconnected = registry.acquire(host, 'codex:default', 'session-1', true)
    expect(reconnected).toBe(original)
    expect(reconnected.merge(telemetry()).facets.compactions).toMatchObject({
      value: { observedCount: 1, coverage: 'gapped' },
    })
    expect(registry.acquire(host, 'codex:other', 'session-1', true)).not.toBe(original)
  })

  it('keeps unsupported provider versions explicit', () => {
    const unsupported = new HarnessCompactionObservation(false, () => startedAt)
    expect(unsupported.merge(telemetry()).facets.compactions).toEqual({
      status: 'unsupported',
    })
    expect(
      unsupported.accept(telemetry(), {
        identity: 'window-1',
        observedAt: startedAt + 1,
      }),
    ).toBeUndefined()
  })

  it('observes local artifact boundaries and retains an exact reconnect count', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-compactions-'))
    const rolloutPath = localPath(join(directory, 'rollout.jsonl'))
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    const historicalAt = new Date(Date.now() - 120_000).toISOString()
    const firstAt = new Date(Date.now() + 1_000).toISOString()
    const secondAt = new Date(Date.now() + 2_000).toISOString()
    await writeFile(rolloutPath.path, `${codexCompactionRecord(historicalAt)}\n`)
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeCodexContext(host, observationContext(rolloutPath, emitted))
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(0))
      await appendFile(
        rolloutPath.path,
        `${codexContextRecord(40_000)}\n${codexCompactionRecord(firstAt)}\n`,
      )
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(1), {
        timeout: 4_000,
      })

      await stop()
      stop = await observeCodexContext(host, observationContext(rolloutPath, emitted))
      await vi.waitFor(() => {
        expect(emitted.at(-1)?.facets.compactions).toMatchObject({
          value: { observedCount: 1, coverage: 'gapped' },
        })
      })
      await appendFile(rolloutPath.path, `${codexCompactionRecord(secondAt)}\n`)
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(2), {
        timeout: 4_000,
      })
    } finally {
      await stop?.()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when bounded replay seeding is truncated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-compactions-truncated-'))
    const rolloutPath = localPath(join(directory, 'rollout.jsonl'))
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    const historicalAt = new Date(Date.now() - 120_000).toISOString()
    const liveAt = new Date(Date.now() + 1_000).toISOString()
    const recoveredAt = new Date(Date.now() + 2_000).toISOString()
    await writeFile(rolloutPath.path, `${codexCompactionRecord(historicalAt)}\n`)
    await host.connect()
    const originalExec = host.exec.bind(host)
    const exec = vi.spyOn(host, 'exec').mockImplementationOnce(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: codexCompactionRecord(historicalAt),
        stderr: '',
        outputTruncated: true,
      }),
    )
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeCodexContext(host, observationContext(rolloutPath, emitted))
      await vi.waitFor(() =>
        expect(emitted.at(-1)?.facets.compactions).toMatchObject({
          value: { observedCount: 0, coverage: 'gapped' },
        }),
      )
      await appendFile(
        rolloutPath.path,
        `${codexCompactionRecord(liveAt)}\n${codexContextRecord(30_000)}\n`,
      )
      await vi.waitFor(
        () =>
          expect(emitted.at(-1)?.facets.context).toMatchObject({
            value: { usedTokens: 30_000 },
          }),
        { timeout: 4_000 },
      )
      expect(observedCompactions(emitted.at(-1))).toBe(0)
      expect(exec).toHaveBeenCalled()
      exec.mockImplementation(originalExec)
      await stop()
      stop = await observeCodexContext(host, observationContext(rolloutPath, emitted))
      await appendFile(rolloutPath.path, `${codexCompactionRecord(recoveredAt)}\n`)
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(1), {
        timeout: 4_000,
      })
    } finally {
      await stop?.()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('observes Claude boundaries locally without counting replay or token changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-claude-compactions-'))
    const cwd = join(directory, 'workspace')
    await mkdir(cwd)
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const projectDirectory = join(
      directory,
      'projects',
      claudeProjectDirectoryName(await realpath(cwd)),
    )
    await mkdir(projectDirectory, { recursive: true })
    const transcript = join(projectDirectory, `${sessionId}.jsonl`)
    await writeFile(transcript, `${claudeCompactionRecord(sessionId, 'historical')}\n`)
    const host = new LocalHost()
    const emitted: HarnessTelemetry[] = []
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeClaudeContext(
        host,
        claudeObservationContext(localPath(cwd), directory, sessionId, emitted),
      )
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(0))
      await appendFile(
        transcript,
        `${claudeUsageRecord(sessionId, 2)}\n${claudeCompactionRecord(sessionId, 'live')}\n`,
      )
      await vi.waitFor(() => expect(observedCompactions(emitted.at(-1))).toBe(1), {
        timeout: 4_000,
      })
      const emissionCount = emitted.length
      await appendFile(transcript, `${claudeUsageRecord(sessionId, 1)}\n`)
      await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(emissionCount), {
        timeout: 4_000,
      })
      expect(observedCompactions(emitted.at(-1))).toBe(1)
    } finally {
      await stop?.()
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('provider compaction qualification', () => {
  it('admits Codex completed records and rejects token-count changes', () => {
    expect(
      parseCodexCompletedCompaction(
        JSON.stringify({
          timestamp: '2026-09-28T12:00:01.000Z',
          type: 'compacted',
        }),
      ),
    ).toEqual({
      identity: '2026-09-28T12:00:01.000Z',
      observedAt: Date.parse('2026-09-28T12:00:01.000Z'),
    })
    expect(
      parseCodexCompletedCompaction(
        JSON.stringify({
          timestamp: '2026-09-28T12:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { total_tokens: 1 } },
          },
        }),
      ),
    ).toBeUndefined()
  })

  it('admits exact Claude boundaries and rejects subagents and unrelated sessions', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'boundary-1',
      timestamp: '2026-09-28T12:00:01.000Z',
      sessionId,
    }
    expect(parseClaudeCompletedCompaction(JSON.stringify(boundary), sessionId)).toEqual({
      identity: 'boundary-1',
      observedAt: Date.parse(boundary.timestamp),
    })
    expect(
      parseClaudeCompletedCompaction(
        JSON.stringify({ ...boundary, uuid: 'sidechain', isSidechain: true }),
        sessionId,
      ),
    ).toBeUndefined()
    expect(
      parseClaudeCompletedCompaction(
        JSON.stringify({ ...boundary, uuid: 'other', sessionId: 'other-session' }),
        sessionId,
      ),
    ).toBeUndefined()
  })

  it('qualifies only provider versions with proven artifact records', () => {
    expect(
      codexProvider.probe.effectiveCapabilities('codex-cli 0.157.1')
        .compactionObservation,
    ).toBe(true)
    expect(
      codexProvider.probe.effectiveCapabilities('codex-cli 0.75.0').compactionObservation,
    ).toBeUndefined()
    expect(
      claudeCodeProvider.probe.effectiveCapabilities('2.1.283 (Claude Code)')
        .compactionObservation,
    ).toBe(true)
    expect(
      claudeCodeProvider.probe.effectiveCapabilities('2.1.38 (Claude Code)')
        .compactionObservation,
    ).toBeUndefined()
  })
})

function telemetry() {
  return contextHarnessSnapshot({
    providerId: asHarnessProviderId('codex'),
    provenance: 'test',
    context: { usedTokens: 1, windowTokens: 10, usedPercent: 10 },
    sessionId: '11111111-1111-4111-8111-111111111111',
    observedAt: startedAt,
  })
}

function observationContext(
  rolloutPath: ReturnType<typeof localPath>,
  emitted: HarnessTelemetry[],
) {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  return {
    subscriptionId: sessionId,
    sessionId,
    cwd: localPath(join(rolloutPath.path, '..')),
    sessionData: { rolloutPath },
    artifact: { identity: 'compaction-fixture', environment: {}, unsetEnvironment: [] },
    effectiveCapabilities: {
      sessionIdentity: 'preassigned' as const,
      exactResume: true,
      contextPresentation: 'pressure' as const,
      compactionObservation: true as const,
    },
    signal: new AbortController().signal,
    emit: (value: HarnessTelemetry | undefined) => {
      if (value) emitted.push(value)
    },
  }
}

function claudeObservationContext(
  cwd: ReturnType<typeof localPath>,
  configDirectory: string,
  sessionId: string,
  emitted: HarnessTelemetry[],
) {
  return {
    subscriptionId: sessionId,
    sessionId,
    cwd,
    artifact: {
      identity: 'claude-compaction-fixture',
      environment: { CLAUDE_CONFIG_DIR: configDirectory },
      unsetEnvironment: [],
    },
    effectiveCapabilities: {
      sessionIdentity: 'preassigned' as const,
      exactResume: true,
      contextPresentation: 'pressure' as const,
      compactionObservation: true as const,
    },
    signal: new AbortController().signal,
    emit: (value: HarnessTelemetry | undefined) => {
      if (value) emitted.push(value)
    },
  }
}

function codexContextRecord(usedTokens: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: usedTokens },
        model_context_window: 200_000,
      },
    },
  })
}

function codexCompactionRecord(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'compacted',
    payload: { privateConversationContent: 'must not cross the provider boundary' },
  })
}

function claudeCompactionRecord(sessionId: string, identity: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: identity,
    timestamp: new Date().toISOString(),
    sessionId,
  })
}

function claudeUsageRecord(sessionId: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId,
    requestId: `request-${inputTokens}`,
    message: {
      id: `message-${inputTokens}`,
      role: 'assistant',
      model: 'claude-test',
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  })
}

function observedCompactions(value: HarnessTelemetry | undefined): number | undefined {
  const fact = value?.facets.compactions
  return fact?.status === 'available' || fact?.status === 'stale'
    ? fact.value.observedCount
    : undefined
}
