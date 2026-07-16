import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  asHostId,
  basenameHostPath,
  hostPathEquals,
  hostPath,
  localPath,
  type HostPath,
  type BrowseHostResponse,
  type ConnectedHost,
  type ProjectHostOption,
  type ProjectState,
  type RegisteredProjectState,
  type SshPromptRequest,
  type WorktreeDiscovery,
  type WorkspaceState,
} from '../shared'
import {
  LocalHost,
  SshHost,
  parseSshConfig,
  type ProjectHost,
  type SshAliasConfig,
  type SshAuthPrompter,
  type SshPrompt,
} from './project-host'

export interface ActiveProject {
  readonly host: ProjectHost
  readonly root: HostPath
  readonly projectId: string
  readonly workspaceId: string
}

type WorkspaceRecord = WorkspaceState

interface ProjectRecord {
  readonly id: string
  readonly registeredRoot: HostPath
  readonly displayName: string
  activeWorkspaceId: string
  workspaces: WorkspaceRecord[]
}

interface StoredProjectRegistry {
  readonly version: 1
  readonly activeProjectId: string
  readonly projects: readonly {
    readonly hostId: string
    readonly path: string
    readonly displayName: string
    readonly activeWorkspacePath: string
    readonly workspaces: readonly {
      readonly path: string
      readonly head?: string
      readonly branch?: string
      readonly main: boolean
      readonly missing: boolean
      readonly prunableReason?: string
      readonly repository: boolean
      readonly changedFiles: number
    }[]
  }[]
}

const PROJECT_REGISTRY_VERSION = 1
const MAX_PROJECTS = 100
const MAX_WORKSPACES = 1_000

