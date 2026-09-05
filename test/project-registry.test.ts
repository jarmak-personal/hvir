import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectHostCatalog, type SshAuthPrompter } from '../src/main/project-host'
import { ProjectRegistry } from '../src/main/project-registry'
import {
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ProjectState,
  type WorkspaceActivityResult,
} from '../src/shared'

const cleanups: string[] = []
const catalogs: ProjectHostCatalog[] = []

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.dispose()))
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

async function createRegistry(
  initialRoot: HostPath,
  prompter: SshAuthPrompter,
  trustFile: string,
  registryFile: string,
  onState: (state: ProjectState) => void,
): Promise<ProjectRegistry>
async function createRegistry(
  initialRoot: HostPath | undefined,
  prompter: SshAuthPrompter,
  trustFile: string,
  registryFile: string,
  onState: (state: ProjectState) => void,
  selectInitialRoot: () => Promise<HostPath | undefined>,
): Promise<ProjectRegistry | undefined>
async function createRegistry(
  initialRoot: HostPath | undefined,
  prompter: SshAuthPrompter,
  trustFile: string,
  registryFile: string,
  onState: (state: ProjectState) => void,
  selectInitialRoot?: () => Promise<HostPath | undefined>,
): Promise<ProjectRegistry | undefined> {
  const catalog = await ProjectHostCatalog.create({
    prompter,
    trustFile: localPath(trustFile),
    home: dirname(trustFile),
  })
  catalogs.push(catalog)
  return selectInitialRoot
    ? ProjectRegistry.create(
        initialRoot,
        catalog,
        registryFile,
        onState,
        selectInitialRoot,
      )
    : ProjectRegistry.create(initialRoot!, catalog, registryFile, onState)
}

function activityResult(
  digestCharacter: string,
  statusTruncated = false,
): WorkspaceActivityResult {
  return {
    changedFiles: 1,
    status: {
      schema: WORKSPACE_ACTIVITY_SCHEMA,
      fields: WORKSPACE_ACTIVITY_FIELDS,
      statusLimit: WORKSPACE_ACTIVITY_STATUS_LIMIT,
      statusEntryCount: 1,
      statusTruncated,
      statusDigest: digestCharacter.repeat(64),
    },
  }
}

