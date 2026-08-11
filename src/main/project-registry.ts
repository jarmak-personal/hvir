import { homedir } from 'node:os'

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
  type WorktreeDiscovery,
  type WorkspaceActivityResult,
  type WorkspaceActivitySnapshot,
  type WorkspaceState,
} from '../shared'
import type { Disposer, ProjectHost } from './project-host'
import {
  comparableWorkspaceActivity,
  validActivitySnapshot,
  workspaceActivityChanged,
  workspaceActivitySnapshot,
} from './workspace-activity'

export interface ActiveProject {
  readonly host: ProjectHost
  readonly root: HostPath
  readonly projectId: string
  readonly workspaceId: string
}

/** ProjectRegistry's consumer-owned view of the live host catalog. */
export interface ProjectRegistryHostCatalog {
  readonly local: ProjectHost
  listHosts(): readonly ProjectHostOption[]
  hostById(hostId: string): ProjectHost | undefined
  connectedHosts(): readonly ProjectHost[]
  materializeHost(hostId: string): Promise<ProjectHost>
  disconnectHost(hostId: string): Promise<ProjectHostOption>
  disconnectSshHosts(): Promise<void>
  onHostStateChange(listener: () => void): Disposer
}

type WorkspaceRecord = WorkspaceState & {
  readonly activityBaseline?: WorkspaceActivitySnapshot
  readonly latestActivity?: WorkspaceActivitySnapshot
}

interface ProjectRecord {
  readonly id: string
  readonly registeredRoot: HostPath
  readonly displayName: string
  activeWorkspaceId: string
  discoveryBaselineEstablished: boolean
  workspaces: WorkspaceRecord[]
}

interface StoredProjectRegistry {
  readonly version: 3
  readonly activeProjectId: string
  readonly projects: readonly {
    readonly hostId: string
    readonly path: string
    readonly displayName: string
    readonly activeWorkspacePath: string
    readonly discoveryBaselineEstablished: boolean
    readonly workspaces: readonly {
      readonly path: string
      readonly head?: string
      readonly branch?: string
      readonly main: boolean
      readonly closed: boolean
      readonly missing: boolean
      readonly prunableReason?: string
      readonly repository: boolean
      readonly changedFiles: number
      readonly newlyDiscovered?: boolean
      readonly activityBaseline?: Omit<WorkspaceActivitySnapshot, 'root'>
    }[]
  }[]
}

const PROJECT_REGISTRY_VERSION = 3
const PREVIOUS_PROJECT_REGISTRY_VERSION = 2
const LEGACY_PROJECT_REGISTRY_VERSION = 1
const MAX_PROJECTS = 100
const MAX_WORKSPACES = 1_000

export class ProjectRegistry {
  private activeProject: ActiveProject
  private pendingWrite: Promise<void> = Promise.resolve()
  private stateRevision = 0
  private readonly stopHostState: Disposer

  private constructor(
    private readonly hostCatalog: ProjectRegistryHostCatalog,
    initialRoot: HostPath,
    private readonly file: HostPath,
    private readonly projects: ProjectRecord[],
    private activeProjectId: string,
    private readonly onState: (state: ProjectState) => void,
  ) {
    const initialProject = projects[0] ?? createProject(initialRoot)
    if (projects.length === 0) projects.push(initialProject)
    const initialWorkspace = initialProject.workspaces[0]!
    this.activeProject = {
      host: hostCatalog.local,
      root: initialWorkspace.root,
      projectId: initialProject.id,
      workspaceId: initialWorkspace.id,
    }
    this.stopHostState = hostCatalog.onHostStateChange(() => this.publishState())
  }