export class ProjectRegistry {
  private readonly hosts = new Map<string, ProjectHost>()
  private activeProject: ActiveProject
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly local: LocalHost,
    initialRoot: HostPath,
    private readonly aliases: readonly SshAliasConfig[],
    private readonly prompter: SshAuthPrompter,
    private readonly trust: HostTrustStore,
    private readonly file: HostPath,
    private readonly projects: ProjectRecord[],
    private activeProjectId: string,
    private readonly onState: (state: ProjectState) => void,
  ) {
    this.hosts.set(local.hostId, local)
    const initialProject = projects[0] ?? createProject(initialRoot)
    if (projects.length === 0) projects.push(initialProject)
    const initialWorkspace = initialProject.workspaces[0]!
    this.activeProject = {
      host: local,
      root: initialWorkspace.root,
      projectId: initialProject.id,
      workspaceId: initialWorkspace.id,
    }
  }

  static async create(
    initialRoot: HostPath,
    prompter: SshAuthPrompter,
    trustFile: string,
    registryFile: string,
    onState: (state: ProjectState) => void,
  ): Promise<ProjectRegistry> {
    const local = new LocalHost()
    await local.connect()
    const canonicalRoot = await local.realpath(initialRoot)
    const aliases = await loadSshAliases(local)
    const trust = await HostTrustStore.load(local, localPath(trustFile))
    const file = localPath(registryFile)
    const stored = await loadProjects(local, file)
    const projects = stored?.projects.length
      ? stored.projects
      : [createProject(canonicalRoot)]
    const registry = new ProjectRegistry(
      local,
      canonicalRoot,
      aliases,
      prompter,
      trust,
      file,
      projects,
      stored?.activeProjectId ?? projects[0]!.id,
      onState,
    )
    await registry.restoreActive()
    if (!stored) await registry.persist()
    return registry
  }

  get active(): ActiveProject {
    return this.activeProject
  }

  state(): ProjectState {
    const activeHost = this.activeProject.host
    return {
      root: this.activeProject.root,
      connectionState: activeHost.connectionState,
      watchTier: activeHost.watchTier,
      projects: this.projects.map((project) => this.rendererProject(project)),
      activeProjectId: this.activeProject.projectId,
      activeWorkspaceId: this.activeProject.workspaceId,
    }
  }

  projectById(projectId: string): RegisteredProjectState | undefined {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    return project ? this.rendererProject(project) : undefined
  }

  /** Resolve only exact persisted workspace roots; no live host is required. */
  registeredWorkspaceRoot(candidate: HostPath): HostPath | undefined {
    return this.projects
      .flatMap((project) => project.workspaces)
      .find((workspace) => hostPathEquals(workspace.root, candidate))?.root
  }

  authorityForPath(hostId: string, path: string): ActiveProject | undefined {
    const candidates = this.projects.flatMap((project) =>
      [
        { project, workspace: undefined, root: project.registeredRoot },
        ...project.workspaces.map((workspace) => ({
          project,
          workspace,
          root: workspace.root,
        })),
      ].filter(({ root }) =>
        root.hostId === hostId ? isInsidePath(path, root.path) : false,
      ),
    )
    const match = candidates.sort(
      (left, right) => right.root.path.length - left.root.path.length,
    )[0]
    if (!match) return undefined
    const host = this.hosts.get(hostId)
    if (!host) return undefined
    const workspace =
      match.workspace ??
      match.project.workspaces.find((candidate) =>
        hostPathEquals(candidate.root, match.root),
      ) ??
      match.project.workspaces[0]
    if (!workspace) return undefined
    return {
      host,
      root: match.root,
      projectId: match.project.id,
      workspaceId: workspace.id,
    }
  }

  listHosts(): readonly ProjectHostOption[] {
    return [
      hostOption(this.local, 'Local', 'local'),
      ...this.aliases.map((config) => {
        const host = this.hosts.get(config.alias)
        return host
          ? hostOption(host, config.alias, 'ssh')
          : {
              hostId: config.alias,
              label: config.alias,
              kind: 'ssh' as const,
              connectionState: 'disconnected' as const,
              watchTier: 'polling' as const,
            }
      }),
    ]
  }

  hostById(hostId: string): ProjectHost | undefined {
    return this.hosts.get(hostId)
  }

  async connectHost(hostId: string): Promise<ConnectedHost> {
    const host = await this.host(hostId)
    await host.connect()
    let suggestedPath =
      this.activeProject.host.hostId === host.hostId ? this.activeProject.root.path : '/'
    if (host.hostId === this.local.hostId) {
      suggestedPath =
        this.activeProject.host.hostId === host.hostId
          ? this.activeProject.root.path
          : homedir()
    } else {
      const pwd = await host.exec('pwd', [])
      if (pwd.code === 0 && pwd.stdout.trim().startsWith('/')) {
        suggestedPath = pwd.stdout.trim()
      }
    }
    return {
      host: hostOption(
        host,
        hostId === this.local.hostId ? 'Local' : hostId,
        hostId === this.local.hostId ? 'local' : 'ssh',
      ),
      suggestedPath,
    }
  }

  async disconnectHost(hostId: string): Promise<ProjectHostOption> {
    if (hostId === this.local.hostId) throw new Error('The local host cannot disconnect')
    const host = this.hosts.get(hostId)
    if (!host) throw new Error(`SSH host is not connected: ${hostId}`)
    if ('cancelHost' in this.prompter) {
      ;(this.prompter as SshAuthPrompter & { cancelHost(id: string): void }).cancelHost(
        hostId,
      )
    }
    await host.dispose()
    this.emitState()
    return hostOption(host, hostId, 'ssh')
  }

  async disconnectSshHosts(): Promise<void> {
    await Promise.all(
      [...this.hosts.values()]
        .filter((host) => host.hostId !== this.local.hostId)
        .map((host) => host.dispose()),
    )
  }

  async browseHost(hostId: string, rawPath: string): Promise<BrowseHostResponse> {
    const host = this.hosts.get(hostId)
    if (!host || host.connectionState !== 'connected') {
      throw new Error(`Connect to ${hostId} before browsing folders`)
    }
    if (!rawPath.startsWith('/')) throw new Error('Folder path must be absolute')
    try {
      const path = await host.realpath(hostPath(asHostId(hostId), rawPath))
      const stat = await host.stat(path)
      if (stat.type !== 'dir') throw new Error(`Not a directory: ${rawPath}`)
      const directories = (await host.readdir(path))
        .filter((entry) => entry.type === 'dir')
        .sort((left, right) => left.name.localeCompare(right.name))
      return { path, directories }
    } catch (reason) {
      const code = (reason as { code?: unknown } | undefined)?.code
      if (code === 2 || code === 'ENOENT')
        throw new Error(`Folder not found: ${rawPath}`, { cause: reason })
      if (code === 3 || code === 'EACCES')
        throw new Error(`Cannot access folder: ${rawPath}`, { cause: reason })
      throw reason
    }
  }

  async open(hostId: string, path: string): Promise<ProjectState> {
    const host = await this.host(hostId)
    await host.connect()
    const root = await host.realpath(hostPath(asHostId(hostId), path))
    const stat = await host.stat(root)
    if (stat.type !== 'dir') throw new Error(`Project root is not a directory: ${path}`)
    let project = this.projects.find((candidate) =>
      hostPathEquals(candidate.registeredRoot, root),
    )
    if (!project) {
      if (this.projects.length >= MAX_PROJECTS)
        throw new Error('Project registry is full')
      project = createProject(root)
      this.projects.push(project)
    }
    const workspace =
      project.workspaces.find((candidate) => hostPathEquals(candidate.root, root)) ??
      project.workspaces[0]!
    project.activeWorkspaceId = workspace.id
    this.activeProjectId = project.id
    this.activeProject = {
      host,
      root: workspace.root,
      projectId: project.id,
      workspaceId: workspace.id,
    }
    await this.persist()
    this.emitState()
    return this.state()
  }

  async activate(projectId: string, workspaceId: string): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (workspace.missing) throw new Error('This worktree is no longer present')
    const host = await this.host(project.registeredRoot.hostId)
    if (host.connectionState !== 'connected') {
      throw new Error(`Connect to ${host.hostId} before opening this workspace`)
    }
    project.activeWorkspaceId = workspace.id
    this.activeProjectId = project.id
    this.activeProject = {
      host,
      root: workspace.root,
      projectId: project.id,
      workspaceId: workspace.id,
    }
    await this.persist()
    this.emitState()
    return this.state()
  }

  async reconcileWorktrees(
    projectId: string,
    discovery: WorktreeDiscovery,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Unknown project')
    const before = workspaceSignature(project.workspaces)
    const seen = new Set<string>()
    for (const discovered of discovery.worktrees) {
      if (
        discovered.root.hostId !== project.registeredRoot.hostId ||
        !discovered.root.path.startsWith('/')
      ) {
        throw new Error('Git reported a worktree on another host')
      }
      const id = workspaceId(discovered.root)
      seen.add(id)
      const existing = project.workspaces.find((candidate) => candidate.id === id)
      const record: WorkspaceRecord = {
        id,
        root: discovered.root,
        name:
          discovered.branch ?? basenameHostPath(discovered.root) ?? discovered.root.path,
        head: discovered.head,
        branch: discovered.branch,
        main: hostPathEquals(discovered.root, project.registeredRoot),
        missing: discovered.prunable === true,
        ...(discovered.prunable === true
          ? {
              prunableReason:
                discovered.prunableReason ?? 'Git reported stale worktree metadata',
            }
          : {}),
        repository: discovery.repository,
        changedFiles: existing?.changedFiles ?? 0,
      }
      if (existing) project.workspaces[project.workspaces.indexOf(existing)] = record
      else project.workspaces.push(record)
    }
    project.workspaces = project.workspaces
      .map((workspace) =>
        seen.has(workspace.id)
          ? workspace
          : { ...workspace, missing: true, prunableReason: undefined },
      )
      .sort(compareWorkspaces)
    if (
      !project.workspaces.some((workspace) => workspace.id === project.activeWorkspaceId)
    ) {
      project.activeWorkspaceId =
        project.workspaces.find((workspace) => !workspace.missing)?.id ?? ''
    }
    if (before === workspaceSignature(project.workspaces)) return this.state()
    await this.persist()
    this.emitState()
    return this.state()
  }

  async updateChangedCounts(
    projectId: string,
    counts: ReadonlyMap<string, number>,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Unknown project')
    const changed = project.workspaces.some(
      (workspace) =>
        counts.has(workspace.id) && counts.get(workspace.id) !== workspace.changedFiles,
    )
    if (!changed) return this.state()
    project.workspaces = project.workspaces.map((workspace) => ({
      ...workspace,
      changedFiles: counts.get(workspace.id) ?? workspace.changedFiles,
    }))
    await this.persist()
    this.emitState()
    return this.state()
  }

  async closeProject(projectId: string): Promise<ProjectState> {
    const index = this.projects.findIndex((candidate) => candidate.id === projectId)
    if (index < 0) throw new Error('Unknown project')
    if (this.projects.length <= 1) throw new Error('hvir must keep one project open')

    const closesActiveProject = projectId === this.activeProjectId
    if (closesActiveProject) {
      const remaining = this.projects.filter((project) => project.id !== projectId)
      const project = remaining[Math.min(index, remaining.length - 1)]!
      const workspace =
        project.workspaces.find(
          (candidate) => candidate.id === project.activeWorkspaceId && !candidate.missing,
        ) ??
        project.workspaces.find((candidate) => !candidate.missing) ??
        project.workspaces[0]!
      const host = await this.host(project.registeredRoot.hostId)
      this.activeProjectId = project.id
      project.activeWorkspaceId = workspace.id
      this.activeProject = {
        host,
        root: workspace.root,
        projectId: project.id,
        workspaceId: workspace.id,
      }
    }

    this.projects.splice(index, 1)
    await this.persist()
    this.emitState()
    return this.state()
  }

  async dismissWorkspace(projectId: string, id: string): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find((candidate) => candidate.id === id)
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (!workspace.missing) throw new Error('Only removed worktrees can be dismissed')
    project.workspaces = project.workspaces.filter((candidate) => candidate.id !== id)
    if (project.activeWorkspaceId === id) {
      const next = project.workspaces.find((candidate) => !candidate.missing)
      if (!next) throw new Error('A project must keep one workspace')
      project.activeWorkspaceId = next.id
      if (project.id === this.activeProjectId) await this.activate(project.id, next.id)
    }
    await this.persist()
    this.emitState()
    return this.state()
  }

  async dispose(): Promise<void> {
    await this.pendingWrite
    await Promise.all([...this.hosts.values()].map((host) => host.dispose()))
  }

  private async restoreActive(): Promise<void> {
    const project =
      this.projects.find((candidate) => candidate.id === this.activeProjectId) ??
      this.projects[0]!
    const workspace =
      project.workspaces.find(
        (candidate) => candidate.id === project.activeWorkspaceId && !candidate.missing,
      ) ??
      project.workspaces.find((candidate) => !candidate.missing) ??
      project.workspaces[0]!
    const host = await this.host(project.registeredRoot.hostId)
    this.activeProjectId = project.id
    project.activeWorkspaceId = workspace.id
    this.activeProject = {
      host,
      root: workspace.root,
      projectId: project.id,
      workspaceId: workspace.id,
    }
  }

  private rendererProject(project: ProjectRecord): RegisteredProjectState {
    const host = this.hosts.get(project.registeredRoot.hostId)
    return {
      id: project.id,
      registeredRoot: project.registeredRoot,
      displayName: project.displayName,
      connectionState: host?.connectionState ?? 'disconnected',
      watchTier: host?.watchTier ?? 'polling',
      activeWorkspaceId: project.activeWorkspaceId,
      workspaces: project.workspaces,
    }
  }

  private emitState(): void {
    this.onState(this.state())
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      const stored: StoredProjectRegistry = {
        version: PROJECT_REGISTRY_VERSION,
        activeProjectId: this.activeProjectId,
        projects: this.projects.map((project) => ({
          hostId: project.registeredRoot.hostId,
          path: project.registeredRoot.path,
          displayName: project.displayName,
          activeWorkspacePath:
            project.workspaces.find(
              (workspace) => workspace.id === project.activeWorkspaceId,
            )?.root.path ?? project.registeredRoot.path,
          workspaces: project.workspaces.map((workspace) => ({
            path: workspace.root.path,
            head: workspace.head,
            branch: workspace.branch,
            main: workspace.main,
            missing: workspace.missing,
            prunableReason: workspace.prunableReason,
            repository: workspace.repository,
            changedFiles: workspace.changedFiles,
          })),
        })),
      }
      await this.local.writeFile(this.file, JSON.stringify(stored, null, 2))
    }
    const next = this.pendingWrite.then(write, write)
    this.pendingWrite = next.catch(() => undefined)
    return next
  }

  private async host(hostId: string): Promise<ProjectHost> {
    const existing = this.hosts.get(hostId)
    if (existing) return existing
    const config = this.aliases.find((candidate) => candidate.alias === hostId)
    if (!config) throw new Error(`Unknown SSH host alias: ${hostId}`)
    const identities = await Promise.all(
      identityFileCandidates(config).map(async (path) => {
        try {
          return { path, privateKey: await this.local.readFile(localPath(path)) }
        } catch {
          return undefined
        }
      }),
    )
    const host = new SshHost({
      config,
      identities: identities.filter((identity) => identity !== undefined),
      agentSocket: process.env['SSH_AUTH_SOCK'],
      prompter: this.prompter,
      trustedHostKey: () => this.trust.fingerprint(config.alias),
      rememberHostKey: (fingerprint) => this.trust.remember(config.alias, fingerprint),
    })
    host.onConnectionState(() => {
      this.emitState()
    })
    this.hosts.set(hostId, host)
    return host
  }
}

