import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SkillagerProjectSetupOwner } from '../src/main/skillager/skillager-project-setup-owner'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { localPath } from '../src/shared/host-path'
import type { SkillagerProjectCliPort } from '../src/main/skillager/skillager-project-commands'
import type { SkillagerProjectTerminalPort } from '../src/main/skillager/skillager-project-terminal'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

const root = localPath('/workspace')
const selection = {
  executable: localPath('/tools/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.1',
  environment: { PRIVATE: 'not retained after handoff' },
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}
const request = {
  connectionId: 'connection',
  workspaceRoot: root,
  agent: 'codex' as const,
  requestId: 1,
}
const status = {
  projectRoot: root,
  agent: 'codex' as const,
  status: 'review-needed',
  canProceed: false,
  reviewNeeded: 1,
  lintBlocked: 0,
  working: 'missing' as const,
}

function fixture() {
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  let current = true
  const live = new Map<string, string>()
  const cli = {
    projectStatus: vi.fn<SkillagerProjectCliPort['projectStatus']>(() =>
      Promise.resolve(status),
    ),
    projectMetadata: vi.fn<SkillagerProjectCliPort['projectMetadata']>(() =>
      Promise.resolve({ rows: [], status }),
    ),
  } satisfies SkillagerProjectCliPort
  const terminal = {
    profile: () => builtInProfiles()[0]!,
    isRunning: (id, instance) => live.get(id) === instance,
    start: vi.fn<SkillagerProjectTerminalPort['start']>((_owner, setup) => {
      live.set(setup.sessionId, 'instance')
      return Promise.resolve({
        outcome: 'started',
        id: setup.sessionId,
        instanceId: 'instance',
        pid: 100,
        identityStatus: 'none',
        capabilities: {
          exactResume: false,
          sessionIdentity: 'none',
          contextPresentation: 'none',
        },
        resumed: false,
        reattached: false,
      })
    }),
  } satisfies SkillagerProjectTerminalPort
  const setup = new SkillagerProjectSetupOwner(cli, terminal, resources.scopes)
  const grant = {
    selection,
    assertCurrent: () => {
      if (!current) throw new SkillagerError('cancelled', 'Changed connection.')
    },
  }
  onTestFinished(() => setup.revoke())
  return {
    setup,
    cli,
    terminal,
    resources,
    owner,
    grant,
    live,
    revokeConnection: () => {
      current = false
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const dimensions = { cols: 100, rows: 30, position: 1 }

describe('one-use project setup authority', () => {
  it('retains exact local CLI/root/agent, validates public identity again at consume, and rejects reuse', async () => {
    const f = fixture(),
      prepared = await f.setup.prepare(f.owner, request, f.grant)
    expect(prepared).toMatchObject({
      projectRoot: root,
      agent: 'codex',
      executable: selection.executable,
    })
    expect(prepared).not.toHaveProperty('environment')
    expect(f.terminal.start).not.toHaveBeenCalled()
    await f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions })
    expect(f.cli.projectStatus).toHaveBeenCalledTimes(2)
    expect(f.terminal.start).toHaveBeenCalledExactlyOnceWith(
      f.owner,
      prepared,
      selection,
      { setupId: prepared.setupId, ...dimensions },
      expect.any(AbortSignal),
      expect.any(Function),
    )
    await expect(
      f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions }),
    ).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('blocks duplicate pending gestures and another live setup, preserving ordinary terminals through feature revocation', async () => {
    const f = fixture(),
      prepared = await f.setup.prepare(f.owner, request, f.grant)
    await expect(f.setup.prepare(f.owner, request, f.grant)).rejects.toMatchObject({
      reason: 'busy',
    })
    await expect(
      f.setup.prepare(
        { ...f.owner, generation: f.owner.generation + 1 },
        request,
        f.grant,
      ),
    ).rejects.toMatchObject({ reason: 'busy' })
    const launched = await f.setup.start(f.owner, {
      setupId: prepared.setupId,
      ...dimensions,
    })
    await f.setup.revoke(f.owner)
    expect(f.setup.isRunning(selection, request)).toBe(true)
    expect(f.live.get(launched.id)).toBe('instance')
    await expect(f.setup.prepare(f.owner, request, f.grant)).rejects.toMatchObject({
      reason: 'busy',
    })
    f.live.set(launched.id, 'ordinary-shell-restart')
    expect(f.setup.isRunning(selection, request)).toBe(false)
    await expect(f.setup.prepare(f.owner, request, f.grant)).resolves.toMatchObject({
      projectRoot: root,
    })
  })

  it('scopes running detection to exact catalog/root/agent and treats closure as ended', async () => {
    const f = fixture(),
      prepared = await f.setup.prepare(f.owner, request, f.grant)
    await f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions })
    expect(f.setup.isRunning(selection, { ...request, agent: 'claude' })).toBe(false)
    expect(
      f.setup.isRunning(selection, { ...request, workspaceRoot: localPath('/other') }),
    ).toBe(false)
    expect(
      f.setup.isRunning({ ...selection, catalog: localPath('/other-catalog') }, request),
    ).toBe(false)
    f.live.clear()
    expect(f.setup.isRunning(selection, request)).toBe(false)
  })

  it('rejects remote, other-renderer and stale-connection consumption without launching', async () => {
    const f = fixture()
    await expect(
      f.setup.prepare(
        f.owner,
        {
          ...request,
          workspaceRoot: { ...root, hostId: 'remote' as typeof root.hostId },
        },
        f.grant,
      ),
    ).rejects.toMatchObject({ reason: 'unavailable' })
    const prepared = await f.setup.prepare(f.owner, request, f.grant)
    await expect(
      f.setup.start(
        { ...f.owner, generation: f.owner.generation + 1 },
        {
          setupId: prepared.setupId,
          ...dimensions,
        },
      ),
    ).rejects.toMatchObject({ reason: 'cancelled' })
    f.revokeConnection()
    await expect(
      f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions }),
    ).rejects.toMatchObject({ reason: 'cancelled' })
    expect(f.terminal.start).not.toHaveBeenCalled()
  })

  it('keeps cancellation admitted until a delayed terminal handoff settles and rejects stale completion', async () => {
    const f = fixture(),
      prepared = await f.setup.prepare(f.owner, request, f.grant)
    const closed = deferred<void>(),
      entered = deferred<void>()
    vi.mocked(f.terminal.start).mockImplementation(
      async (_owner, _setup, _selection, _request, signal, assertCurrent) => {
        entered.resolve()
        await closed.promise
        expect(signal.aborted).toBe(true)
        assertCurrent()
        throw Error('Unreachable')
      },
    )
    const starting = f.setup.start(f.owner, {
      setupId: prepared.setupId,
      ...dimensions,
    })
    const failure = expect(starting).rejects.toMatchObject({ reason: 'cancelled' })
    await entered.promise
    let settled = false
    const revoked = f.setup.revoke(f.owner).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(f.setup.prepare(f.owner, request, f.grant)).rejects.toMatchObject({
      reason: 'busy',
    })
    closed.resolve()
    await failure
    await revoked
    expect(f.setup.isRunning(selection, request)).toBe(false)
  })

  it('does not start when fresh doctor identity fails and never falls back after a failed handoff', async () => {
    const f = fixture(),
      prepared = await f.setup.prepare(f.owner, request, f.grant)
    vi.mocked(f.cli.projectStatus).mockRejectedValueOnce(
      new SkillagerError('invalid-request', 'Different project.'),
    )
    await expect(
      f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions }),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.terminal.start).not.toHaveBeenCalled()
    await expect(
      f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions }),
    ).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('expires an unused launch grant and cancels its workspace lease', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(),
        prepared = await f.setup.prepare(f.owner, request, f.grant)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(
        f.setup.start(f.owner, { setupId: prepared.setupId, ...dimensions }),
      ).rejects.toMatchObject({ reason: 'cancelled' })
      expect(f.terminal.start).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
