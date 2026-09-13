import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createSkillagerProjectTerminal } from '../src/main/skillager/skillager-project-terminal'
import { builtInProfiles } from '../src/main/harness/harness-profile-store'
import { plainShellProvider } from '../src/main/harness/harness-provider'
import { localPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  createPtySupervisorFixture,
  TestPtyProcess,
} from './fixtures/pty-supervisor-fixture'
import type { RecordTerminalSpawn } from '../src/main/terminal/session-registry'

function fixture() {
  const ptys = createPtySupervisorFixture({ provider: plainShellProvider })
  const { spawnPty: hostSpawn } = ptys
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const profile = builtInProfiles()[0]!
  const sessions = {
    recordSpawn: vi.fn<(_record: RecordTerminalSpawn) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    forget: vi.fn(() => Promise.resolve()),
  }
  const terminal = createSkillagerProjectTerminal(
    ptys.host,
    {
      ptySupervisor: ptys.supervisor,
      rendererResources: resources.scopes,
      profiles: { get: () => profile },
      sessions,
    },
    () => sender,
  )
  const selected = {
    executable: localPath("/tools/skillager's $(not-code)"),
    catalog: localPath('/private catalog'),
    environment: { HOME: '/cli-home', PATH: '/cli-bin', XDG_STATE_HOME: '/cli-state' },
    version: 'skillager 0.9.1',
  }
  const setup = {
    setupId: 'setup-id',
    sessionId: 'setup-terminal',
    projectRoot: ptys.root,
    agent: 'codex' as const,
    executable: selected.executable,
    profile,
  }
  const request = { setupId: setup.setupId, cols: 80, rows: 24, position: 1 }
  const sender = {
    isDestroyed: () => false,
    mainFrame: { isDestroyed: () => false, postMessage: vi.fn() },
  } as unknown as WebContents
  const controller = new AbortController()
  const start = () =>
    terminal.start(owner, setup, selected, request, controller.signal, () =>
      resources.scopes.assertCurrent(owner),
    )
  return {
    ptys,
    hostSpawn,
    resources,
    owner,
    sessions,
    terminal,
    selected,
    setup,
    request,
    sender,
    controller,
    start,
  }
}

describe('project setup through the ordinary terminal transaction', () => {
  it('launches exact argv/environment in a fresh local terminal and persists only ordinary shell recovery identity', async () => {
    const f = fixture()
    await f.ptys.spawn({
      ownerId: f.owner.id,
      ownerGeneration: f.owner.generation,
      sessionId: 'existing-terminal',
    })
    const setupPty = new TestPtyProcess()
    f.hostSpawn.mockResolvedValueOnce(setupPty)
    const response = await f.start()
    expect(f.hostSpawn).toHaveBeenLastCalledWith({
      file: f.selected.executable.path,
      args: ['--catalog-state-dir', '/private catalog', 'setup', '--agent', 'codex'],
      cwd: f.ptys.root,
      cols: 80,
      rows: 24,
      unsetEnv: undefined,
      env: {
        ...f.selected.environment,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'hvir',
      },
    })
    expect(f.ptys.pty.write).not.toHaveBeenCalled()
    expect(f.ptys.pty.kill).not.toHaveBeenCalled()
    expect(f.sessions.recordSpawn).toHaveBeenCalledExactlyOnceWith({
      id: 'setup-terminal',
      providerId: f.setup.profile.providerId,
      profileId: f.setup.profile.id,
      launchRevision: f.setup.profile.launchRevision,
      workspaceRoot: f.ptys.root,
      cwd: f.ptys.root,
      title: 'Skillager setup',
      position: 1,
      active: true,
    })
    expect(JSON.stringify(f.sessions.recordSpawn.mock.calls)).not.toContain('catalog')
    f.controller.abort()
    expect(setupPty.kill).not.toHaveBeenCalled()
    expect(f.terminal.isRunning(response.id, response.instanceId)).toBe(true)
    setupPty.emitExit({ exitCode: 0, signal: undefined })
    expect(f.terminal.isRunning(response.id, response.instanceId)).toBe(false)
  })

  it('awaits a delayed host spawn after cancellation, kills that eventual PTY and never attaches or persists it', async () => {
    const f = fixture(),
      delayed = f.ptys.deferNextSpawn()
    const starting = f.start()
    const failed = expect(starting).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(f.hostSpawn).toHaveBeenCalledOnce())
    let settled = false
    void starting.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    f.controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    delayed.resolve()
    await failed
    expect(delayed.pty.kill).toHaveBeenCalledOnce()
    expect(f.ptys.supervisor.get('setup-terminal')).toBeUndefined()
    expect(f.sessions.recordSpawn).not.toHaveBeenCalled()
    expect(f.sessions.forget).toHaveBeenCalledExactlyOnceWith(
      f.ptys.root,
      'setup-terminal',
    )
  })

  it('cleans an attached PTY when the awaited persistence boundary loses authority', async () => {
    const f = fixture(),
      recorded = f.resources.deferredCleanup()
    f.sessions.recordSpawn.mockReturnValueOnce(recorded.promise)
    const starting = f.start(),
      failed = expect(starting).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(f.sessions.recordSpawn).toHaveBeenCalledOnce())
    try {
      f.controller.abort()
      await vi.waitFor(() => expect(f.ptys.pty.kill).toHaveBeenCalledOnce())
    } finally {
      recorded.resolve()
    }
    await failed
    expect(f.ptys.pty.dataListeners.size).toBe(0)
    expect(f.ptys.supervisor.get('setup-terminal')).toBeUndefined()
    expect(f.sessions.forget).toHaveBeenCalledOnce()
  })

  it('refuses invalid dimensions and remote destinations without spawning any fallback', async () => {
    const f = fixture()
    await expect(
      f.terminal.start(
        f.owner,
        f.setup,
        f.selected,
        { ...f.request, cols: NaN },
        f.controller.signal,
        () => {},
      ),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    await expect(
      f.terminal.start(
        f.owner,
        { ...f.setup, projectRoot: f.resources.sshRoot },
        f.selected,
        f.request,
        f.controller.signal,
        () => {},
      ),
    ).rejects.toMatchObject({ reason: 'invalid-request' })
    expect(f.hostSpawn).not.toHaveBeenCalled()
  })
})
