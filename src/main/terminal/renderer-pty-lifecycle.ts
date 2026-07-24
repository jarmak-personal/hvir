import type { WebContents } from 'electron'

import type { HostPath } from '../../shared'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceQualifier,
  RendererResourceScopes,
} from '../renderer-resource-scopes'

interface RendererPtyLifecycleDeps {
  readonly rendererResources: RendererResourceScopes
  readonly ptySupervisor: PtySupervisor
}

export function rendererPtyQualifier(
  root: HostPath,
  id: string,
): RendererResourceQualifier {
  return {
    lifetime: 'workspace',
    type: 'pty-session',
    root,
    id,
  }
}

export function registerRendererPty(
  deps: RendererPtyLifecycleDeps,
  owner: RendererOwner,
  root: HostPath,
  id: string,
  duplicate?: 'reuse',
): RendererResourceLease {
  let resourceOwner = owner
  return deps.rendererResources.register(
    owner,
    rendererPtyQualifier(root, id),
    () =>
      deps.ptySupervisor.disposeSession(id, resourceOwner.id, resourceOwner.generation),
    {
      duplicate,
      rollover: (nextOwner) => {
        const transferred = deps.ptySupervisor.transferRendererSession(
          id,
          resourceOwner.id,
          resourceOwner.generation,
          nextOwner.id,
          nextOwner.generation,
        )
        if (transferred) resourceOwner = nextOwner
        return transferred
      },
    },
  )
}

export function attachRendererPty(
  deps: RendererPtyLifecycleDeps,
  managed: ManagedPty,
  ptyLease: RendererResourceLease,
  owner: RendererOwner,
  sender: WebContents,
): () => void | Promise<void> {
  let detach: () => void | Promise<void> = () => undefined
  detach = deps.ptySupervisor.attach(
    managed.id,
    owner.id,
    {
      onData: (data) => {
        if (deps.rendererResources.isCurrent(owner) && !sender.isDestroyed()) {
          sender.send('pty:data', { id: managed.id, data })
        }
      },
      onExit: (exit) => {
        void detach()
        ptyLease.release()
        if (deps.rendererResources.isCurrent(owner) && !sender.isDestroyed()) {
          sender.send('pty:exit', { id: managed.id, ...exit })
        }
      },
      onTelemetry: (telemetry) => {
        if (deps.rendererResources.isCurrent(owner) && !sender.isDestroyed()) {
          sender.send('pty:telemetry', { id: managed.id, telemetry })
        }
      },
    },
    owner.generation,
  )
  return detach
}
