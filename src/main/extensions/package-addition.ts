import type { ExtensionPlatformState } from '../../shared/extensions/workbench'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionActivationOwner } from './activation'
import type { HostPath } from '../../shared/host-path'

export interface ExtensionPackagePicker {
  pick(owner: RendererOwner): Promise<HostPath | undefined>
}

/** Trusted Add intent is revoked with its renderer; the activation writer owns all effects. */
export class ExtensionPackageAdditionOwner {
  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly activations: ExtensionActivationOwner,
    private readonly picker: ExtensionPackagePicker,
  ) {}

  async add(owner: RendererOwner): Promise<ExtensionPlatformState> {
    this.scopes.assertCurrent(owner)
    const lifetime = new AbortController()
    const lease = this.scopes.register(
      owner,
      { lifetime: 'renderer', type: 'extension-package-import' },
      () => lifetime.abort(),
    )
    try {
      return await this.activations.add(
        () => this.picker.pick(owner),
        () => this.scopes.assertCurrent(owner),
        lifetime.signal,
      )
    } finally {
      lease.release()
    }
  }
}