  static async create(
    initialRoot: HostPath,
    hostCatalog: ProjectRegistryHostCatalog,
    registryFile: string,
    onState: (state: ProjectState) => void,
  ): Promise<ProjectRegistry>
  static async create(
    initialRoot: HostPath | undefined,
    hostCatalog: ProjectRegistryHostCatalog,
    registryFile: string,
    onState: (state: ProjectState) => void,
    selectInitialRoot: () => Promise<HostPath | undefined>,
  ): Promise<ProjectRegistry | undefined>
  static async create(
    initialRoot: HostPath | undefined,
    hostCatalog: ProjectRegistryHostCatalog,
    registryFile: string,
    onState: (state: ProjectState) => void,
    selectInitialRoot?: () => Promise<HostPath | undefined>,
  ): Promise<ProjectRegistry | undefined> {
    const local = hostCatalog.local
    const file = localPath(registryFile)
    const stored = await loadProjects(local, file)
    let canonicalRoot = initialRoot ? await local.realpath(initialRoot) : undefined
    if (!canonicalRoot && !stored?.projects.length) {
      const selected = await selectInitialRoot?.()
      if (!selected) return undefined
      canonicalRoot = await local.realpath(selected)
    }
    const projects = stored?.projects.length ? stored.projects : []
    let activeProjectId = stored?.activeProjectId
    if (canonicalRoot) {
      let selectedProject = projects.find(
        (project) =>
          hostPathEquals(project.registeredRoot, canonicalRoot) ||
          project.workspaces.some((workspace) =>
            hostPathEquals(workspace.root, canonicalRoot),
          ),
      )
      if (!selectedProject) {
        if (projects.length >= MAX_PROJECTS) throw new Error('Project registry is full')
        selectedProject = createProject(canonicalRoot)
        projects.push(selectedProject)
      }
      const selectedWorkspace = selectedProject.workspaces.find((workspace) =>
        hostPathEquals(workspace.root, canonicalRoot),
      )
      if (selectedWorkspace && !selectedWorkspace.missing) {
        const selectedIndex = selectedProject.workspaces.indexOf(selectedWorkspace)
        const opened = openWorkspaceRecord(selectedWorkspace)
        selectedProject.workspaces[selectedIndex] = opened
        selectedProject.activeWorkspaceId = opened.id
      }
      activeProjectId = selectedProject.id
    }
    const fallbackRoot = canonicalRoot ?? projects[0]?.registeredRoot
    if (!fallbackRoot || !activeProjectId) return undefined
    const registry = new ProjectRegistry(
      hostCatalog,
      fallbackRoot,
      file,
      projects,
      activeProjectId,
      onState,
    )
    try {
      await registry.restoreActive()
      if (!stored || canonicalRoot) await registry.persist()
      return registry
    } catch (error) {
      await registry.dispose()
      throw error
    }
  }

  get active(): ActiveProject {
    return this.activeProject
  }

