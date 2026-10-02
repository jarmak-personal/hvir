import { BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ProjectHostCatalog } from '../project-host/project-host-catalog'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import type { RendererResourceScopes, RendererOwner } from '../renderer-resource-scopes'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { PtySupervisor, PtyAgentTarget } from '../pty/pty-supervisor'
import { readAgentGuide } from '../../agent-transport/reference-assets'
import { AgentReportOwner } from '../viewer/agent-report-owner'
import { LocalAgentAccessOwner } from './access-owner'
import { AgentWorkbenchCommandOwner } from './command-owner'
import { LocalAgentSocketServer } from './socket-server'

/** Application composition for access/transport and viewer-owned content lifetimes. */
export class AgentApplicationRuntime {
  readonly reports: AgentReportOwner
  readonly access: LocalAgentAccessOwner
  private socket?: LocalAgentSocketServer
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
      () => events.toWindows('agent:access-changed', this.access.snapshot()),
      async (settings) => {
        if (!this.host || this.stopped)
          throw new Error('Agent access storage is unavailable')
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
    return (this.starting ??= this.initialize(host, sources, hosts, ptys).catch(
      (reason: unknown) => {
        this.access.explanation = `Agent access could not start: ${reason instanceof Error ? reason.message.slice(0, 160) : 'endpoint unavailable'}`
        this.access.dispose()
        this.events.toWindows('agent:access-changed', this.access.snapshot())
        void this.socket?.dispose()
      },
    ))
  }
  private async initialize(
    host: ProjectHost,
    sources: LiveSessionMetadataSources,
    hosts: Pick<ProjectHostCatalog, 'hostById'>,
    ptys: PtySupervisor,
  ): Promise<void> {
    this.host = host
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
    const commands = new AgentWorkbenchCommandOwner({
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
      guide: readAgentGuide,
    })
    this.socket = new LocalAgentSocketServer((request, connection) =>
      commands.run(request, connection),
    )
    this.access.endpoint = await this.socket.start(this.access.instance)
    if (this.stopped) {
      await this.socket.dispose()
      return
    }
    this.disposeEnvironment = ptys.agentEnvironment((target) =>
      this.terminalEnvironment(target),
    )
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
    const disposeExtensions = this.extensions.observeState(() =>
      this.events.toWindows('agent:access-changed', this.access.snapshot()),
    )
    const disposeProjects = sources.observeProjects(retainReports)
    this.disposeProjects = () => {
      disposeExtensions()
      disposeProjects()
    }
    retainReports()
    this.events.toWindows('agent:access-changed', this.access.snapshot())
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
  ): Readonly<Record<string, string>> | undefined {
    const context = this.extensions.contexts?.launchTarget(target)
    if (!context || !this.access.endpoint || this.stopped) return undefined
    return {
      HVIR_AGENT_ENDPOINT: this.access.endpoint,
      HVIR_AGENT_WORKSPACE: context.workspace,
      HVIR_AGENT_SESSION: context.session,
    }
  }
  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.access.dispose()
    this.disposeEnvironment?.()
    this.disposeProjects?.()
    await this.starting?.catch(() => undefined)
    await this.socket?.dispose()
    this.reports.dispose()
  }
}
