import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type BrowseHostResponse,
  type ConnectedHost,
  type ProjectHostOption,
  type ProjectState,
  type SshPromptRequest,
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
}

export class ProjectRegistry {
  private readonly hosts = new Map<string, ProjectHost>()
  private activeProject: ActiveProject

  private constructor(
    private readonly local: LocalHost,
    initialRoot: HostPath,
    private readonly aliases: readonly SshAliasConfig[],
    private readonly prompter: SshAuthPrompter,
    private readonly trust: HostTrustStore,
    private readonly onState: (state: ProjectState) => void,
  ) {
    this.hosts.set(local.hostId, local)
    this.activeProject = { host: local, root: initialRoot }
  }

  static async create(
    initialRoot: HostPath,
    prompter: SshAuthPrompter,
    trustFile: string,
    onState: (state: ProjectState) => void,
  ): Promise<ProjectRegistry> {
    const local = new LocalHost()
    await local.connect()
    const canonicalRoot = await local.realpath(initialRoot)
    const aliases = await loadSshAliases(local)
    const trust = await HostTrustStore.load(local, localPath(trustFile))
    return new ProjectRegistry(local, canonicalRoot, aliases, prompter, trust, onState)
  }

  get active(): ActiveProject {
    return this.activeProject
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
    await host.dispose()
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
      if (code === 2 || code === 'ENOENT') throw new Error(`Folder not found: ${rawPath}`)
      if (code === 3 || code === 'EACCES')
        throw new Error(`Cannot access folder: ${rawPath}`)
      throw reason
    }
  }

  async open(hostId: string, path: string): Promise<ProjectState> {
    const host = await this.host(hostId)
    await host.connect()
    const root = await host.realpath(hostPath(asHostId(hostId), path))
    const stat = await host.stat(root)
    if (stat.type !== 'dir') throw new Error(`Project root is not a directory: ${path}`)
    this.activeProject = { host, root }
    const state = projectState(this.activeProject)
    this.onState(state)
    return state
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((host) => host.dispose()))
  }

  private async host(hostId: string): Promise<ProjectHost> {
    const existing = this.hosts.get(hostId)
    if (existing) return existing
    const config = this.aliases.find((candidate) => candidate.alias === hostId)
    if (!config) throw new Error(`Unknown SSH host alias: ${hostId}`)
    const identities = await Promise.all(
      config.identityFiles.map(async (path) => {
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
      isHostKeyTrusted: (fingerprint) => this.trust.matches(config.alias, fingerprint),
      rememberHostKey: (fingerprint) => this.trust.remember(config.alias, fingerprint),
    })
    host.onConnectionState(() => {
      if (this.activeProject.host.hostId === host.hostId) {
        this.onState(projectState(this.activeProject))
      }
    })
    this.hosts.set(hostId, host)
    return host
  }
}

export class RendererSshPrompter implements SshAuthPrompter {
  private nextId = 0
  private readonly pending = new Map<
    number,
    (answers: readonly string[] | undefined) => void
  >()

  constructor(private readonly emit: (prompt: SshPromptRequest) => void) {}

  prompt(request: SshPrompt): Promise<readonly string[] | undefined> {
    const id = ++this.nextId
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.emit({ id, ...request })
    })
  }

  respond(id: number, answers?: readonly string[]): void {
    const resolve = this.pending.get(id)
    if (!resolve) return
    this.pending.delete(id)
    resolve(answers)
  }

  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve(undefined)
    this.pending.clear()
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
      return new HostTrustStore(
        host,
        file,
        parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {},
      )
    } catch {
      return new HostTrustStore(host, file, {})
    }
  }

  matches(alias: string, fingerprint: string): boolean {
    return this.fingerprints[alias] === fingerprint
  }

  async remember(alias: string, fingerprint: string): Promise<void> {
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

function projectState(project: ActiveProject): ProjectState {
  return {
    root: project.root,
    connectionState: project.host.connectionState,
    watchTier: project.host.watchTier,
  }
}
