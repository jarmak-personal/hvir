import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import type { ProjectHost } from '../src/main/project-host'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  isHarnessProfileId,
  localPath,
} from '../src/shared'

const SESSION_ID = 'terminal-1'
const HARNESS_ID = '019ab123-4567-7890-abcd-ef0123456789'
const SHELL_PROVIDER_ID = asHarnessProviderId('plain-shell')
const CLAUDE_PROVIDER_ID = asHarnessProviderId('claude-code')
const CODEX_PROVIDER_ID = asHarnessProviderId('codex')
const SHELL_PROFILE_ID = asHarnessProfileId('plain-shell-default')
const CLAUDE_PROFILE_ID = asHarnessProfileId('claude-code-default')
const CODEX_PROFILE_ID = asHarnessProfileId('codex-default')

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
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
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
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
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
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
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
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: undefined,
        title: 'Codex · project',
      }),
    ])
    expect(
      restored.authorizeResume({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(false)
  })

  it('persists plain shell layout without claiming resumable process state', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
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
        providerId: SHELL_PROVIDER_ID,
        profileId: SHELL_PROFILE_ID,
        launchRevision: 1,
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
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
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
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })

    expect(registry.list(root)).toEqual([])
  })

  it('authorizes only the stored project, cwd, provider, and harness id', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Claude Code · project',
      position: 0,
      active: true,
    })

    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: localPath('/tmp/other'),
        cwd: root,
      }),
    ).toBe(false)

    await registry.forget(root, SESSION_ID)
    expect(registry.list(root)).toEqual([])
  })

  it('atomically replaces a retained recovery record with new identities', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 2,
      active: true,
    })

    expect(
      registry.authorizeReplacement({
        replacedId: SESSION_ID,
        replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    await registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: replacementId,
        workspaceRoot: root,
        cwd: root,
        title: 'Retained conversation',
        position: 2,
        active: true,
      },
    })

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: replacementId,
        harnessSessionId: replacementId,
        position: 2,
        active: true,
      }),
    ])
    await registry.recordIdentity(SESSION_ID, HARNESS_ID)
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Late source callback',
      position: 0,
      active: false,
    })
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({ id: replacementId, harnessSessionId: replacementId }),
    ])
  })

  it('consumes a discovered replacement identity that arrives before commit', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    const replacementHarnessId = '019ab123-4567-7890-abcd-ef0123456790'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Codex · project',
      position: 0,
      active: true,
    })
    await registry.recordIdentity(replacementId, replacementHarnessId)

    await registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
        title: 'Codex · project',
        position: 0,
        active: true,
      },
    })

    expect(registry.list(root)).toEqual([
      expect.objectContaining({
        id: replacementId,
        harnessSessionId: replacementHarnessId,
      }),
    ])
  })

  it('rolls a replacement back when its durable commit fails', async () => {
    const root = localPath('/tmp/project')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 0,
      active: true,
    })
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      registry.recordReplacement({
        replacedId: SESSION_ID,
        spawn: {
          id: 'terminal-2',
          providerId: CLAUDE_PROVIDER_ID,
          profileId: CLAUDE_PROFILE_ID,
          launchRevision: 1,
          harnessSessionId: 'terminal-2',
          workspaceRoot: root,
          cwd: root,
          title: 'Retained conversation',
          position: 0,
          active: true,
        },
      }),
    ).rejects.toThrow('disk unavailable')

    expect(registry.list(root)).toEqual([
      expect.objectContaining({ id: SESSION_ID, harnessSessionId: HARNESS_ID }),
    ])
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({ id: SESSION_ID, harnessSessionId: HARNESS_ID }),
    ])
  })

  it('does not commit a replacement cancelled while persistence is pending', async () => {
    const root = localPath('/tmp/project')
    const replacementId = 'terminal-2'
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Retained conversation',
      position: 0,
      active: true,
    })
    let releaseWrite: (() => void) | undefined
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const write = vi.spyOn(host, 'writeFile').mockReturnValueOnce(pendingWrite)
    const replacement = registry.recordReplacement({
      replacedId: SESSION_ID,
      spawn: {
        id: replacementId,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: replacementId,
        workspaceRoot: root,
        cwd: root,
        title: 'Retained conversation',
        position: 0,
        active: true,
      },
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalled())

    const forgetReplacement = registry.forget(root, replacementId)
    const forgetSource = registry.forget(root, SESSION_ID)
    releaseWrite?.()

    await expect(replacement).rejects.toThrow('cancelled')
    await Promise.all([forgetReplacement, forgetSource])
    expect(registry.list(root)).toEqual([])
    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([])
  })

  it('moves workspace ownership while preserving immutable launch and recovery context', async () => {
    const sourceRoot = localPath('/tmp/project')
    const targetRoot = localPath('/tmp/project-worktree')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: sourceRoot,
      cwd: sourceRoot,
      title: 'Claude Code · project',
      position: 0,
      active: true,
    })

    await registry.move({ id: SESSION_ID, sourceRoot, targetRoot })
    expect(registry.list(sourceRoot)).toEqual([])
    expect(registry.list(targetRoot)).toEqual([
      expect.objectContaining({ id: SESSION_ID, cwd: sourceRoot }),
    ])
    await registry.flush()

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.get(SESSION_ID)).toEqual(
      expect.objectContaining({ workspaceRoot: targetRoot, cwd: sourceRoot }),
    )
    expect(
      restored.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: targetRoot,
        cwd: sourceRoot,
      }),
    ).toBe(true)
    expect(
      restored.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: CLAUDE_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: targetRoot,
        cwd: targetRoot,
      }),
    ).toBe(false)
  })

  it('rolls workspace ownership back when move persistence fails', async () => {
    const sourceRoot = localPath('/tmp/project')
    const targetRoot = localPath('/tmp/project-worktree')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: SHELL_PROVIDER_ID,
      profileId: SHELL_PROFILE_ID,
      launchRevision: 1,
      workspaceRoot: sourceRoot,
      cwd: sourceRoot,
      title: 'Shell · project',
      position: 0,
      active: true,
    })
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      registry.move({ id: SESSION_ID, sourceRoot, targetRoot }),
    ).rejects.toThrow('disk unavailable')
    expect(registry.list(sourceRoot)).toEqual([
      expect.objectContaining({ id: SESSION_ID, cwd: sourceRoot }),
    ])
    expect(registry.list(targetRoot)).toEqual([])
  })

  it('rebinds recovery only within the same provider and revision', async () => {
    const root = localPath('/tmp/project')
    const alternate = asHarnessProfileId('claude-bypass')
    await registry.recordSpawn({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: CLAUDE_PROFILE_ID,
      launchRevision: 1,
      harnessSessionId: HARNESS_ID,
      workspaceRoot: root,
      cwd: root,
      title: 'Claude Code · project',
      position: 0,
      active: true,
    })

    const rebound = await registry.rebindProfile({
      id: SESSION_ID,
      providerId: CLAUDE_PROVIDER_ID,
      profileId: alternate,
      launchRevision: 4,
      riskAcknowledgedRevision: 4,
      workspaceRoot: root,
    })
    expect(rebound).toMatchObject({
      profileId: alternate,
      launchRevision: 4,
      riskAcknowledgedRevision: 4,
      harnessSessionId: HARNESS_ID,
    })
    expect(
      registry.authorizeResume({
        id: SESSION_ID,
        providerId: CLAUDE_PROVIDER_ID,
        profileId: alternate,
        launchRevision: 4,
        harnessSessionId: HARNESS_ID,
        workspaceRoot: root,
        cwd: root,
      }),
    ).toBe(true)
    await expect(
      registry.rebindProfile({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
      }),
    ).rejects.toThrow(/same provider/)
  })

  it('migrates v1 adapter records to current profile records without changing identity', async () => {
    const root = localPath('/tmp/project')
    await host.writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: SESSION_ID,
            adapterId: 'codex',
            harnessSessionId: HARNESS_ID,
            hostId: root.hostId,
            workspaceRoot: root,
            cwd: root,
            title: 'Codex · project',
            position: 0,
            active: true,
            updatedAt: 42,
          },
        ],
      }),
    )

    const migrated = await TerminalSessionRegistry.load(host, file)
    expect(migrated.list(root)).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        harnessSessionId: HARNESS_ID,
      }),
    ])
    expect(JSON.parse(await host.readTextFile(file))).toEqual(
      expect.objectContaining({
        version: 4,
        sessions: [
          expect.objectContaining({
            providerId: 'codex',
            harnessSessionId: HARNESS_ID,
          }),
        ],
      }),
    )
    expect(await host.readTextFile(file)).not.toContain('"adapterId"')
    expect(migrated.profileReferences()).toContainEqual({
      providerId: CODEX_PROVIDER_ID,
      profileId: CODEX_PROFILE_ID,
      launchRevision: 1,
    })
  })

  it('preserves a syntactically valid provider record unknown to this build', async () => {
    const root = localPath('/tmp/project')
    await host.writeFile(
      file,
      JSON.stringify({
        version: 2,
        sessions: [
          {
            id: SESSION_ID,
            providerId: 'future-harness',
            harnessSessionId: HARNESS_ID,
            hostId: root.hostId,
            workspaceRoot: root,
            cwd: root,
            title: 'Future harness',
            position: 0,
            active: true,
            updatedAt: 42,
          },
        ],
      }),
    )

    const restored = await TerminalSessionRegistry.load(host, file)
    expect(restored.list(root)).toEqual([
      expect.objectContaining({
        providerId: 'future-harness',
        harnessSessionId: HARNESS_ID,
      }),
    ])
  })

  it('gives long unknown legacy providers a valid stable profile id', async () => {
    const root = localPath('/tmp/project')
    const providerId = asHarnessProviderId(`${'a'.repeat(72)}-z`)
    await host.writeFile(
      file,
      JSON.stringify({
        version: 2,
        sessions: [
          {
            id: SESSION_ID,
            providerId,
            harnessSessionId: HARNESS_ID,
            hostId: root.hostId,
            workspaceRoot: root,
            cwd: root,
            title: 'Future long harness',
            position: 0,
            active: true,
            updatedAt: 42,
          },
        ],
      }),
    )

    const restored = await TerminalSessionRegistry.load(host, file)
    const session = restored.list(root)[0]
    expect(session?.providerId).toBe(providerId)
    expect(session?.profileId).toMatch(/^legacy-/)
    expect(session?.profileId.length).toBeLessThanOrEqual(80)
    expect(isHarnessProfileId(session?.profileId)).toBe(true)
    expect(session?.harnessSessionId).toBe(HARNESS_ID)
  })

  it('classifies session-registry read and parse failures without error content', async () => {
    const events: unknown[] = []
    const unreadable = {
      readTextFile: () =>
        Promise.reject(
          Object.assign(new Error('/secret/path TOKEN=hvir-private'), {
            code: 'EACCES',
          }),
        ),
    } as unknown as ProjectHost

    await TerminalSessionRegistry.load(unreadable, file, (event) => events.push(event))
    await host.writeFile(file, '{TOKEN=hvir-private')
    await TerminalSessionRegistry.load(host, file, (event) => events.push(event))

    expect(events).toEqual([
      { kind: 'load-failed', reason: 'read-failed' },
      { kind: 'load-failed', reason: 'invalid-json' },
    ])
    expect(JSON.stringify(events)).not.toMatch(/secret|TOKEN|EACCES/)
  })

  it('reports persistence failure without letting diagnostics replace the error', async () => {
    const events: unknown[] = []
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const failingHost = {
      readTextFile: () => Promise.reject(missing),
      writeFile: () => Promise.reject(new Error('/secret/path TOKEN=hvir-private')),
    } as unknown as ProjectHost
    const failingRegistry = await TerminalSessionRegistry.load(
      failingHost,
      file,
      (event) => events.push(event),
    )
    const root = localPath('/tmp/project')

    await expect(
      failingRegistry.recordSpawn({
        id: SESSION_ID,
        providerId: CODEX_PROVIDER_ID,
        profileId: CODEX_PROFILE_ID,
        launchRevision: 1,
        workspaceRoot: root,
        cwd: root,
        title: 'Codex',
        position: 0,
        active: true,
      }),
    ).rejects.toThrow('TOKEN=hvir-private')
    expect(events).toEqual([{ kind: 'persist-failed' }])
  })

  it('ignores a failing session-registry diagnostics observer', async () => {
    await host.writeFile(file, '{invalid')

    await expect(
      TerminalSessionRegistry.load(host, file, () => {
        throw new Error('diagnostics sink failed')
      }),
    ).resolves.toBeInstanceOf(TerminalSessionRegistry)
  })
})