describe('ProjectRegistry session flow', () => {
  it('cancels first-run selection without inventing a cwd project', async () => {
    const metadata = await mkdtemp(join(tmpdir(), 'hvir-registry-empty-'))
    cleanups.push(metadata)
    const select = vi.fn(() => Promise.resolve(undefined))

    const registry = await createRegistry(
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
    const initial = await createRegistry(
      localPath(first),
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )
    await initial.open('local', second)
    await initial.dispose()

    const select = vi.fn(() => Promise.resolve(localPath(metadata)))
    const restored = await createRegistry(
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

    const explicit = await createRegistry(
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
    const initial = await createRegistry(
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
    const linkedId = initial
      .projectById(initial.state().activeProjectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalLinked.path)!.id
    await initial.closeWorkspace(initial.state().activeProjectId, linkedId)
    await initial.dispose()

    const restored = await createRegistry(
      canonicalLinked,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      registryFile,
      () => undefined,
    )

    expect(restored.state().root).toEqual(canonicalLinked)
    expect(restored.state().projects).toHaveLength(1)
    expect(
      restored
        .projectById(restored.state().activeProjectId)
        ?.workspaces.find((workspace) => workspace.id === linkedId)?.closed,
    ).toBe(false)
    await restored.dispose()
  })

  it('opens a selected local folder and publishes registered project state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const canonicalRoot = await realpath(root)
    cleanups.push(root)
    await mkdir(join(root, 'alpha'))
    const states: ProjectState[] = []
    const registry = await createRegistry(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      (state) => states.push(state),
    )
    expect(registry.state().revision).toBe(0)

    const opened = await registry.open('local', join(root, 'alpha'))
    expect(opened.root.path).toBe(join(canonicalRoot, 'alpha'))
    expect(opened.revision).toBe(1)
    expect(states).toEqual([opened])

    const responseOnly = await registry.activate(
      opened.activeProjectId,
      opened.activeWorkspaceId,
      { emit: false },
    )
    expect(responseOnly.revision).toBe(2)
    expect(states).toEqual([opened])
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
    const registry = await createRegistry(
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

    const restored = await createRegistry(
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
    const registry = await createRegistry(
      localPath(root),
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      projectsFile,
      () => undefined,
    )
    const remoteRoot = hostPath(asHostId('example'), '/srv/repo-linked')

    expect(catalogs.at(-1)?.hostById('example')).toBeUndefined()
    expect(registry.registeredWorkspaceRoot(remoteRoot)).toEqual(remoteRoot)
    expect(
      registry.registeredWorkspaceRoot(
        hostPath(asHostId('example'), '/srv/repo-linked/nested'),
      ),
    ).toBeUndefined()
    await registry.dispose()
  })

  it('marks removed worktrees missing until lifecycle dismissal is persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-'))
    const linked = join(root, 'linked')
    await mkdir(linked)
    const canonicalRoot = await realpath(root)
    const canonicalLinked = await realpath(linked)
    cleanups.push(root)
    const projectsFile = join(root, 'projects.json')
    const registry = await createRegistry(
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

    const restored = await createRegistry(
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

  it('reopens a present closed fallback when the active missing workspace is dismissed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-dismiss-fallback-'))
    const linked = join(root, 'linked')
    await mkdir(linked)
    cleanups.push(root)
    const canonicalRoot = localPath(await realpath(root))
    const canonicalLinked = localPath(await realpath(linked))
    const registry = await createRegistry(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      () => undefined,
    )
    const projectId = registry.state().activeProjectId
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        { root: canonicalRoot, branch: 'main', detached: false, bare: false },
        {
          root: canonicalLinked,
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    const project = registry.projectById(projectId)!
    const mainId = project.workspaces.find(({ main }) => main)!.id
    const linkedId = project.workspaces.find(({ main }) => !main)!.id
    await registry.activate(projectId, linkedId)
    await registry.closeWorkspace(projectId, mainId)
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [{ root: canonicalRoot, branch: 'main', detached: false, bare: false }],
    })

    await registry.dismissWorkspace(projectId, linkedId)

    expect(registry.state()).toMatchObject({
      root: canonicalRoot,
      activeWorkspaceId: mainId,
    })
    expect(registry.projectById(projectId)?.workspaces).toEqual([
      expect.objectContaining({ id: mainId, missing: false, closed: false }),
    ])
    await registry.dispose()
  })

  it('persists closed workspaces and resurfaces them only from comparable activity or rediscovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-closed-'))
    const linked = join(root, 'linked')
    await mkdir(linked)
    const canonicalRoot = localPath(await realpath(root))
    const canonicalLinked = localPath(await realpath(linked))
    const projectsFile = join(root, 'projects.json')
    const trustFile = join(root, 'known-hosts.json')
    cleanups.push(root)
    const registry = await createRegistry(
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
        {
          root: canonicalRoot,
          head: '1'.repeat(40),
          branch: 'main',
          detached: false,
          bare: false,
        },
        {
          root: canonicalLinked,
          head: '2'.repeat(40),
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    const linkedId = registry
      .projectById(projectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalLinked.path)!.id
    await registry.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('a')]]),
    )
    await registry.closeWorkspace(projectId, linkedId)

    await registry.restoreWorkspaceAfterFailedClose(projectId, linkedId)
    expect(registry.state().activeWorkspaceId).not.toBe(linkedId)
    expect(
      registry.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(false)
    await registry.closeWorkspace(projectId, linkedId)

    expect(
      registry.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId),
    ).toMatchObject({ closed: true, missing: false })
    expect(registry.registeredWorkspaceRoot(canonicalLinked)).toBeUndefined()
    const stored = JSON.parse(await readFile(projectsFile, 'utf8')) as {
      projects: Array<{
        workspaces: Array<{ path: string; activityBaseline?: Record<string, unknown> }>
      }>
    }
    const storedLinked = stored.projects[0]?.workspaces.find(
      (workspace) => workspace.path === canonicalLinked.path,
    )
    expect(Object.keys(storedLinked?.activityBaseline ?? {}).sort()).toEqual([
      'branch',
      'fields',
      'head',
      'schema',
      'statusDigest',
      'statusEntryCount',
      'statusLimit',
      'statusTruncated',
    ])
    expect(JSON.stringify(storedLinked)).not.toMatch(/mtime|fileSize|terminal|output/)
    await registry.dispose()

    const restored = await createRegistry(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      trustFile,
      projectsFile,
      () => undefined,
    )
    await restored.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('a')]]),
    )
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(true)
    await restored.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('b', true)]]),
    )
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(true)
    await restored.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('b')]]),
    )
    expect(restored.state().activeWorkspaceId).not.toBe(linkedId)
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(false)

    await restored.closeWorkspace(projectId, linkedId)
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        {
          root: canonicalRoot,
          head: '1'.repeat(40),
          branch: 'main',
          detached: false,
          bare: false,
        },
      ],
    })
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId),
    ).toMatchObject({ closed: true, missing: true })
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        {
          root: canonicalRoot,
          head: '1'.repeat(40),
          branch: 'main',
          detached: false,
          bare: false,
        },
        {
          root: canonicalLinked,
          head: '2'.repeat(40),
          branch: 'feature',
          detached: false,
          bare: false,
          prunable: true,
          prunableReason: 'gitdir points to a missing worktree',
        },
      ],
    })
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId),
    ).toMatchObject({
      closed: true,
      missing: true,
      prunableReason: 'gitdir points to a missing worktree',
    })
    await restored.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        {
          root: canonicalRoot,
          head: '1'.repeat(40),
          branch: 'main',
          detached: false,
          bare: false,
        },
        {
          root: canonicalLinked,
          head: '2'.repeat(40),
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    expect(restored.state().activeWorkspaceId).not.toBe(linkedId)
    expect(
      restored.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId),
    ).toMatchObject({ closed: false, missing: false })

    await restored.closeWorkspace(projectId, linkedId)
    await restored.reopenWorkspace(projectId, linkedId)
    expect(restored.state()).toMatchObject({
      activeWorkspaceId: linkedId,
      root: canonicalLinked,
    })
    await restored.dispose()
  })

  it('establishes a missing close baseline before later Git activity resurfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-registry-late-baseline-'))
    const linked = join(root, 'linked')
    await mkdir(linked)
    const canonicalRoot = localPath(await realpath(root))
    const canonicalLinked = localPath(await realpath(linked))
    cleanups.push(root)
    const registry = await createRegistry(
      canonicalRoot,
      { prompt: () => Promise.resolve(undefined) },
      join(root, 'known-hosts.json'),
      join(root, 'projects.json'),
      () => undefined,
    )
    const projectId = registry.state().activeProjectId
    await registry.reconcileWorktrees(projectId, {
      repository: true,
      worktrees: [
        {
          root: canonicalRoot,
          head: '1'.repeat(40),
          branch: 'main',
          detached: false,
          bare: false,
        },
        {
          root: canonicalLinked,
          head: '2'.repeat(40),
          branch: 'feature',
          detached: false,
          bare: false,
        },
      ],
    })
    const linkedId = registry
      .projectById(projectId)!
      .workspaces.find((workspace) => workspace.root.path === canonicalLinked.path)!.id
    await registry.closeWorkspace(projectId, linkedId)
    await registry.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('a')]]),
    )
    expect(
      registry.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(true)
    await registry.updateWorkspaceActivity(
      projectId,
      new Map([[linkedId, activityResult('b')]]),
    )
    expect(
      registry.projectById(projectId)?.workspaces.find(({ id }) => id === linkedId)
        ?.closed,
    ).toBe(false)
    await registry.dispose()
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
    const registry = await createRegistry(
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

    const restored = await createRegistry(
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
    const registry = await createRegistry(
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
    await registry.updateWorkspaceActivity(
      projectId,
      new Map([[workspaceId, { changedFiles: 12 }]]),
    )

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
    const registry = await createRegistry(
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

    const restored = await createRegistry(
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
