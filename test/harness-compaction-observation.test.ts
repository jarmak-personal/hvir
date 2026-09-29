import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { parseClaudeCompletedCompaction } from '../src/main/harness/claude-context-telemetry'
import { codexProvider } from '../src/main/harness/providers/codex'
import { claudeCodeProvider } from '../src/main/harness/providers/claude-code'
import type { ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'

const startedAt = Date.parse('2026-09-28T12:00:00.000Z')

describe('completed harness compaction observation', () => {
  it('counts only new completed identities, deduplicates replay, and retains gaps', () => {
    const observation = new HarnessCompactionObservation(true, () => startedAt)
    const base = telemetry()

    expect(
      observation.accept(base, {
        identity: 'before-period',
        observedAt: startedAt - 1,
      }),
    ).toBeUndefined()
    const first = observation.accept(base, {
      identity: 'window-1',
      observedAt: startedAt + 1,
    })!
    expect(first.facets.compactions).toEqual({
      status: 'available',
      value: {
        observedCount: 1,
        periodStartedAt: startedAt,
        lastObservedAt: startedAt + 1,
        coverage: 'continuous',
      },
    })
    expect(
      observation.accept(first, {
        identity: 'window-1',
        observedAt: startedAt + 1,
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
    const firstAt = new Date(Date.now() + 1_000).toISOString()
    const secondAt = new Date(Date.now() + 2_000).toISOString()
    await writeFile(rolloutPath.path, '')
    await host.connect()
    let stop: (() => void | Promise<void>) | undefined
    try {
      stop = await observeCodexContext(host, observationContext(rolloutPath, emitted))
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

function observedCompactions(value: HarnessTelemetry | undefined): number | undefined {
  const fact = value?.facets.compactions
  return fact?.status === 'available' || fact?.status === 'stale'
    ? fact.value.observedCount
    : undefined
}