const DEFAULT_IDENTITY_NAMES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
  'id_xmss',
  'id_dsa',
] as const

/** OpenSSH's conventional identity set applies when no IdentityFile is configured. */
export function identityFileCandidates(
  config: SshAliasConfig,
  home = homedir(),
): readonly string[] {
  if (config.identityFiles.length) return [...new Set(config.identityFiles)]
  return DEFAULT_IDENTITY_NAMES.map((name) => join(home, '.ssh', name))
}

export class RendererSshPrompter implements SshAuthPrompter {
  private nextId = 0
  private readonly pending = new Map<
    number,
    {
      readonly hostId: string
      readonly resolve: (answers: readonly string[] | undefined) => void
    }
  >()

  constructor(
    private readonly emit: (prompt: SshPromptRequest) => void,
    private readonly emitCancel: (hostId: string) => void = () => undefined,
  ) {}

  prompt(request: SshPrompt): Promise<readonly string[] | undefined> {
    const id = ++this.nextId
    return new Promise((resolve) => {
      this.pending.set(id, { hostId: request.hostId, resolve })
      this.emit({ id, ...request })
    })
  }

  respond(id: number, answers?: readonly string[]): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.resolve(answers)
  }

  cancelAll(): void {
    const hosts = new Set([...this.pending.values()].map((pending) => pending.hostId))
    for (const pending of this.pending.values()) pending.resolve(undefined)
    this.pending.clear()
    for (const hostId of hosts) this.emitCancel(hostId)
  }

  cancelHost(hostId: string): void {
    let cancelled = false
    for (const [id, pending] of this.pending) {
      if (pending.hostId !== hostId) continue
      cancelled = true
      pending.resolve(undefined)
      this.pending.delete(id)
    }
    if (cancelled) this.emitCancel(hostId)
  }
}

