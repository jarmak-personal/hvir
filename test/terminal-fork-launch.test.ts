import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, onTestFinished, vi } from 'vitest'

import {
  codexProvider,
  type HarnessSessionDiscovery,
  type HarnessSessionDiscoveryResult,
} from '../src/main/harness/harness-provider'
import { LocalHost } from '../src/main/project-host/local-host'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
} from '../src/shared'
import { createPtySupervisorFixture } from './fixtures/pty-supervisor-fixture'

it('spawns an exact provider fork as a distinct non-resumed session', async () => {
  const fixture = createPtySupervisorFixture()
  Object.assign(fixture.provider, {
    fork: vi.fn((ctx: { parentSessionId?: string }) => ({
      file: 'test-harness',
      args: ['fork', ctx.parentSessionId!],
    })),
  })

  const forked = await fixture.spawn({
    sessionId: 'fork-child',
    launchMode: 'fork',
    parentHarnessSessionId: 'fork-parent',
    effectiveCapabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      exactFork: true,
      contextPresentation: 'none',
    },
  })

  expect(forked).toMatchObject({
    id: 'fork-child',
    resumed: false,
    harnessSessionId: 'fork-child',
    identityStatus: 'identified',
  })
  expect(fixture.snapshot().spawns).toEqual([
    expect.objectContaining({ args: ['fork', 'fork-parent'] }),
  ])
})

it('snapshots and binds the discovered child identity for a Codex fork', async () => {
  const baseline = { entries: ['before-fork'] }
  const snapshot = vi.fn(() => Promise.resolve(baseline))
  let finishIdentification: (() => void) | undefined
  const identify = vi.fn(
    () =>
      new Promise<HarnessSessionDiscoveryResult>((resolve) => {
        finishIdentification = () =>
          resolve({
            status: 'identified',
            sessionId: 'codex-fork-child-id',
          })
      }),
  )
  const discovery: HarnessSessionDiscovery = {
    snapshot,
    identify,
  }
  const provider = {
    ...codexProvider,
    sessionDiscovery: discovery,
    telemetry: undefined,
  }
  const registerSessionIdentity = vi.fn(() => Promise.resolve(true))
  const fixture = createPtySupervisorFixture({
    provider,
    supervisor: { registerSessionIdentity },
  })
  const { host, root, spawn, spawnPty, supervisor } = fixture
  const artifact = {
    identity: 'codex-fork-artifact',
    environment: {},
    unsetEnvironment: [],
  }

  const initial = await spawn({
    provider,
    artifact,
    effectiveCapabilities: codexProvider.probe.effectiveCapabilities(
      'codex-cli 0.151.0',
    ),
    sessionId: 'codex-fork-terminal',
    launchMode: 'fork',
    parentHarnessSessionId: 'codex-fork-parent-id',
  })

  expect(initial).toMatchObject({
    id: 'codex-fork-terminal',
    resumed: false,
    harnessSessionId: undefined,
    identityStatus: 'discovering',
  })
  expect(snapshot).toHaveBeenCalledExactlyOnceWith(host, artifact)
  expect(snapshot.mock.invocationCallOrder[0]).toBeLessThan(
    spawnPty.mock.invocationCallOrder[0]!,
  )
  expect(spawnPty.mock.calls[0]?.[0].args?.[1]).toContain(
    "'fork' 'codex-fork-parent-id'",
  )
  expect(identify).toHaveBeenCalledWith(
    host,
    baseline,
    expect.objectContaining({ cwd: root, artifact }),
  )

  finishIdentification?.()
  await vi.waitFor(() =>
    expect(registerSessionIdentity).toHaveBeenCalledExactlyOnceWith(
      'codex-fork-terminal',
      'codex-fork-child-id',
    ),
  )
  expect(supervisor.get('codex-fork-terminal')).toMatchObject({
    harnessSessionId: 'codex-fork-child-id',
    identityStatus: 'identified',
  })
})

it('fails closed before PTY spawn without provider support and an exact parent', async () => {
  const fixture = createPtySupervisorFixture()
  await expect(
    fixture.spawn({ launchMode: 'fork' }),
  ).rejects.toThrow(/fork is not available/)
  expect(fixture.snapshot().spawns).toEqual([])
})

it('authorizes a fork only from the exact registered source identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-terminal-fork-'))
  const host = new LocalHost()
  await host.connect()
  onTestFinished(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const root = localPath(join(directory, 'project'))
  const registry = await TerminalSessionRegistry.load(
    host,
    localPath(join(directory, 'sessions.json')),
  )
  const providerId = asHarnessProviderId('claude-code')
  const profileId = asHarnessProfileId('claude-code-default')
  await registry.recordSpawn({
    id: 'fork-source',
    providerId,
    profileId,
    launchRevision: 3,
    harnessSessionId: 'parent-harness-id',
    workspaceRoot: root,
    cwd: root,
    title: 'Source',
    position: 0,
    active: true,
  })

  const request = {
    sourceId: 'fork-source',
    childId: 'fork-child',
    providerId,
    profileId,
    launchRevision: 3,
    parentHarnessSessionId: 'parent-harness-id',
    workspaceRoot: root,
    cwd: root,
  }
  expect(registry.authorizeFork(request)).toBe(true)
  expect(registry.authorizeFork({ ...request, launchRevision: 2 })).toBe(false)
  expect(
    registry.authorizeFork({ ...request, parentHarnessSessionId: 'another-parent' }),
  ).toBe(false)

  await registry.forget(root, 'fork-source')
  expect(registry.authorizeFork(request)).toBe(false)
})
