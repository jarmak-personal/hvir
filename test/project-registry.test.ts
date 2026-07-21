import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProjectRegistry,
  RendererSshPrompter,
  identityFileCandidates,
} from '../src/main/project-registry'
import { asHostId, hostPath, localPath } from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ProjectRegistry session flow', () => {
  it('cancels first-run selection without inventing a cwd project', async () => {
    const metadata = await mkdtemp(join(tmpdir(), 'hvir-registry-empty-'))
    cleanups.push(metadata)
    const select = vi.fn(() => Promise.resolve(undefined))

    const registry = await ProjectRegistry.create(
      undefined,
      { prompt: () => Promise.resolve(undefined) },
      join(metadata, 'known-hosts.json'),
      join(metadata, 'projects.json'),
      () => undefined,
      select,
    )

    expect(registry).toBeUndefined()
    expect(select).toHaveBeenCalledOnce()
  })

  it('restores history without prompting and lets an explicit root override it', async () => {
    const metadata = await mkdtemp(join(tmpdir(), 'hvir-registry-precedence-'))
    const first = join(metadata, 'first')
    const second = join(metadata, 'second')
    await mkdir(first)
    await mkdir(second)
    cleanups.push(metadata)
    const registryFile = join(metadata, 'projects.json')
    const trustFile = join(metadata, 'known-hosts.json')
    const initial = await ProjectRegistry.create(
      localPath(first),
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )
    await initial.open('local', second)
    await initial.dispose()

    const select = vi.fn(() => Promise.resolve(localPath(metadata)))
    const restored = await ProjectRegistry.create(
      undefined,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
      select,
    )
    expect(restored?.state().root.path).toBe(await realpath(second))
    expect(select).not.toHaveBeenCalled()
    await restored?.dispose()

    const explicit = await ProjectRegistry.create(
      localPath(first),
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )
    expect(explicit.state().root.path).toBe(await realpath(first))
    expect(explicit.state().projects).toHaveLength(2)
    await explicit.dispose()
  })

  it('opens an explicitly requested persisted worktree without duplicating its project', async () => {
    const metadata = await mkdtemp(join(tmpdir(), 'hvir-registry-worktree-root-'))
    const root = join(metadata, 'project')
    const linked = join(metadata, 'linked')
    await mkdir(root)
    await mkdir(linked)
    cleanups.push(metadata)
    const canonicalRoot = localPath(await realpath(root))
    const canonicalLinked = localPath(await realpath(linked))
    const registryFile = join(metadata, 'projects.json')
    const trustFile = join(metadata, 'known-hosts.json')
    const initial = await ProjectRegistry.create(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )
    await initial.reconcileWorktrees(initial.state().activeProjectId, {
      repository: true,
      worktrees: [
        { root: canonicalRoot, branch: 'main', detached: false, bare: false },
        { root: canonicalLinked, branch: 'feature', detached: false, bare: false },
      ],
    })
    await initial.dispose()

    const restored = await ProjectRegistry.create(
      canonicalLinked,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )

    expect(restored.state().root).toEqual(canonicalLinked)
    expect(restored.state().projects).toHaveLength(1)
    await restored.dispose()
  })

  it('uses configured identities without adding OpenSSH defaults', () => {
    expect(
      identityFileCandidates(
        {
          alias: 'example',
          hostname: 'example.test',
          user: 'picard',
          port: 22,
          identityFiles: ['/home/test/custom', '/home/test/custom'],
        },
        '/home/test',
      ),
    ).toEqual(['/home/test/custom'])
  })

  it('loads conventional OpenSSH identities when none are configured', () => {
    expect(
      identityFileCandidates(
        {
          alias: 'example',
          hostname: 'example.test',
          user: 'picard',
          port: 22,
          identityFiles: [],
        },
        '/home/test',
      ),
    ).toEqual([
      '/home/test/.ssh/id_rsa',
      '/home/test/.ssh/id_ecdsa',
      '/home/test/.ssh/id_ecdsa_sk',
      '/home/test/.ssh/id_ed25519',
      '/home/test/.ssh/id_ed25519_sk',
      '/home/test/.ssh/id_xmss',
      '/home/test/.ssh/id_dsa',
    ])
  })

  it('connects before browsing and opens a selected local folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const canonicalRoot = await realpath(root)
    cleanups.push(root)
    await mkdir(join(root, 'alpha'))
    await mkdir(join(root, 'zeta'))
    await writeFile(join(root, 'file.txt'), 'not a folder')
    const states: string[] = []
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      (state) => states.push(state.root.path),
    )

    const connected = await registry.connectHost('local')
    expect(connected.host.connectionState).toBe('connected')
    expect(connected.suggestedPath).toBe(canonicalRoot)

    const listing = await registry.browseHost('local', root)
    expect(listing.directories.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
    await expect(registry.browseHost('local', join(root, 'missing'))).rejects.toThrow(
      `Folder not found: ${join(root, 'missing')}`,
    )

    const opened = await registry.open('local', join(root, 'alpha'))
    expect(opened.root.path).toBe(join(canonicalRoot, 'alpha'))
    expect(states).toEqual([join(canonicalRoot, 'alpha')])
    await registry.dispose()
  })

  it('closes a registered project, activates a neighbor, and keeps one project open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-close-'))
    const second = join(root, 'second')
    await mkdir(second)
    const canonicalRoot = await realpath(root)
    const canonicalSecond = await realpath(second)
    const projectsFile = join(root, 'projects.json')
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    const firstProjectId = registry.state().activeProjectId
    const opened = await registry.open('local', second)
    const secondProjectId = opened.activeProjectId

    const closed = await registry.closeProject(secondProjectId)
    expect(closed.projects.map((project) => project.id)).toEqual([firstProjectId])
    expect(closed.activeProjectId).toBe(firstProjectId)
    expect(closed.root.path).toBe(canonicalRoot)
    expect(closed.projects[0]?.registeredRoot.path).not.toBe(canonicalSecond)
    await expect(registry.closeProject(firstProjectId)).rejects.toThrow(
      'hvir must keep one project open',
    )
    await registry.dispose()

    const restored = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    expect(restored.state().projects).toHaveLength(1)
    expect(restored.state().activeProjectId).toBe(firstProjectId)
    await restored.dispose()
  })

  it('rejects browsing a host that has not connected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      () => undefined,
    )

    await expect(registry.browseHost('missing', '/')).rejects.toThrow(
      'Connect to missing before browsing folders',
    )
    await registry.dispose()
  })

  it('does not allow the local host to disconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      () => undefined,
    )

    await expect(registry.disconnectHost('local')).rejects.toThrow(
      'The local host cannot disconnect',
    )
    await registry.dispose()
  })

  it('authorizes persisted workspace roots without instantiating their SSH host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const canonicalRoot = await realpath(root)
    const projectsFile = join(root, 'projects.json')
    cleanups.push(root)
    await writeFile(
      projectsFile,
      JSON.stringify({
        version: 1,
        activeProjectId: `project:local:${canonicalRoot}`,
        projects: [
          {
            hostId: 'local',
            path: canonicalRoot,
            displayName: 'local',
            activeWorkspacePath: canonicalRoot,
            workspaces: [
              {
                path: canonicalRoot,
                main: true,
                missing: false,
                repository: false,
                changedFiles: 0,
              },
            ],
          },
          {
            hostId: 'example',
            path: '/srv/repo',
            displayName: 'remote',
            activeWorkspacePath: '/srv/repo-linked',
            workspaces: [
              {
                path: '/srv/repo-linked',
                branch: 'feature',
                main: false,
                missing: false,
                repository: true,
                changedFiles: 0,
              },
            ],
          },
        ],
      }),
    )
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    const remoteRoot = hostPath(asHostId('example'), '/srv/repo-linked')

    expect(registry.hostById('example')).toBeUndefined()
    expect(registry.registeredWorkspaceRoot(remoteRoot)).toEqual(remoteRoot)
    expect(
      registry.registeredWorkspaceRoot(
        hostPath(asHostId('example'), '/srv/repo-linked/nested'),
      ),
    ).toBeUndefined()
    await registry.dispose()
  })

  it('persists registered projects and preserves removed worktrees until dismissal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const linked = join(root, 'linked')
    await mkdir(linked)
    const canonicalRoot = await realpath(root)
    const canonicalLinked = await realpath(linked)
    cleanups.push(root)
    const projectsFile = join(root, 'projects.json')
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    const projectId = registry.state().activeProjectId
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: localPath(canonicalRoot), branch: 'main', detached: false, bare: false },
        {
          root: localPath(canonicalLinked),
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    const linkedId = registry
      .projectById(projectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalLinked)!.id
    await registry.activate(projectId, linkedId)
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        {
          root: localPath(canonicalRoot),
          branch: 'main',
          detached: false,
          bare: false,
        },
      ],
    })

    expect(registry.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: linkedId, missing: true, branch: 'feature' }),
      ]),
    )
    await registry.dispose()

    const restored = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    expect(restored.state().activeWorkspaceId).not.toBe(linkedId)
    expect(restored.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: linkedId, missing: true })]),
    )
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: localPath(canonicalRoot), branch: 'main', detached: false, bare: false },
        {
          root: localPath(canonicalLinked),
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    await expect(restored.activate(projectId, linkedId)).resolves.toMatchObject({
      activeWorkspaceId: linkedId,
      root: localPath(canonicalLinked),
    })
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: localPath(canonicalRoot), branch: 'main', detached: false, bare: false },
      ],
    })
    await restored.dismissWorkspace(projectId, linkedId)
    expect(restored.projectById(projectId)?.workspaces).toHaveLength(1)
    expect(restored.state().root.path).toBe(await realpath(root))
    await restored.dispose()
  })

  it('persists newly discovered worktrees until they are acknowledged or opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-discovery-'))
    const linked = join(root, 'linked')
    const later = join(root, 'later')
    const opened = join(root, 'opened')
    await Promise.all([mkdir(linked), mkdir(later), mkdir(opened)])
    const canonicalRoot = localPath(await realpath(root))
    const canonicalLinked = localPath(await realpath(linked))
    const canonicalLater = localPath(await realpath(later))
    const canonicalOpened = localPath(await realpath(opened))
    const projectsFile = join(root, 'projects.json')
    const trustFile = join(root, 'known-hosts.json')
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      projectsFile,
      () => undefined,
    )
    const projectId = registry.state().activeProjectId

    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: canonicalRoot, branch: 'main', detached: false, bare: false },
        { root: canonicalLinked, branch: 'linked', detached: false, bare: false },
      ],
    })
    expect(registry.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ root: canonicalLinked, newlyDiscovered: false }),
      ]),
    )

    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: canonicalRoot, branch: 'main', detached: false, bare: false },
        { root: canonicalLinked, branch: 'linked', detached: false, bare: false },
        { root: canonicalLater, branch: 'later', detached: false, bare: false },
      ],
    })
    const laterId = registry
      .projectById(projectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalLater.path)!.id
    expect(registry.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: laterId, newlyDiscovered: true }),
      ]),
    )
    await registry.dispose()

    const restored = await ProjectRegistry.create(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      projectsFile,
      () => undefined,
    )
    expect(restored.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: laterId, newlyDiscovered: true }),
      ]),
    )
    await restored.acknowledgeWorkspace(projectId, laterId)
    expect(
      restored
        .projectById(projectId)
        ?.workspaces.find((workspace) => workspace.id === laterId)?.newlyDiscovered,
    ).toBe(false)

    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: canonicalRoot, branch: 'main', detached: false, bare: false },
        { root: canonicalLinked, branch: 'linked', detached: false, bare: false },
        { root: canonicalLater, branch: 'later', detached: false, bare: false },
        { root: canonicalOpened, branch: 'opened', detached: false, bare: false },
      ],
    })
    const openedId = restored
      .projectById(projectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalOpened.path)!.id
    expect(
      restored
        .projectById(projectId)
        ?.workspaces.find((workspace) => workspace.id === openedId)?.newlyDiscovered,
    ).toBe(true)
    await restored.activate(projectId, openedId)
    expect(
      restored
        .projectById(projectId)
        ?.workspaces.find((workspace) => workspace.id === openedId)?.newlyDiscovered,
    ).toBe(false)
    await restored.dispose()
  })

  it('clears stale Git counts when a project becomes a plain directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-plain-'))
    const canonicalRoot = localPath(await realpath(root))
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      () => undefined,
    )
    const projectId = registry.state().activeProjectId
    const workspaceId = registry.state().activeWorkspaceId
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [{ root: canonicalRoot, branch: 'main', detached: false, bare: false }],
    })
    await registry.updateChangedCounts(projectId, new Map([[workspaceId, 12]]))

    await registry.reconcileWorktrees(projectId, {
      repository: false,
      worktrees: [{ root: canonicalRoot, detached: false, bare: false }],
    })

    expect(registry.projectById(projectId)?.workspaces[0]).toMatchObject({
      repository: false,
      changedFiles: 0,
    })
    await registry.dispose()
  })

  it('persists Git prunable reasons and clears them when a worktree recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-prunable-'))
    const canonicalRoot = await realpath(root)
    const staleRoot = localPath(`${canonicalRoot}-stale`)
    const projectsFile = join(root, 'projects.json')
    cleanups.push(root)
    const registry = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    const projectId = registry.state().activeProjectId
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: localPath(canonicalRoot), branch: 'main', detached: false, bare: false },
        {
          root: staleRoot,
          head: '0123456789012345678901234567890123456789',
          detached: true,
          bare: false,
          prunable: true,
          prunableReason: 'gitdir file points to non-existent location',
        },
      ],
    })
    expect(registry.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: staleRoot,
          missing: true,
          prunableReason: 'gitdir file points to non-existent location',
        }),
      ]),
    )
    await registry.dispose()

    const restored = await ProjectRegistry.create(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    expect(restored.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: staleRoot,
          prunableReason: 'gitdir file points to non-existent location',
        }),
      ]),
    )
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: localPath(canonicalRoot), branch: 'main', detached: false, bare: false },
        { root: staleRoot, branch: 'repaired', detached: false, bare: false },
      ],
    })
    expect(restored.projectById(projectId)?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: staleRoot,
          missing: false,
          branch: 'repaired',
        }),
      ]),
    )
    expect(
      restored
        .projectById(projectId)
        ?.workspaces.find((workspace) => workspace.root.path === staleRoot.path)
        ?.prunableReason,
    ).toBeUndefined()
    await restored.dispose()
  })
})