  state(): ProjectState {
    const activeHost = this.activeProject.host
    return {
      revision: this.stateRevision,
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
      .find((workspace) => !workspace.closed && hostPathEquals(workspace.root, candidate))
      ?.root
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
    const host = this.hostCatalog.hostById(hostId)
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
    return this.hostCatalog.listHosts()
  }

  hostById(hostId: string): ProjectHost | undefined {
    return this.hostCatalog.hostById(hostId)
  }

  connectedHosts(): readonly ProjectHost[] {
    return this.hostCatalog.connectedHosts()
  }

  async connectHost(hostId: string): Promise<ConnectedHost> {
    const host = await this.host(hostId)
    await host.connect()
    let suggestedPath =
      this.activeProject.host.hostId === host.hostId ? this.activeProject.root.path : '/'
    if (host.hostId === this.hostCatalog.local.hostId) {
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
    const option = this.hostCatalog
      .listHosts()
      .find((candidate) => candidate.hostId === hostId)
    if (!option) throw new Error(`Unknown project host: ${hostId}`)
    return {
      host: option,
      suggestedPath,
    }
  }

  async disconnectHost(hostId: string): Promise<ProjectHostOption> {
    return this.hostCatalog.disconnectHost(hostId)
  }

  async disconnectSshHosts(): Promise<void> {
    await this.hostCatalog.disconnectSshHosts()
  }

  async browseHost(hostId: string, rawPath: string): Promise<BrowseHostResponse> {
    const host = this.hostCatalog.hostById(hostId)
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
    let workspace =
      project.workspaces.find((candidate) => hostPathEquals(candidate.root, root)) ??
      project.workspaces[0]!
    if (workspace.closed) {
      const reopened = openWorkspaceRecord(workspace)
      project.workspaces[project.workspaces.indexOf(workspace)] = reopened
      workspace = reopened
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
    return this.publishState()
  }

  async activate(
    projectId: string,
    workspaceId: string,
    options: { readonly emit?: boolean; readonly acknowledge?: boolean } = {},
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (workspace.missing) throw new Error('This worktree is no longer present')
    if (workspace.closed) throw new Error('Reopen this workspace before activating it')
    const host = await this.host(project.registeredRoot.hostId)
    if (host.connectionState !== 'connected') {
      throw new Error(`Connect to ${host.hostId} before opening this workspace`)
    }
    const previousProjectId = this.activeProjectId
    const previousActive = this.activeProject
    const previousWorkspaceId = project.activeWorkspaceId
    const previousNewState = workspace.newlyDiscovered
    project.activeWorkspaceId = workspace.id
    if (options.acknowledge !== false && workspace.newlyDiscovered) {
      project.workspaces = project.workspaces.map((candidate) =>
        candidate.id === workspace.id
          ? { ...candidate, newlyDiscovered: false }
          : candidate,
      )
    }
    this.activeProjectId = project.id
    this.activeProject = {
      host,
      root: workspace.root,
      projectId: project.id,
      workspaceId: workspace.id,
    }
    try {
      await this.persist()
    } catch (error) {
      project.activeWorkspaceId = previousWorkspaceId
      project.workspaces = project.workspaces.map((candidate) =>
        candidate.id === workspace.id
          ? { ...candidate, newlyDiscovered: previousNewState }
          : candidate,
      )
      this.activeProjectId = previousProjectId
      this.activeProject = previousActive
      throw error
    }
    return this.publishState(options.emit !== false)
  }

  async acknowledgeWorkspace(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (!workspace.newlyDiscovered) return this.state()
    project.workspaces = project.workspaces.map((candidate) =>
      candidate.id === workspaceId ? { ...candidate, newlyDiscovered: false } : candidate,
    )
    try {
      await this.persist()
    } catch (error) {
      project.workspaces = project.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, newlyDiscovered: true }
          : candidate,
      )
      throw error
    }
    return this.publishState()
  }

  async reconcileWorktrees(
    projectId: string,
    discovery: WorktreeDiscovery,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Unknown project')
    const before = workspaceSignature(project.workspaces)
    const baselineEstablished = project.discoveryBaselineEstablished
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
        closed:
          existing?.closed === true &&
          !(existing.missing && discovered.prunable !== true),
        missing: discovered.prunable === true,
        ...(discovered.prunable === true
          ? {
              prunableReason:
                discovered.prunableReason ?? 'Git reported stale worktree metadata',
            }
          : {}),
        repository: discovery.repository,
        changedFiles: discovery.repository ? (existing?.changedFiles ?? 0) : 0,
        newlyDiscovered:
          existing?.newlyDiscovered ??
          (baselineEstablished && discovered.prunable !== true),
        ...(existing?.closed === true &&
        !(existing.missing && discovered.prunable !== true)
          ? { activityBaseline: existing.activityBaseline }
          : {}),
        ...(!existing?.closed && discovery.repository && existing?.latestActivity
          ? { latestActivity: existing.latestActivity }
          : {}),
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
    project.discoveryBaselineEstablished = true
    if (
      !project.workspaces.some((workspace) => workspace.id === project.activeWorkspaceId)
    ) {
      project.activeWorkspaceId =
        project.workspaces.find((workspace) => !workspace.missing && !workspace.closed)
          ?.id ?? ''
    }
    if (
      baselineEstablished === project.discoveryBaselineEstablished &&
      before === workspaceSignature(project.workspaces)
    ) {
      return this.state()
    }
    await this.persist()
    return this.publishState()
  }

  async updateWorkspaceActivity(
    projectId: string,
    activity: ReadonlyMap<string, WorkspaceActivityResult>,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Unknown project')
    const before = workspaceSignature(project.workspaces)
    project.workspaces = project.workspaces.map((workspace) => {
      const result = activity.get(workspace.id)
      if (!result) return workspace
      const current = workspaceActivitySnapshot(
        workspace.root,
        workspace.head,
        workspace.branch,
        result.status,
      )
      if (!workspace.closed) {
        const comparable =
          current && comparableWorkspaceActivity(current, current) ? current : undefined
        return {
          ...workspace,
          changedFiles: result.changedFiles,
          ...(comparable ? { latestActivity: comparable } : {}),
        }
      }
      if (!current || !comparableWorkspaceActivity(current, current)) {
        return { ...workspace, changedFiles: result.changedFiles }
      }
      if (!workspace.activityBaseline) {
        return {
          ...workspace,
          changedFiles: result.changedFiles,
          activityBaseline: current,
        }
      }
      if (workspaceActivityChanged(workspace.activityBaseline, current)) {
        return {
          ...workspace,
          closed: false,
          changedFiles: result.changedFiles,
          activityBaseline: undefined,
          latestActivity: current,
        }
      }
      return { ...workspace, changedFiles: result.changedFiles }
    })
    if (before === workspaceSignature(project.workspaces)) return this.state()
    await this.persist()
    return this.publishState()
  }

  async closeWorkspace(projectId: string, id: string): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find((candidate) => candidate.id === id)
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (this.activeProjectId === projectId && this.activeProject.workspaceId === id) {
      throw new Error('Select another workspace before closing this one')
    }
    if (workspace.missing) throw new Error('Only present workspaces can be closed')
    if (workspace.closed) return this.state()
    const baseline =
      workspace.latestActivity &&
      comparableWorkspaceActivity(workspace.latestActivity, workspace.latestActivity)
        ? workspace.latestActivity
        : undefined
    const index = project.workspaces.indexOf(workspace)
    project.workspaces[index] = {
      ...workspace,
      closed: true,
      activityBaseline: baseline,
      latestActivity: undefined,
      newlyDiscovered: false,
    }
    try {
      await this.persist()
    } catch (error) {
      project.workspaces[index] = workspace
      throw error
    }
    return this.publishState()
  }

