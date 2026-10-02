import {
  ExtensionConnectorApprovalOwner,
  type ConnectorHostCatalog,
} from './connector-approval'
import { ExtensionConnectorExecutionOwner } from './connector-execution'
import { shell } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionPlatformState } from '../../shared/extensions/workbench'
import { ExtensionActivationOwner } from './activation'
import { ElectronExtensionGuestSurface } from './electron-guest-surface'
import { ExtensionGuestOwner } from './guest-owner'
import { ExtensionContextOwner } from './context-owner'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import { ExtensionActionOwner } from './action-owner'
import { ExtensionContributionOwner } from './contribution-owner'
import { ExtensionPresentationState } from './presentation-state'
import { ExtensionPackageStore } from './package-store'

/** Application composition and lifetime of the extension platform; no extension package code. */
export class ExtensionApplicationRuntime {
  connectors?: ExtensionConnectorExecutionOwner
  readonly surface = new ElectronExtensionGuestSurface()
  activations?: ExtensionActivationOwner
  guests?: ExtensionGuestOwner
  actions?: ExtensionActionOwner
  contributions?: ExtensionContributionOwner
  contexts?: ExtensionContextOwner
  private disposeContext?: () => void
  private publishedContributions?: string

  private connectContext(sources: LiveSessionMetadataSources): void {
    this.disposeContext?.()
    this.contexts = new ExtensionContextOwner(sources)
    this.disposeContext = this.contexts.observe(() => {
      if (!this.activations?.active.size) return
      this.actions?.revalidate()
      this.guests?.updateContext()
      this.guests?.presentationState?.pruneSessions(this.contexts!.sessionsForAll())
      this.contributions?.contextChanged()
      this.publishContributions()
    })
  }

