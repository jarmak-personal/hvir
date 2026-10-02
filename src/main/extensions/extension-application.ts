import { shell } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionPlatformState } from '../../shared/extensions/workbench'
import { ExtensionActivationOwner } from './activation'
import { ElectronExtensionGuestSurface } from './electron-guest-surface'
import { ExtensionGuestOwner } from './guest-owner'
import { ExtensionPackageStore } from './package-store'

/** Application composition and lifetime of the extension platform; no extension package code. */
export class ExtensionApplicationRuntime {
  readonly surface = new ElectronExtensionGuestSurface()
  activations?: ExtensionActivationOwner
  guests?: ExtensionGuestOwner
  private starting?: Promise<void>
  private disposed = false
  private failure?: string

  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly events: RendererEventPublisher,
    private readonly userData: HostPath,
  ) {
    ElectronExtensionGuestSurface.registerScheme()
  }

  start(host: ProjectHost): Promise<void> {
    return (this.starting ??= this.initialize(host).catch(async (reason: unknown) => {
      this.failure = `Extensions could not start: ${reason instanceof Error ? reason.message.slice(0, 240) : 'storage unavailable'}. Check the extensions and extension-state folders in this data directory.`
      await this.activations?.dispose()
      await this.guests?.dispose()
      await this.surface.dispose()
      this.events.toWindows('extensions:state-changed', this.snapshot())
    }))
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
    await this.starting?.catch(() => undefined)
    await this.activations?.dispose()
    await this.guests?.dispose()
    await this.surface.dispose()
  }

  private async initialize(host: ProjectHost): Promise<void> {
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
      (id) => this.guests?.revokeInstallation(id),
      (state) => this.events.toWindows('extensions:state-changed', state),
    )
    this.activations = activations
    const guests = new ExtensionGuestOwner(
      activations,
      this.scopes,
      this.surface,
      (owner, views, selectedId) =>
        this.events.toRenderer(owner, 'extensions:views-changed', {
          views,
          ...(selectedId ? { selectedId } : {}),
        }),
    )
    this.guests = guests
    this.surface.connect(guests)
    await activations.start(joinHostPath(storage, 'writer.lock'))
    if (!this.disposed) this.events.toWindows('extensions:state-changed', this.snapshot())
  }
}