  async reopenWorkspace(projectId: string, id: string): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find((candidate) => candidate.id === id)
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (!workspace.closed) return this.activate(projectId, id)
    if (workspace.missing) throw new Error('This worktree is no longer present')
    const index = project.workspaces.indexOf(workspace)
    project.workspaces[index] = openWorkspaceRecord(workspace)
    try {
      return await this.activate(projectId, id)
    } catch (error) {
      project.workspaces[index] = workspace
      throw error
    }
  }

  async restoreWorkspaceAfterFailedClose(
    projectId: string,
    id: string,
  ): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find((candidate) => candidate.id === id)
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (!workspace.closed) return this.state()
    const index = project.workspaces.indexOf(workspace)
    const reopened = openWorkspaceRecord(workspace)
    project.workspaces[index] = {
      ...reopened,
      ...(workspace.activityBaseline
        ? { latestActivity: workspace.activityBaseline }
        : {}),
    }
    try {
      await this.persist()
    } catch (error) {
      project.workspaces[index] = workspace
      throw error
    }
    return this.publishState()
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
          (candidate) =>
            candidate.id === project.activeWorkspaceId &&
            !candidate.missing &&
            !candidate.closed,
        ) ??
        project.workspaces.find((candidate) => !candidate.missing && !candidate.closed) ??
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
    return this.publishState()
  }

  async dismissWorkspace(projectId: string, id: string): Promise<ProjectState> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    const workspace = project?.workspaces.find((candidate) => candidate.id === id)
    if (!project || !workspace) throw new Error('Unknown project workspace')
    if (!workspace.missing) throw new Error('Only removed worktrees can be dismissed')
    const previousWorkspaces = project.workspaces
    const previousWorkspaceId = project.activeWorkspaceId
    const previousActive = this.activeProject
    let remaining = project.workspaces.filter((candidate) => candidate.id !== id)
    let next: WorkspaceRecord | undefined
    if (project.activeWorkspaceId === id) {
      next = remaining.find((candidate) => !candidate.missing && !candidate.closed)
      if (!next) {
        const closed = remaining.find((candidate) => !candidate.missing)
        if (closed) {
          const reopened = openWorkspaceRecord(closed)
          next = reopened
          remaining = remaining.map((candidate) =>
            candidate.id === closed.id ? reopened : candidate,
          )
        }
      }
      if (!next) throw new Error('A project must keep one workspace')
      project.activeWorkspaceId = next.id
      if (project.id === this.activeProjectId) {
        this.activeProject = {
          host: previousActive.host,
          root: next.root,
          projectId: project.id,
          workspaceId: next.id,
        }
      }
    }
    project.workspaces = remaining
    try {
      await this.persist()
    } catch (error) {
      project.workspaces = previousWorkspaces
      project.activeWorkspaceId = previousWorkspaceId
      this.activeProject = previousActive
      throw error
    }
    return this.publishState()
  }

  async dispose(): Promise<void> {
    await this.stopHostState()
    await this.pendingWrite
  }

  private async restoreActive(): Promise<void> {
    const project =
      this.projects.find((candidate) => candidate.id === this.activeProjectId) ??
      this.projects[0]!
    const workspace =
      project.workspaces.find(
        (candidate) =>
          candidate.id === project.activeWorkspaceId &&
          !candidate.missing &&
          !candidate.closed,
      ) ??
      project.workspaces.find((candidate) => !candidate.missing && !candidate.closed) ??
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
    const host = this.hostCatalog.hostById(project.registeredRoot.hostId)
    return {
      id: project.id,
      registeredRoot: project.registeredRoot,
      displayName: project.displayName,
      connectionState: host?.connectionState ?? 'disconnected',
      watchTier: host?.watchTier ?? 'polling',
      activeWorkspaceId: project.activeWorkspaceId,
      workspaces: project.workspaces.map(
        ({ activityBaseline: _baseline, latestActivity: _latest, ...workspace }) =>
          workspace,
      ),
    }
  }

  private publishState(emit = true): ProjectState {
    this.stateRevision += 1
    const state = this.state()
    if (emit) this.onState(state)
    return state
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
          discoveryBaselineEstablished: project.discoveryBaselineEstablished,
          activeWorkspacePath:
            project.workspaces.find(
              (workspace) => workspace.id === project.activeWorkspaceId,
            )?.root.path ?? project.registeredRoot.path,
          workspaces: project.workspaces.map((workspace) => ({
            path: workspace.root.path,
            head: workspace.head,
            branch: workspace.branch,
            main: workspace.main,
            closed: workspace.closed,
            missing: workspace.missing,
            prunableReason: workspace.prunableReason,
            repository: workspace.repository,
            changedFiles: workspace.changedFiles,
            newlyDiscovered: workspace.newlyDiscovered,
            activityBaseline: workspace.activityBaseline
              ? storedActivity(workspace.activityBaseline)
              : undefined,
          })),
        })),
      }
      await this.hostCatalog.local.writeFile(this.file, JSON.stringify(stored, null, 2))
    }
    const next = this.pendingWrite.then(write, write)
    this.pendingWrite = next.catch(() => undefined)
    return next
  }

  private async host(hostId: string): Promise<ProjectHost> {
    return this.hostCatalog.materializeHost(hostId)
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
    closed: false,
    missing: false,
    repository: false,
    changedFiles: 0,
  }
  return {
    id: projectId(root),
    registeredRoot: root,
    displayName: basenameHostPath(root) || root.path,
    activeWorkspaceId: workspace.id,
    discoveryBaselineEstablished: false,
    workspaces: [workspace],
  }
}

function openWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  return {
    ...workspace,
    closed: false,
    missing: false,
    prunableReason: undefined,
    activityBaseline: undefined,
    latestActivity: undefined,
  }
}

function compareWorkspaces(left: WorkspaceRecord, right: WorkspaceRecord): number {
  if (left.main !== right.main) return left.main ? -1 : 1
  if (left.closed !== right.closed) return left.closed ? 1 : -1
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
        closed,
        missing,
        prunableReason,
        repository,
        changedFiles,
        newlyDiscovered,
        activityBaseline,
      }) => ({
        id,
        head,
        branch,
        main,
        closed,
        missing,
        prunableReason,
        repository,
        changedFiles,
        newlyDiscovered,
        activityBaseline,
      }),
    ),
  )
}

function storedActivity(
  activity: WorkspaceActivitySnapshot,
): Omit<WorkspaceActivitySnapshot, 'root'> {
  const { root: _root, ...stored } = activity
  return stored
}

function restoredActivity(
  root: HostPath,
  value: unknown,
): WorkspaceActivitySnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const activity = { root, ...value } as WorkspaceActivitySnapshot
  return validActivitySnapshot(activity) && !activity.statusTruncated
    ? activity
    : undefined
}

async function loadProjects(
  host: ProjectHost,
  file: HostPath,
): Promise<{ activeProjectId: string; projects: ProjectRecord[] } | undefined> {
  try {
    const value: unknown = JSON.parse(await host.readTextFile(file))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const stored = value as Record<string, unknown>
    if (
      (stored['version'] !== PROJECT_REGISTRY_VERSION &&
        stored['version'] !== PREVIOUS_PROJECT_REGISTRY_VERSION &&
        stored['version'] !== LEGACY_PROJECT_REGISTRY_VERSION) ||
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
      const discoveryBaselineEstablished = item['discoveryBaselineEstablished'] === true
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
        const closed =
          stored['version'] === PROJECT_REGISTRY_VERSION && workspace['closed'] === true
        const prunableReason =
          missing &&
          typeof workspace['prunableReason'] === 'string' &&
          workspace['prunableReason'].length > 0 &&
          workspace['prunableReason'].length <= 1_024
            ? workspace['prunableReason']
            : undefined
        const activityBaseline = closed
          ? restoredActivity(workspaceRoot, workspace['activityBaseline'])
          : undefined
        workspaces.push({
          id: workspaceId(workspaceRoot),
          root: workspaceRoot,
          name: branch ?? basenameHostPath(workspaceRoot) ?? workspaceRoot.path,
          ...(head ? { head } : {}),
          ...(branch ? { branch } : {}),
          ...(prunableReason ? { prunableReason } : {}),
          main: workspace['main'] === true,
          closed,
          missing,
          repository: workspace['repository'] === true,
          changedFiles:
            typeof workspace['changedFiles'] === 'number' &&
            Number.isSafeInteger(workspace['changedFiles']) &&
            workspace['changedFiles'] >= 0
              ? workspace['changedFiles']
              : 0,
          newlyDiscovered: workspace['newlyDiscovered'] === true,
          ...(activityBaseline ? { activityBaseline } : {}),
        })
        workspaceCount++
      }
      if (workspaces.length === 0) workspaces.push(createProject(root).workspaces[0]!)
      if (!workspaces.some((workspace) => !workspace.missing && !workspace.closed)) {
        const fallback = workspaces.find((workspace) => !workspace.missing)
        if (fallback) {
          const index = workspaces.indexOf(fallback)
          workspaces[index] = {
            ...fallback,
            closed: false,
            activityBaseline: undefined,
          }
        }
      }
      const activeWorkspacePath = item['activeWorkspacePath']
      const activeWorkspace =
        typeof activeWorkspacePath === 'string'
          ? workspaces.find(
              (workspace) =>
                workspace.root.path === activeWorkspacePath &&
                !workspace.missing &&
                !workspace.closed,
            )
          : undefined
      projects.push({
        id: projectId(root),
        registeredRoot: root,
        displayName,
        activeWorkspaceId:
          activeWorkspace?.id ??
          workspaces.find((workspace) => !workspace.missing && !workspace.closed)?.id ??
          workspaces[0]!.id,
        discoveryBaselineEstablished:
          discoveryBaselineEstablished ||
          (stored['version'] === LEGACY_PROJECT_REGISTRY_VERSION &&
            workspaces.some((workspace) => workspace.repository)),
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