describe('RendererSshPrompter', () => {
  it('keeps concurrent prompts independently addressable and cancels by host', async () => {
    const emitted: { id: number; hostId: string }[] = []
    const cancelled: string[] = []
    const prompter = new RendererSshPrompter(
      (_owner, prompt) => emitted.push(prompt),
      (_owner, hostId) => cancelled.push(hostId),
    )
    const owner = { id: 7, generation: 1 }
    prompter.activateOwner(owner)
    const first = prompter.runForOwner(owner, () =>
      prompter.prompt({
        hostId: 'alpha',
        kind: 'password',
        title: 'Alpha',
        prompts: [],
      }),
    )
    const second = prompter.runForOwner(owner, () =>
      prompter.prompt({
        hostId: 'beta',
        kind: 'password',
        title: 'Beta',
        prompts: [],
      }),
    )

    expect(emitted).toEqual([
      expect.objectContaining({ id: 1, hostId: 'alpha' }),
      expect.objectContaining({ id: 2, hostId: 'beta' }),
    ])
    prompter.cancelHost('alpha')
    prompter.respond(owner, 2, ['secret'])
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toEqual(['secret'])
    expect(cancelled).toEqual(['alpha'])
  })

  it('moves a prompt presentation lease across a renderer reload', async () => {
    const emitted: { owner: number; generation: number; id: number }[] = []
    const prompter = new RendererSshPrompter((owner, prompt) =>
      emitted.push({ owner: owner.id, generation: owner.generation, id: prompt.id }),
    )
    const previous = { id: 7, generation: 1 }
    const current = { id: 7, generation: 2 }
    prompter.activateOwner(previous)
    const response = prompter.runForOwner(previous, () =>
      prompter.prompt({
        hostId: 'alpha',
        kind: 'password',
        title: 'Alpha',
        prompts: [],
      }),
    )

    prompter.revokeOwner(previous)
    prompter.respond(previous, 1, ['stale'])
    prompter.activateOwner(current)
    prompter.respond(current, 1, ['current'])

    await expect(response).resolves.toEqual(['current'])
    expect(emitted).toEqual([
      { owner: 7, generation: 1, id: 1 },
      { owner: 7, generation: 2, id: 1 },
    ])
  })
})
