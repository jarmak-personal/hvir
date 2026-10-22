import { randomUUID } from 'node:crypto'
import { extensionRequestIdentity } from '../../shared/extensions/validation'
import type { ExtensionConnectionResult } from '../../shared/extensions/connectors'
import type {
  ExtensionAdditionResult,
  ExtensionInstallation,
} from '../../shared/extensions/workbench'
import {
  InstallationLandingCleanupError,
  type PreparedInstallationLanding,
} from './installation-landing'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionActivation, ExtensionActivationOwner } from './activation'
import type { HostPath } from '../../shared/host-path'

export interface ExtensionPackagePicker {
  pick(owner: RendererOwner): Promise<HostPath | undefined>
}

/** Trusted Add intent is revoked with its renderer; the activation writer owns all effects. */
export class ExtensionPackageAdditionOwner {
  private readonly intents = new Map<
    string,
    { owner: RendererOwner; setup: AbortController }
  >()

  cancelSetup(owner: RendererOwner, request: string): void {
    const intent = this.intents.get(request)
    if (intent?.owner.id === owner.id && intent.owner.generation === owner.generation)
      intent.setup.abort()
  }
  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly activations: ExtensionActivationOwner,
    private readonly picker: ExtensionPackagePicker,
    private readonly connected?: (
      activation: ExtensionActivation,
      owner: RendererOwner,
      signal: AbortSignal,
    ) => Promise<ExtensionConnectionResult>,
    private readonly landing?: (
      activation: ExtensionActivation,
      source: ExtensionInstallation,
      owner: RendererOwner,
      current: () => void,
      signal: AbortSignal,
    ) => Promise<PreparedInstallationLanding | undefined>,
    private readonly foreground: (owner: RendererOwner) => boolean = () => false,
    private readonly closeLanding?: (owner: RendererOwner, id: string) => Promise<void>,
  ) {
    if (landing && !closeLanding)
      throw new Error('Installation landing requires its guest cleanup owner')
  }

  async add(
    owner: RendererOwner,
    request: string = randomUUID(),
  ): Promise<ExtensionAdditionResult> {
    this.scopes.assertCurrent(owner)
    extensionRequestIdentity(request)
    if (this.intents.has(request) || this.intents.size >= 4)
      throw new Error('Invalid or busy extension installation request')
    const setup = new AbortController()
    const lifetime = new AbortController()
    const lease = this.scopes.register(
      owner,
      { lifetime: 'renderer', type: 'extension-package-import' },
      () => lifetime.abort(),
    )
    this.intents.set(request, { owner, setup })
    try {
      const receipt = await this.activations.add(
        () => this.picker.pick(owner),
        () => this.scopes.assertCurrent(owner),
        lifetime.signal,
      )
      // Installation is already committed. A declined/revoked continuation cannot undo it.
      let connection: ExtensionConnectionResult | undefined
      if (receipt.installed && !lifetime.signal.aborted && !setup.signal.aborted) {
        try {
          this.scopes.assertCurrent(owner)
          connection = await this.connected?.(
            receipt.installed,
            owner,
            AbortSignal.any([lifetime.signal, setup.signal]),
          )
        } catch {
          /* Current Settings status remains authoritative for connection outcomes. */
        }
      }
      let landing: PreparedInstallationLanding | undefined
      let landingCleanupError: InstallationLandingCleanupError | undefined
      const installed = receipt.installed
      const source = receipt.state.installations.find(
        (entry) => entry.installationId === installed?.installationId,
      )
      if (installed && source && this.landing) {
        const current = (): void => {
          lifetime.signal.throwIfAborted()
          setup.signal.throwIfAborted()
          this.scopes.assertCurrent(owner)
          if (!this.foreground(owner))
            throw new Error('Installation landing requires a foreground window')
        }
        try {
          current()
          landing = await this.landing(
            installed,
            source,
            owner,
            current,
            AbortSignal.any([lifetime.signal, setup.signal]),
          )
          current()
        } catch (reason) {
          if (reason instanceof InstallationLandingCleanupError)
            landingCleanupError = reason
          if (landing?.created)
            await this.closeLanding?.(owner, landing.view.id).catch((cause: unknown) => {
              landingCleanupError = new InstallationLandingCleanupError(cause)
            })
          landing = undefined
          /* The committed installation remains successful without automatic navigation. */
        }
      }
      return {
        ...receipt.state,
        ...(landingCleanupError ? { explanation: landingCleanupError.message } : {}),
        ...(installed
          ? {
              installed: landing
                ? {
                    installationId: installed.installationId,
                    landing: landing.view,
                    landingCreated: landing.created,
                  }
                : { installationId: installed.installationId },
            }
          : {}),
        ...(connection ? { connection } : {}),
      }
    } finally {
      this.intents.delete(request)
      setup.abort()
      lease.release()
    }
  }
}
