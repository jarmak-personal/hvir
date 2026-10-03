import { BrowserWindow } from 'electron'
import { joinHostPath, LOCAL_HOST_ID, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ProjectHostCatalog } from '../project-host/project-host-catalog'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import type { RendererResourceScopes, RendererOwner } from '../renderer-resource-scopes'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type {
  PtySupervisor,
  PtyAgentTarget,
  PtyAgentEnvironment,
  PtyAgentEnvironmentProvider,
} from '../pty/pty-supervisor'
import { plannedAgentEndpoint } from '../project-host/local-agent-endpoint'
import { AgentReportOwner } from '../viewer/agent-report-owner'
import { LocalAgentAccessOwner } from './access-owner'
import { AgentWorkbenchCommandOwner } from './command-owner'
import { LocalAgentSocketServer } from './socket-server'
import { AgentStreamAdmission } from './stream-admission'
import { AgentForwardScopeOwner } from './forward-scope'
import { RemoteAgentClientOwner } from './remote-client-owner'
import { InstalledAgentAssets } from './installed-agent-assets'
import type { AgentForwardGrant } from '../../shared/agent/contract'

/** Application composition for access/transport and viewer-owned content lifetimes. */
export class AgentApplicationRuntime {
  readonly reports: AgentReportOwner
  readonly access: LocalAgentAccessOwner
  private socket?: LocalAgentSocketServer
  private commands?: AgentWorkbenchCommandOwner
  private admission?: AgentStreamAdmission
  private remote?: RemoteAgentClientOwner
  private hosts?: Pick<ProjectHostCatalog, 'hostById'>
  readonly forwardScopes = new AgentForwardScopeOwner(() => this.publishAccess())
  private socketWork: Promise<void> = Promise.resolve()
  private host?: ProjectHost
  private starting?: Promise<void>
  private stopped = false
  private disposeProjects?: () => void
  private disposeEnvironment?: () => void
  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly events: RendererEventPublisher,
    private readonly userData: HostPath,
    private readonly extensions: ExtensionApplicationRuntime,
  ) {
    this.reports = new AgentReportOwner(() =>
      events.toWindows('agent:reports-changed', this.reports.snapshot()),
    )
    this.access = new LocalAgentAccessOwner(
      () => {
        if (!this.access.snapshot().enabled) {
          void this.closeEndpoint().catch(() => undefined)
          void this.remote?.revoke().catch(() => undefined)
        }
        this.publishAccess()
      },
      async (settings) => {
        if (!this.host || this.stopped)
          throw new Error('Agent access storage is unavailable')
        await this.reconcileEndpoint()
        await this.host.writeFile(
          joinHostPath(this.userData, 'agent-access.json'),
          JSON.stringify(settings),
        )
      },
      {
        allowed: () => this.extensions.activations?.agentAccess() ?? [],
        writable: () => this.extensions.snapshot().writable,
        signal: (id) => {
          if (!this.extensions.activations)
            throw new Error('Extension actions are unavailable')
          return this.extensions.activations.agentSignal(id)
        },
      },
    )
  }
  start(
    host: ProjectHost,
    sources: LiveSessionMetadataSources,
    hosts: Pick<ProjectHostCatalog, 'hostById'>,
    ptys: PtySupervisor,
  ): Promise<void> {
    if (!this.disposeEnvironment) {
      this.access.endpoint = plannedAgentEndpoint(this.access.instance)
      this.disposeEnvironment = ptys.agentEnvironment((target, signal) =>
        this.terminalEnvironment(target, signal),
      )
    }
    return (this.starting ??= this.initialize(host, sources, hosts).catch(
      (reason: unknown) => {
        this.access.explanation = `Agent access could not start: ${reason instanceof Error ? reason.message.slice(0, 160) : 'endpoint unavailable'}`
        this.access.dispose()
        this.publishAccess()
        void this.socket?.dispose()
      },
    ))
  }
  private async initialize(
    host: ProjectHost,
    sources: LiveSessionMetadataSources,
    hosts: Pick<ProjectHostCatalog, 'hostById'>,
  ): Promise<void> {
    this.host = host
    this.hosts = hosts
    try {
      const stored = await host.readTextFilePrefix(
        joinHostPath(this.userData, 'agent-access.json'),
        8192,
      )
      if (!stored.complete || stored.validUtf8 === false)
        throw new Error('Invalid agent access state')
      this.access.restore(JSON.parse(stored.content))
    } catch {
      this.access.restore(undefined)
    }
    if (this.stopped) return
    const assets = new InstalledAgentAssets(host)
    this.commands = new AgentWorkbenchCommandOwner({
      forwardScopes: this.forwardScopes,
      reference: (command) => assets.reference(command),
      contexts: () => this.extensions.contexts,
      activeInstallations: () => [
        ...(this.extensions.activations?.active.values() ?? []),
      ],
      activeInstallation: (id) => this.extensions.activations?.active.get(id),
      openView: (owner, installation, contribution, options, current) => {
        if (!this.extensions.guests) throw new Error('Extension views are unavailable')
        return this.extensions.guests.open(
          owner,
          installation,
          contribution,
          current,
          options,
        )
      },
      invokeAction: (...args) => {
        if (!this.extensions.actions) throw new Error('Extension actions are unavailable')
        return this.extensions.actions.invoke(...args)
      },
      access: this.access,
      reports: this.reports,
      presentationOwner: () => this.presentationOwner(),
      assertOwner: (owner) => this.scopes.assertCurrent(owner),
      host: (id) => hosts.hostById(id),
      openDocument: (owner, document) =>
        this.events.toRenderer(owner, 'agent:document-opened', document),
    })
    const commands = this.commands
    this.admission = new AgentStreamAdmission((request, connection) =>
      commands.run(request, connection),
    )
    this.remote = new RemoteAgentClientOwner({
      instance: this.access.instance,
      enabled: () => this.access.snapshot().enabled,
      assets: (target) => assets.client(target),
      admission: this.admission,
      scopes: this.forwardScopes,
      changed: () => this.publishAccess(),
    })
    await this.reconcileEndpoint()
    if (this.stopped) return
    this.access.ready = true
    const retainReports = (): void => {
      const ids = new Set(
        sources
          .projectState()
          .projects.flatMap((project) =>
            project.workspaces
              .filter((workspace) => !workspace.closed && !workspace.missing)
              .map((workspace) => workspace.id),
          ),
      )
      this.reports.retainWorkspaces(ids)
    }
    const disposeExtensions = this.extensions.observeState(() => this.publishAccess())
    const disposeProjects = sources.observeProjects(retainReports)
    this.disposeProjects = () => {
      disposeExtensions()
      disposeProjects()
    }
    retainReports()
    this.publishAccess()
  }
  private closeEndpoint(): Promise<void> {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return this.socketWork
    const closing = socket.dispose()
    return (this.socketWork = Promise.all([
      this.socketWork.catch(() => undefined),
      closing,
    ]).then(() => undefined))
  }
  private reconcileEndpoint(): Promise<void> {
    if (!this.access.snapshot().enabled || this.stopped) return this.closeEndpoint()
    return (this.socketWork = this.socketWork
      .catch(() => undefined)
      .then(async () => {
        if (
          !this.access.snapshot().enabled ||
          this.stopped ||
          this.socket ||
          !this.commands
        )
          return
        const commands = this.commands
        const socket = new LocalAgentSocketServer(
          (request, connection) => commands.run(request, connection),
          this.admission,
        )
        this.socket = socket
        await socket.start(this.access.instance)
        if (this.socket !== socket || this.stopped || !this.access.snapshot().enabled)
          await socket.dispose()
      }))
  }
  async configure(value: unknown): Promise<void> {
    await this.starting
    if (!this.access.ready || this.stopped) throw new Error('Agent access is not ready')
    await this.access.configure(value)
  }
  async configureExtension(installation: string, enabled: boolean): Promise<void> {
    if (!this.extensions.activations) throw new Error('Extension actions are unavailable')
    await this.extensions.activations.configureAgentAccess(installation, enabled)
  }
  private presentationOwner(): RendererOwner {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.webContents.isCrashed()
      )
        continue
      try {
        return this.scopes.currentIpcOwner(window.webContents.id)
      } catch {
        /* Not yet admitted for presentation. */
      }
    }
    throw new Error('Workbench presentation is unavailable')
  }
  private terminalEnvironment(
    target: PtyAgentTarget,
    signal: AbortSignal,
  ): ReturnType<PtyAgentEnvironmentProvider> {
    const context = this.extensions.contexts?.launchTarget(target)
    const defaults: Readonly<Record<string, string>> = context
      ? { HVIR_AGENT_WORKSPACE: context.workspace, HVIR_AGENT_SESSION: context.session }
      : {}
    if (this.stopped) return undefined
    if (target.workspaceRoot.hostId === LOCAL_HOST_ID) {
      return this.access.endpoint
        ? { env: { HVIR_AGENT_ENDPOINT: this.access.endpoint, ...defaults } }
        : undefined
    }
    return (async (): Promise<PtyAgentEnvironment> => {
      await this.starting
      const host = this.hosts?.hostById(target.workspaceRoot.hostId)
      if (!host || !this.remote || this.stopped)
        return { env: { HVIR_AGENT_UNAVAILABLE: 'SSH agent access is unavailable' } }
      const remote = await this.remote.environment(host, signal)
      return { ...remote, env: { ...remote.env, ...defaults } }
    })()
  }
  private publishAccess(): void {
    this.events.toWindows('agent:access-changed', this.snapshot())
  }
  snapshot() {
    return {
      ...this.access.snapshot(),
      forwards: this.remote?.snapshot() ?? [],
      forwardOptions: this.forwardOptions(),
    }
  }
  private forwardOptions(): AgentForwardGrant[] {
    const choices: AgentForwardGrant[] = []
    for (const forward of this.remote?.snapshot() ?? []) {
      if (forward.availability !== 'ready') continue
      for (const activation of this.extensions.activations?.active.values() ?? []) {
        if (!this.access.snapshot().extensions.includes(activation.installationId))
          continue
        for (const workspace of this.extensions.contexts?.workspaces() ?? []) {
          if (workspace.host !== forward.host) continue
          for (const action of activation.revision.manifest.actions ?? []) {
            if (!action.agents) continue
            for (const status of this.extensions.connectors?.approvals.status(
              activation,
            ) ?? []) {
              if (
                status.availability !== 'supported' ||
                !status.host ||
                status.host === forward.host
              )
                continue
              if (choices.length >= 128) return choices
              choices.push({
                host: forward.host,
                generation: forward.generation,
                installation: activation.installationId,
                revision: activation.revision.hash,
                action: action.id,
                capability: 'connector.execute',
                executionHost: status.host,
                workspace: workspace.id,
              })
            }
          }
        }
      }
    }
    return choices
  }
  configureForward(value: AgentForwardGrant, enabled: boolean): void {
    if (typeof enabled !== 'boolean' || !value || typeof value !== 'object')
      throw new Error('Invalid SSH capability grant')
    const known = this.forwardOptions().find(
      (choice) => JSON.stringify(choice) === JSON.stringify(value),
    )
    const existing = this.forwardScopes
      .grants(value.host)
      .find((choice) => JSON.stringify(choice) === JSON.stringify(value))
    if (!known && !(existing && !enabled))
      throw new Error('SSH grant binding is stale or unavailable')
    this.forwardScopes.configure(known ?? existing!, enabled)
  }
  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.access.dispose()
    this.disposeEnvironment?.()
    this.disposeProjects?.()
    await this.starting?.catch(() => undefined)
    await this.remote?.dispose()
    await this.closeEndpoint()
    this.admission?.dispose()
    this.reports.dispose()
  }
}
