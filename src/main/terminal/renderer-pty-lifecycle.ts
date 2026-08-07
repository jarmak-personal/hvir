import type { WebContents } from 'electron'

import {
  hostPathEquals,
  type HarnessProfile,
  type HostPath,
  type StartPtyRequest,
} from '../../shared'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import { sendRendererEvent } from '../renderer-event-delivery'
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

interface RendererPtyReattachDeps {
  readonly ptySupervisor: Pick<PtySupervisor, 'isAwaitingRendererAttachment'>
}

interface RetainedRendererPtyExpectation {
  readonly owner: RendererOwner
  readonly root: HostPath
  readonly cwd: HostPath
  readonly profile: HarnessProfile
  readonly request: Pick<StartPtyRequest, 'harnessSessionId'>
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

/** Checks the immutable authority and launch contract of a retained PTY. */
export function canAttachRetainedRendererPty(
  deps: RendererPtyReattachDeps,
  managed: ManagedPty,
  expected: RetainedRendererPtyExpectation,
): boolean {
  const { owner, root, cwd, profile, request } = expected
  return (
    managed.ownerId === owner.id &&
    managed.ownerGeneration === owner.generation &&
    managed.hostId === root.hostId &&
    managed.providerId === profile.providerId &&
    managed.profileId === profile.id &&
    managed.launchRevision === profile.launchRevision &&
    managed.providerContractVersion === profile.providerContractVersion &&
    managed.harnessSessionId === request.harnessSessionId &&
    hostPathEquals(managed.workspaceRoot, root) &&
    hostPathEquals(managed.cwd, cwd) &&
    deps.ptySupervisor.isAwaitingRendererAttachment(
      managed.id,
      owner.id,
      owner.generation,
    )
  )
}

export function registerRendererPty(
  deps: RendererPtyLifecycleDeps,
  owner: RendererOwner,
  root: HostPath,
  id: string,
): RendererResourceLease {
  let resourceOwner = owner
  return deps.rendererResources.register(
    owner,
    rendererPtyQualifier(root, id),
    () =>
      deps.ptySupervisor.disposeSession(id, resourceOwner.id, resourceOwner.generation),
    {
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
          sendRendererEvent(sender, 'pty:data', { id: managed.id, data })
        }
      },
      onExit: (exit) => {
        void detach()
        ptyLease.release()
        if (deps.rendererResources.isCurrent(owner) && !sender.isDestroyed()) {
          sendRendererEvent(sender, 'pty:exit', { id: managed.id, ...exit })
        }
      },
      onTelemetry: (telemetry) => {
        if (deps.rendererResources.isCurrent(owner) && !sender.isDestroyed()) {
          sendRendererEvent(sender, 'pty:telemetry', { id: managed.id, telemetry })
        }
      },
    },
    owner.generation,
  )
  return detach
}
