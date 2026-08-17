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
  it('survives process owners, excludes paused time, and removes a finished checkpoint', async () => {
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

    const result = await laterProcess.finish(locator, (context) => {
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
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('prunes only owned checkpoints after the bounded retention interval', async () => {
    const root = await privateRoot()
    const clock = fakeClock(Date.now())
    const store = new AgentWorkCheckpointStore(root, clock)
    const stale = codexLocator('stale-session')
    await store.start({
      ...stale,
      cwd: '/launch',
      artifactEnvironment: {},
      snapshot: snapshot(10, 1),
    })
    await writeFile(join(root, 'unrelated-owner-state'), 'preserve', { mode: 0o600 })

    clock.advance(AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS + 1_000)
    expect(await store.pruneStale()).toBe(1)
    await expect(
      store.finish(stale, () => Promise.resolve(snapshot(20, 2))),
    ).resolves.toBeUndefined()
    await expect(readdir(root)).resolves.toEqual(['unrelated-owner-state'])
  })
})

describe('agent-work checkpoint command identity boundary', () => {
  it('fails closed before provider or filesystem access when the delegated identity is absent', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      runAgentWorkCheckpoint(
        ['start', '--issue', '576', '--phase', 'implementation', '--provider', 'codex'],
        {},
      ),
    ).resolves.toBe(2)

    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"reason": "run-identity-unproven"'),
    )
  })
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-agent-work-checkpoint-test-'))
  temporaryRoots.push(root)
  return root
}

function codexLocator(sessionId: string) {
  return {
    issueNumber: 576,
    phase: 'implementation' as const,
    providerId: 'codex' as const,
    sessionId,
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