class HostTrustStore {
  private constructor(
    private readonly host: LocalHost,
    private readonly file: HostPath,
    private readonly fingerprints: Record<string, string>,
  ) {}

  static async load(host: LocalHost, file: HostPath): Promise<HostTrustStore> {
    try {
      const parsed: unknown = JSON.parse(await host.readTextFile(file))
      const fingerprints: Record<string, string> = {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [alias, fingerprint] of Object.entries(parsed)) {
          if (
            /^[^\s]{1,255}$/.test(alias) &&
            typeof fingerprint === 'string' &&
            /^SHA256:[A-Za-z0-9+/]{20,}$/.test(fingerprint)
          ) {
            fingerprints[alias] = fingerprint
          }
        }
      }
      return new HostTrustStore(host, file, fingerprints)
    } catch {
      return new HostTrustStore(host, file, {})
    }
  }

  fingerprint(alias: string): string | undefined {
    return this.fingerprints[alias]
  }

  async remember(alias: string, fingerprint: string): Promise<void> {
    if (!/^SHA256:[A-Za-z0-9+/]{20,}$/.test(fingerprint)) {
      throw new Error('Invalid SSH host-key fingerprint')
    }
    this.fingerprints[alias] = fingerprint
    await this.host.writeFile(this.file, JSON.stringify(this.fingerprints, null, 2))
  }
}

