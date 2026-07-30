import { onTestFinished } from 'vitest'

import {
  RendererResourceScopes,
  type RendererOwner,
  type RendererOwnerTransition,
  type RendererResourceLease,
  type RendererResourceQualifier,
  type RendererResourceRegistrationOptions,
} from '../../src/main/renderer-resource-scopes'
import { LOCAL_HOST_ID, asHostId, hostPath, type HostPath } from '../../src/shared'

export interface DeferredRendererCleanup {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

export interface RendererResourceFixture {
  readonly scopes: RendererResourceScopes
  readonly localRoot: HostPath
  readonly sshRoot: HostPath
  readonly events: readonly string[]
  readonly activateOwner: (id?: number) => RendererOwner
  readonly rolloverOwner: (id: number) => RendererOwnerTransition
  readonly destroyOwner: (id: number) => Promise<void>
  readonly register: (
    owner: RendererOwner,
    qualifier: RendererResourceQualifier,
    name: string,
    dispose?: () => void | Promise<void>,
    options?: RendererResourceRegistrationOptions,
  ) => RendererResourceLease
  readonly deferredCleanup: () => DeferredRendererCleanup
  readonly snapshot: () => {
    readonly events: readonly string[]
    readonly owners: readonly { id: number; generation: number }[]
  }
  readonly dispose: () => Promise<void>
}

/** Lifecycle fixture over the real main-owned renderer resource registry. */
export function createRendererResourceFixture(): RendererResourceFixture {
  const scopes = new RendererResourceScopes()
  const events: string[] = []
  const owners = new Map<number, RendererOwner>()
  let disposed: Promise<void> | undefined
  const fixture: RendererResourceFixture = {
    scopes,
    localRoot: hostPath(LOCAL_HOST_ID, '/project/local'),
    sshRoot: hostPath(asHostId('ssh-fixture'), '/srv/project'),
    events,
    activateOwner: (id = 10) => {
      const owner = scopes.activateOwner(id)
      owners.set(id, owner)
      events.push(`owner:${owner.id}:${owner.generation}`)
      return owner
    },
    rolloverOwner: (id) => {
      const transition = scopes.rolloverOwner(id)
      owners.set(id, transition.owner)
      events.push(`rollover:${transition.owner.id}:${transition.owner.generation}`)
      return transition
    },
    destroyOwner: (id) => {
      const cleanup = scopes.revokeOwner(id)
      owners.delete(id)
      events.push(`destroyed:${id}`)
      return cleanup
    },
    register: (owner, qualifier, name, dispose = () => undefined, options = {}) =>
      scopes.register(
        owner,
        qualifier,
        async () => {
          events.push(`disposed:${name}`)
          await dispose()
        },
        options,
      ),
    deferredCleanup: () => {
      let resolvePromise: () => void = () => undefined
      let rejectPromise: (error: unknown) => void = () => undefined
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
      })
      return { promise, resolve: resolvePromise, reject: rejectPromise }
    },
    snapshot: () => ({
      events: [...events],
      owners: [...owners.values()].map(({ id, generation }) => ({ id, generation })),
    }),
    dispose: () => (disposed ??= scopes.dispose()),
  }
  onTestFinished(fixture.dispose)
  return fixture
}
