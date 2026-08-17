import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgentWorkCheckpoint } from '../scripts/agent-work-checkpoint-runner.mts'
import {
  AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS,
  AgentWorkCheckpointStore,
  type AgentWorkCheckpointClock,
} from '../scripts/agent-work-checkpoint-store.mts'
import type { HarnessUsageSnapshot } from '../src/main/harness/agent-work-usage'
import { asHarnessProviderId } from '../src/shared'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('agent-work private checkpoint lifecycle', () => {
  it('survives process owners, excludes paused time, and retains a finished observation until release', async () => {
    const root = await privateRoot()
    const clock = fakeClock()
    const firstProcess = new AgentWorkCheckpointStore(root, clock)
    const locator = codexLocator('delegated-session')

    await expect(
      firstProcess.start({
        ...locator,
        cwd: '/private/launch',
        artifactEnvironment: { CODEX_HOME: '/private/provider' },
        snapshot: snapshot(10, 100),
      }),
    ).resolves.toMatchObject({ status: 'started', providerId: 'codex' })
    const [checkpointName] = await readdir(root)
    expect(checkpointName).toMatch(/^[a-f0-9]{64}\.json$/)
    expect((await stat(root)).mode & 0o077).toBe(0)
    expect((await stat(join(root, checkpointName!))).mode & 0o077).toBe(0)

    clock.advance(12)
    const laterProcess = new AgentWorkCheckpointStore(root, clock)
    await expect(laterProcess.pause(locator)).resolves.toMatchObject({ status: 'paused' })
    clock.advance(40)
    await expect(laterProcess.resume(locator)).resolves.toMatchObject({
      status: 'resumed',
    })
    clock.advance(8)

    let captures = 0
    const result = await laterProcess.finish(locator, (context) => {
      captures += 1
      expect(context).toEqual({
        sessionId: 'delegated-session',
        cwd: '/private/launch',
        artifactEnvironment: { CODEX_HOME: '/private/provider' },
      })
      return Promise.resolve(snapshot(20, 125))
    })

    expect(result).toMatchObject({
      status: 'closed',
      activeWallMilliseconds: 20,
      usage: {
        status: 'complete',
        counters: { freshInputTokens: 25 },
        normalizedTokenTotal: 25,
      },
    })
    expect(JSON.stringify(result)).not.toContain('delegated-session')
    expect(JSON.stringify(result)).not.toContain('/private/')
    expect(JSON.stringify(result)).not.toContain(locator.runKey)
    await expect(readdir(root)).resolves.toHaveLength(1)
    await expect(
      new AgentWorkCheckpointStore(root, clock).finish(locator, () => {
        captures += 1
        return Promise.resolve(snapshot(30, 999))
      }),
    ).resolves.toEqual(result)
    expect(captures).toBe(1)
    await expect(laterProcess.release(locator)).resolves.toMatchObject({
      status: 'released',
    })
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('keeps the first baseline when start is retried', async () => {
    const root = await privateRoot()
    const clock = fakeClock()
    const store = new AgentWorkCheckpointStore(root, clock)
    const locator = codexLocator('same-session')
    const input = {
      ...locator,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 10),
    }

    await expect(store.start(input)).resolves.toMatchObject({ status: 'started' })
    clock.advance(5)
    await expect(
      store.start({ ...input, snapshot: snapshot(11, 999) }),
    ).resolves.toMatchObject({ status: 'unchanged' })
    await expect(store.inspect(locator)).resolves.toMatchObject({ status: 'unchanged' })
    const result = await store.finish(locator, () => Promise.resolve(snapshot(20, 20)))

    expect(result?.usage).toMatchObject({
      status: 'complete',
      counters: { freshInputTokens: 10 },
      normalizedTokenTotal: 10,
    })
    await store.release(locator)
  })

  it('isolates distinct run keys within the same issue, phase, provider, and session', async () => {
    const root = await privateRoot()
    const store = new AgentWorkCheckpointStore(root, fakeClock())
    const first = codexLocator('shared-session', 'a'.repeat(64))
    const second = codexLocator('shared-session', 'b'.repeat(64))
    await store.start({
      ...first,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 10),
    })
    await store.start({
      ...second,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 100),
    })

    await expect(
      store.finish(first, () => Promise.resolve(snapshot(20, 20))),
    ).resolves.toMatchObject({ usage: { counters: { freshInputTokens: 10 } } })
    await expect(
      store.finish(second, () => Promise.resolve(snapshot(20, 130))),
    ).resolves.toMatchObject({ usage: { counters: { freshInputTokens: 30 } } })
    await expect(readdir(root)).resolves.toHaveLength(2)
    await store.release(first)
    await store.release(second)
  })

  it('keeps an unpublished planning lifecycle isolated and content-free until append release', async () => {
    const root = await privateRoot()
    const clock = fakeClock()
    const store = new AgentWorkCheckpointStore(root, clock)
    const pending = pendingPlanningLocator('planning-session')
    const published = { ...pending, issueNumber: 575 }

    await expect(
      store.start({
        ...pending,
        cwd: '/private/planning-launch',
        artifactEnvironment: {},
        snapshot: snapshot(10, 10),
      }),
    ).resolves.toMatchObject({ status: 'started' })
    await expect(
      store.start({
        ...published,
        cwd: '/private/planning-launch',
        artifactEnvironment: {},
        snapshot: snapshot(10, 100),
      }),
    ).resolves.toMatchObject({ status: 'started' })
    await expect(readdir(root)).resolves.toHaveLength(2)

    clock.advance(7)
    await expect(store.pause(pending)).resolves.toMatchObject({ status: 'paused' })
    clock.advance(50)
    await expect(store.resume(pending)).resolves.toMatchObject({ status: 'resumed' })
    clock.advance(3)
    let captures = 0
    const observation = await store.finish(pending, () => {
      captures += 1
      return Promise.resolve(snapshot(20, 25))
    })

    expect(observation).toMatchObject({
      status: 'closed',
      activeWallMilliseconds: 10,
      usage: { counters: { freshInputTokens: 15 } },
    })
    expect(JSON.stringify(observation)).not.toContain('pending')
    expect(JSON.stringify(observation)).not.toContain('/private/')
    await expect(
      store.finish(pending, () => {
        captures += 1
        return Promise.resolve(snapshot(30, 999))
      }),
    ).resolves.toEqual(observation)
    expect(captures).toBe(1)
    await expect(store.abandon(pending)).rejects.toThrow(
      'A finalized agent-work checkpoint must be released after append.',
    )
    await expect(store.release(pending)).resolves.toMatchObject({ status: 'released' })
    await expect(store.abandon(published)).resolves.toMatchObject({ status: 'abandoned' })
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('rejects a pending locator outside issue planning before persisting state', async () => {
    const root = await privateRoot()
    const store = new AgentWorkCheckpointStore(root, fakeClock())

    await expect(
      store.start({
        ...pendingPlanningLocator('invalid-pending-session'),
        phase: 'implementation',
        cwd: '/launch',
        artifactEnvironment: {},
        snapshot: snapshot(10, 1),
      }),
    ).rejects.toThrow(
      'A pending agent-work checkpoint locator is supported only for issue-planning.',
    )
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('does not discover or consume a different delegated identity', async () => {
    const root = await privateRoot()
    const store = new AgentWorkCheckpointStore(root, fakeClock())
    const owner = codexLocator('owner-session')
    await store.start({
      ...owner,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })

    await expect(
      store.finish(codexLocator('different-session'), () =>
        Promise.resolve(snapshot(20, 2)),
      ),
    ).resolves.toBeUndefined()
    await expect(readdir(root)).resolves.toHaveLength(1)
    await expect(store.abandon(owner)).resolves.toMatchObject({ status: 'abandoned' })
  })

  it('abandons deterministically and reports a repeated abandonment unavailable', async () => {
    const root = await privateRoot()
    const store = new AgentWorkCheckpointStore(root, fakeClock())
    const locator = codexLocator('abandoned-session')
    await store.start({
      ...locator,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })

    await expect(store.abandon(locator)).resolves.toMatchObject({ status: 'abandoned' })
    await expect(store.abandon(locator)).resolves.toEqual({
      version: 1,
      operation: 'abandon',
      status: 'unavailable',
      reason: 'run-identity-unproven',
    })
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('retains the baseline after an operational finish failure and cleans up after retry', async () => {
    const root = await privateRoot()
    const store = new AgentWorkCheckpointStore(root, fakeClock())
    const locator = codexLocator('retry-session')
    await store.start({
      ...locator,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })

    await expect(
      store.finish(locator, () => Promise.reject(new Error('provider unavailable'))),
    ).rejects.toThrow('provider unavailable')
    await expect(readdir(root)).resolves.toHaveLength(1)
    await expect(
      store.finish(locator, () => Promise.resolve(snapshot(20, 2))),
    ).resolves.toMatchObject({ status: 'closed' })
    await expect(readdir(root)).resolves.toHaveLength(1)
    await store.release(locator)
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('prunes only owned checkpoints after the bounded retention interval', async () => {
    const root = await privateRoot()
    const clock = fakeClock(Date.now())
    const store = new AgentWorkCheckpointStore(root, clock)
    const stale = codexLocator('stale-session')
    const finalized = codexLocator('stale-session', 'b'.repeat(64))
    await store.start({
      ...stale,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })
    await store.start({
      ...finalized,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })
    await store.finish(finalized, () => Promise.resolve(snapshot(20, 2)))
    await writeFile(join(root, 'unrelated-owner-state'), 'preserve', { mode: 0o600 })

    clock.advance(AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS + 1_000)
    expect(await store.pruneStale()).toBe(2)
    await expect(
      store.finish(stale, () => Promise.resolve(snapshot(20, 2))),
    ).resolves.toBeUndefined()
    await expect(readdir(root)).resolves.toEqual(['unrelated-owner-state'])
  })
})

describe('agent-work checkpoint command identity boundary', () => {
  it('requires the canonical 64-hex run key before resolving private identity', async () => {
    await expect(
      runAgentWorkCheckpoint(
        [
          'start',
          '--issue',
          '576',
          '--phase',
          'implementation',
          '--provider',
          'codex',
          '--run-key',
          'not-a-run-key',
        ],
        {},
      ),
    ).rejects.toThrow('--run-key must be exactly 64 lowercase hexadecimal characters.')
  })

  it('fails closed before provider or filesystem access when the delegated identity is absent', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      runAgentWorkCheckpoint(
        [
          'start',
          '--issue',
          '576',
          '--phase',
          'implementation',
          '--provider',
          'codex',
          '--run-key',
          'a'.repeat(64),
        ],
        {},
      ),
    ).resolves.toBe(2)

    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"reason": "run-identity-unproven"'),
    )
  })

  it('accepts a content-free pending locator only for unpublished issue planning', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const runKey = 'b'.repeat(64)

    await expect(
      runAgentWorkCheckpoint(
        [
          'start',
          '--issue',
          'pending',
          '--phase',
          'issue-planning',
          '--provider',
          'codex',
          '--run-key',
          runKey,
        ],
        {},
      ),
    ).resolves.toBe(2)

    const report = String(output.mock.calls.at(-1)?.[0])
    expect(report).toContain('"reason": "run-identity-unproven"')
    expect(report).not.toContain('pending')
    expect(report).not.toContain(runKey)
    await expect(
      runAgentWorkCheckpoint(
        [
          'start',
          '--issue',
          'pending',
          '--phase',
          'implementation',
          '--provider',
          'codex',
          '--run-key',
          runKey,
        ],
        {},
      ),
    ).rejects.toThrow('--issue pending is supported only for issue-planning.')
  })
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-agent-work-checkpoint-test-'))
  temporaryRoots.push(root)
  return root
}

function codexLocator(sessionId: string, runKey = 'a'.repeat(64)) {
  return {
    issueNumber: 576,
    phase: 'implementation' as const,
    providerId: 'codex' as const,
    sessionId,
    runKey,
  }
}

function pendingPlanningLocator(sessionId: string, runKey = 'c'.repeat(64)) {
  return {
    issueNumber: 'pending' as const,
    phase: 'issue-planning' as const,
    providerId: 'codex' as const,
    sessionId,
    runKey,
  }
}

function snapshot(observedAt: number, value: number): HarnessUsageSnapshot {
  return {
    version: 1,
    status: 'available',
    providerId: asHarnessProviderId('codex'),
    observedAt,
    route: { modelId: 'gpt-test', reasoningEffort: 'high' },
    counters: {
      freshInputTokens: value,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    timing: {},
  }
}

function fakeClock(initialEpochMilliseconds = 1_000): AgentWorkCheckpointClock & {
  advance(milliseconds: number): void
} {
  let nanoseconds = 0n
  let epochMilliseconds = initialEpochMilliseconds
  return {
    monotonicNanoseconds: () => nanoseconds,
    epochMilliseconds: () => epochMilliseconds,
    advance: (milliseconds) => {
      nanoseconds += BigInt(milliseconds) * 1_000_000n
      epochMilliseconds += milliseconds
    },
  }
}