async function loadSshAliases(host: LocalHost): Promise<readonly SshAliasConfig[]> {
  const home = homedir()
  try {
    return parseSshConfig(
      await host.readTextFile(localPath(join(home, '.ssh/config'))),
      home,
    )
  } catch {
    return []
  }
}

function hostOption(
  host: ProjectHost,
  label: string,
  kind: 'local' | 'ssh',
): ProjectHostOption {
  return {
    hostId: host.hostId,
    label,
    kind,
    connectionState: host.connectionState,
    watchTier: host.watchTier,
  }
}

function projectId(root: HostPath): string {
  return `project:${root.hostId}:${root.path}`
}

function workspaceId(root: HostPath): string {
  return `workspace:${root.hostId}:${root.path}`
}

function createProject(root: HostPath): ProjectRecord {
  const workspace: WorkspaceRecord = {
    id: workspaceId(root),
    root,
    name: basenameHostPath(root) || root.path,
    main: true,
    missing: false,
    repository: false,
    changedFiles: 0,
  }
  return {
    id: projectId(root),
    registeredRoot: root,
    displayName: basenameHostPath(root) || root.path,
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
  }
}

function compareWorkspaces(left: WorkspaceRecord, right: WorkspaceRecord): number {
  if (left.main !== right.main) return left.main ? -1 : 1
  if (left.missing !== right.missing) return left.missing ? 1 : -1
  return (
    left.name.localeCompare(right.name) || left.root.path.localeCompare(right.root.path)
  )
}

