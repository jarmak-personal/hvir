import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import { localPath } from '../src/shared'

const SESSION_ID = 'terminal-1'
const HARNESS_ID = '019ab123-4567-7890-abcd-ef0123456789'

describe('TerminalSessionRegistry', () => {
  let directory: string
  let host: LocalHost
  let file: ReturnType<typeof localPath>
  let registry: TerminalSessionRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-terminal-registry-'))
    host = new LocalHost()
    await host.connect()
    file = localPath(join(directory, 'terminal-sessions.json'))
    registry = await TerminalSessionRegistry.load(host, file)
  })

  afterEach(async () => {
    await registry.flush().catch(() => undefined)
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('persists an exact discovered identity with its rail position and title', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'codex',
      projectRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.updateLayout(root, [
      { id: SESSION_ID, title: 'Review recovery flow', position: 2, active: true },
    ])
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        adapterId: 'codex',
        harnessSessionId: HARNESS_ID,
        cwd: root,
        title: 'Review recovery flow',
        position: 2,
        active: true,
      }),
    ])
  })

  it('retains provisional harness layout without authorizing resume', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'codex',
      projectRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        adapterId: 'codex',
        harnessSessionId: undefined,
        title: 'Codex · project',
      }),
    ])
    expect(
      restored.authorizeResume({
        id: SESSION_ID,
        adapterId: 'codex',
        harnessSessionId: HARNESS_ID,
        projectRoot: root,
        cwd: root,
      }),
    ).toBe(false)
  })

  it('persists plain shell layout without claiming resumable process state', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'plain-shell',
      projectRoot: root,
      cwd: root,
      title: 'Shell · project',
      position: 1,
      active: false,
    })
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        adapterId: 'plain-shell',
        harnessSessionId: undefined,
        title: 'Shell · project',
        position: 1,
        active: false,
      }),
    ])
  })

  it('reconciles identity discovery that wins the spawn-persistence race', async () => {
    const root = localPath('/tmp/project')
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'codex',
      projectRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        harnessSessionId: HARNESS_ID,
      }),
    ])
  })

  it('does not resurrect a session closed while spawn persistence is pending', async () => {
    const root = localPath('/tmp/project')
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.forget(root, SESSION_ID)
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'codex',
      projectRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })

    expect(registry.list(root)).toEqual([])
  })

  it('authorizes only the stored project, cwd, adapter, and harness id', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      adapterId: 'claude-code',
      harnessSessionId: HARNESS_ID,
      projectRoot: root,
      cwd: root,
      title: 'Claude Code · project',
      position: 0,
      active: true,
    })

    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        adapterId: 'claude-code',
        harnessSessionId: HARNESS_ID,
        projectRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        adapterId: 'claude-code',
        harnessSessionId: HARNESS_ID,
        projectRoot: localPath('/tmp/other'),
        cwd: root,
      }),
    ).toBe(false)

    await registry.forget(root, SESSION_ID)
    expect(registry.list(root)).toEqual([])
  })
})
