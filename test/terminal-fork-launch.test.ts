import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, onTestFinished, vi } from 'vitest'

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