function isInsidePath(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

function workspaceSignature(workspaces: readonly WorkspaceRecord[]): string {
  return JSON.stringify(
    workspaces.map(
      ({
        id,
        head,
        branch,
        main,
        missing,
        prunableReason,
        repository,
        changedFiles,
      }) => ({
        id,
        head,
        branch,
        main,
        missing,
        prunableReason,
        repository,
        changedFiles,
      }),
    ),
  )
}

async function loadProjects(
  host: LocalHost,
  file: HostPath,
): Promise<{ activeProjectId: string; projects: ProjectRecord[] } | undefined> {
  try {
    const value: unknown = JSON.parse(await host.readTextFile(file))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const stored = value as Record<string, unknown>
    if (
      stored['version'] !== PROJECT_REGISTRY_VERSION ||
      !Array.isArray(stored['projects']) ||
      stored['projects'].length === 0 ||
      stored['projects'].length > MAX_PROJECTS
    ) {
      return undefined
    }
    const projects: ProjectRecord[] = []
    let workspaceCount = 0
    for (const rawProject of stored['projects']) {
      if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject))
        continue
      const item = rawProject as Record<string, unknown>
      const hostId = item['hostId']
      const path = item['path']
      const displayName = item['displayName']
      const rawWorkspaces = item['workspaces']
      if (
        typeof hostId !== 'string' ||
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        typeof displayName !== 'string' ||
        displayName.length === 0 ||
        displayName.length > 240 ||
        !Array.isArray(rawWorkspaces)
      ) {
        continue
      }
      const root = hostPath(asHostId(hostId), path)
      const workspaces: WorkspaceRecord[] = []
      for (const rawWorkspace of rawWorkspaces) {
        if (
          workspaceCount >= MAX_WORKSPACES ||
          !rawWorkspace ||
          typeof rawWorkspace !== 'object' ||
          Array.isArray(rawWorkspace)
        ) {
          continue
        }
        const workspace = rawWorkspace as Record<string, unknown>
        const workspacePath = workspace['path']
        if (typeof workspacePath !== 'string' || !workspacePath.startsWith('/')) continue
        const workspaceRoot = hostPath(root.hostId, workspacePath)
        const branch =
          typeof workspace['branch'] === 'string' && workspace['branch'].length <= 1_024
            ? workspace['branch']
            : undefined
        const head =
          typeof workspace['head'] === 'string' &&
          /^[0-9a-f]{40,64}$/i.test(workspace['head'])
            ? workspace['head']
            : undefined
        const missing = workspace['missing'] === true
        const prunableReason =
          missing &&
          typeof workspace['prunableReason'] === 'string' &&
          workspace['prunableReason'].length > 0 &&
          workspace['prunableReason'].length <= 1_024
            ? workspace['prunableReason']
            : undefined
        workspaces.push({
          id: workspaceId(workspaceRoot),
          root: workspaceRoot,
          name: branch ?? basenameHostPath(workspaceRoot) ?? workspaceRoot.path,
          ...(head ? { head } : {}),
          ...(branch ? { branch } : {}),
          ...(prunableReason ? { prunableReason } : {}),
          main: workspace['main'] === true,
          missing,
          repository: workspace['repository'] === true,
          changedFiles:
            typeof workspace['changedFiles'] === 'number' &&
            Number.isSafeInteger(workspace['changedFiles']) &&
            workspace['changedFiles'] >= 0
              ? workspace['changedFiles']
              : 0,
        })
        workspaceCount++
      }
      if (workspaces.length === 0) workspaces.push(createProject(root).workspaces[0]!)
      const activeWorkspacePath = item['activeWorkspacePath']
      const activeWorkspace =
        typeof activeWorkspacePath === 'string'
          ? workspaces.find((workspace) => workspace.root.path === activeWorkspacePath)
          : undefined
      projects.push({
        id: projectId(root),
        registeredRoot: root,
        displayName,
        activeWorkspaceId: activeWorkspace?.id ?? workspaces[0]!.id,
        workspaces: workspaces.sort(compareWorkspaces),
      })
    }
    if (projects.length === 0) return undefined
    const rawActive = stored['activeProjectId']
    const activeProjectId =
      typeof rawActive === 'string' &&
      projects.some((project) => project.id === rawActive)
        ? rawActive
        : projects[0]!.id
    return { activeProjectId, projects }
  } catch {
    return undefined
  }
}
