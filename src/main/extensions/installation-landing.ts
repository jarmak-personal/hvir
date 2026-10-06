import { joinHostPath } from '../../shared/host-path'
import type {
  ExtensionInstallation,
  ExtensionView,
} from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionActivation, ExtensionActivationOwner } from './activation'
import type { ExtensionGuestOwner } from './guest-owner'

/** Prepare the exact accepted package's declared UI; selection stays with its live Add caller. */
export async function prepareInstallationLanding(
  activations: Pick<
    ExtensionActivationOwner,
    'active' | 'assertWritable' | 'directory' | 'packages'
  >,
  guests: Pick<ExtensionGuestOwner, 'open' | 'close'>,
  activation: ExtensionActivation,
  source: ExtensionInstallation,
  owner: RendererOwner,
  current: () => void,
  signal: AbortSignal,
): Promise<ExtensionView | undefined> {
  const manifest = activation.revision.manifest
  if (!manifest.landing) return undefined
  const declared = manifest.views.find((view) => view.id === manifest.landing)
  if (!declared || declared.placement !== 'application')
    throw new Error('Installation landing is unavailable')
  const admit = (): void => {
    signal.throwIfAborted()
    current()
    if (
      activations.active.get(activation.installationId) !== activation ||
      source.acceptedRevision !== activation.revision.hash
    )
      throw new Error('Installed extension changed before landing')
  }
  const validate = async (): Promise<void> => {
    admit()
    await activations.assertWritable()
    admit()
    const fresh = await activations.packages.captureSource(
      joinHostPath(activations.directory, source.source),
      signal,
    )
    await activations.assertWritable()
    admit()
    if (
      fresh.sourceIdentity !== activation.revision.sourceIdentity ||
      fresh.hash !== activation.revision.hash
    )
      throw new Error('Installed package source changed before landing')
  }
  await validate()
  let created: string | undefined
  const view = await guests.open(owner, activation.installationId, declared.id, admit, {
    context: { surface: declared.navigation === 'top' ? 'top' : 'viewer' },
    select: false,
    focus: false,
    onCreated: (view) => {
      created = view.id
    },
  })
  try {
    await validate()
    admit()
    return view
  } catch (reason) {
    if (created === view.id) await guests.close(owner, view.id)
    throw reason
  }
}