  private publishContributions(): void {
    const snapshot = this.contributions?.snapshot() ?? []
    const current = JSON.stringify([this.contexts?.revision, snapshot])
    if (current === this.publishedContributions) return
    this.publishedContributions = current
    this.events.toWindows('extensions:contributions-changed', snapshot)
    this.guests?.publishValues()
  }
  private starting?: Promise<void>
  private disposed = false
  private failure?: string

  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly events: RendererEventPublisher,
    private readonly userData: HostPath,
  ) {}

  start(
    host: ProjectHost,
    sources: LiveSessionMetadataSources,
    hosts: ConnectorHostCatalog,
  ): Promise<void> {
    return (this.starting ??= this.initialize(host, sources, hosts).catch(
      async (reason: unknown) => {
        this.failure = `Extensions could not start: ${reason instanceof Error ? reason.message.slice(0, 240) : 'storage unavailable'}. Check the extensions and extension-state folders in this data directory.`
        this.connectors?.dispose()
        this.connectors?.approvals.dispose()
        await this.activations?.dispose()
        await this.guests?.dispose()
        await this.surface.dispose()
        this.events.toWindows('extensions:state-changed', this.snapshot())
      },
    ))
  }

  snapshot(): ExtensionPlatformState {
    if (this.failure)
      return { writable: false, explanation: this.failure, installations: [] }
    return (
      this.activations?.snapshot() ?? {
        writable: false,
        explanation: 'Extensions are starting',
        installations: [],
      }
    )
  }

  async openFolder(): Promise<void> {
    if (!this.activations) throw new Error('Extensions are unavailable')
    const result = await shell.openPath(this.activations.directory.path)
    if (result) throw new Error(result)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposeContext?.()
    await this.starting?.catch(() => undefined)
    this.connectors?.dispose()
    this.connectors?.approvals.dispose()
    await this.activations?.dispose()
    await this.guests?.dispose()
    await this.surface.dispose()
  }

  private async initialize(
    host: ProjectHost,
    sources: LiveSessionMetadataSources,
    hosts: ConnectorHostCatalog,
  ): Promise<void> {
    this.connectContext(sources)
    const contexts = this.contexts
    if (!contexts) throw new Error('Extension context admission is unavailable')
    const directory = joinHostPath(this.userData, 'extensions')
    const storage = joinHostPath(this.userData, 'extension-state')
    const packagesRoot = joinHostPath(storage, 'packages')
    for (const path of [directory, storage, packagesRoot]) {
      try {
        await host.createDirectoryExclusive(path, { mode: 0o755 })
      } catch (reason) {
        if ((reason as { code?: unknown }).code !== 'EEXIST') throw reason
      }
      const stat = await host.stat(path)
      if (stat.type !== 'dir')
        throw new Error('Extension folders must be ordinary local directories')
    }
    if (this.disposed) return
    const packages = new ExtensionPackageStore(host, packagesRoot)
    const activations = new ExtensionActivationOwner(
      host,
      directory,
      joinHostPath(storage, 'state.json'),
      packages,
      (id) => {
        this.connectors?.revoke(id)
        this.actions?.revokeInstallation(id)
        this.guests?.revokeInstallation(id)
        this.contributions?.revokeInstallation(id)
        this.publishContributions()
      },
      (state) => {
        this.events.toWindows('extensions:state-changed', state)
        this.publishContributions()
      },
      (id) => {
        this.guests?.presentationState?.forget(id)
        return this.connectors?.approvals.forget(id)
      },
    )
    this.activations = activations
    const scratch = joinHostPath(storage, 'connector-scratch')
    try {
      await host.createDirectoryExclusive(scratch, { mode: 0o755 })
    } catch (reason) {
      if ((reason as { code?: unknown }).code !== 'EEXIST') throw reason
    }
    if ((await host.stat(scratch)).type !== 'dir')
      throw new Error('Connector scratch must be an ordinary local directory')
    const approvals = new ExtensionConnectorApprovalOwner(
      hosts,
      activations,
      (id, connector) => this.connectors?.revoke(id, connector),
    )
    this.connectors = new ExtensionConnectorExecutionOwner(approvals, scratch, () =>
      activations.assertWritable(),
    )
    const guests = new ExtensionGuestOwner(
      activations,
      this.scopes,
      this.surface,
      (owner, views, selectedId, focus) =>
        this.events.toRenderer(owner, 'extensions:views-changed', {
          views,
          ...(selectedId ? { selectedId, focus: focus !== false } : {}),
        }),
      contexts,
    )
    this.guests = guests
    guests.connectors = this.connectors
    const presentation = new ExtensionPresentationState(
      {
        read: () => activations.readPresentation(),
        save: (value, current, signal) =>
          activations.savePresentation(value, current, signal),
      },
      () => this.publishContributions(),
    )
    guests.presentationState = presentation
    this.actions = new ExtensionActionOwner({
      open: (owner, installation, contribution, options, admit) =>
        guests.open(owner, installation, contribution, admit, options),
      dispatch: (view, invocation) => guests.dispatch(view, invocation),
      runnable: (view, id, admitted) => guests.runnable(view, id, admitted),
      cancelAction: (view, id) => guests.cancelAction(view, id),
      assertView: (view) => guests.assertView(view),
    })
    guests.actions = this.actions
    this.actions.changed = () => this.connectors?.revalidate()
    this.contributions = new ExtensionContributionOwner(
      activations,
      guests,
      () => contexts,
      presentation,
      this.scopes,
      () => this.publishContributions(),
    )
    guests.connectorDemand = (id, workspace) =>
      this.contributions?.connectorDemand(id, workspace) === true
    guests.updaterFailed = (view) => this.contributions?.failed(view)
    guests.visibleContributionsChanged = () => this.contributions?.contextChanged()
    guests.updaterSessions = (id) => this.contributions?.updaterSessions(id) ?? []
    this.surface.connect(guests)
    await activations.start(joinHostPath(storage, 'writer.lock'))
    if (activations.snapshot().writable) {
      await approvals.start()
      await presentation.restore()
    }
    this.publishContributions()
    if (!this.disposed) this.events.toWindows('extensions:state-changed', this.snapshot())
  }
}
