import { randomUUID } from 'node:crypto'

import {
  hostPathEquals,
  LOCAL_HOST_ID,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import { harnessProvider } from './bundled-harness-providers'
import type { HarnessRemoteImagePasteContract } from './harness-provider-contract'
import {
  RemoteImagePasteStorage,
  type RemoteImagePasteStoragePort,
} from './remote-image-paste-storage'

export {
  RemoteImagePasteStorage,
  type RemoteImagePasteStoragePort,
} from './remote-image-paste-storage'

export const REMOTE_IMAGE_PASTE_MAX_BYTES = 20 * 1024 * 1024
export const REMOTE_IMAGE_PASTE_MAX_PIXELS = 32 * 1024 * 1024
export const REMOTE_IMAGE_PASTE_MAX_DIMENSION = 8_192
export const REMOTE_IMAGE_PASTE_MAX_CONCURRENT = 2
export const REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS = 16
export const REMOTE_IMAGE_PASTE_MAX_HOST_BYTES = 64 * 1024 * 1024
export const REMOTE_IMAGE_PASTE_TRANSFER_TIMEOUT_MS = 15_000
export const REMOTE_IMAGE_PASTE_TTL_MS = 24 * 60 * 60_000
const REMOTE_IMAGE_PASTE_SHUTDOWN_TIMEOUT_MS = 2_000

export interface ClipboardPng {
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
}

export interface ClipboardPngSource {
  read(): ClipboardPng | 'too-large' | undefined
}

type ImagePastePtys = Pick<PtySupervisor, 'get' | 'isOwnedBy' | 'write' | 'onExit'>
type ImagePasteResources = Pick<RendererResourceScopes, 'assertCurrent' | 'register'>

export interface RemoteImagePasteCoordinatorOptions {
  readonly clipboard: ClipboardPngSource
  readonly ptys: ImagePastePtys
  readonly resources: ImagePasteResources
  readonly getHost: (hostId: string) => ProjectHost | undefined
  readonly storage?: RemoteImagePasteStoragePort
  readonly setTimer?: typeof setTimeout
  readonly clearTimer?: typeof clearTimeout
}

export type RemoteImagePasteOutcome =
  | { readonly outcome: 'forward-key' }
  | { readonly outcome: 'path-inserted' }
  | {
      readonly outcome: 'failed'
      readonly reason:
        | 'busy'
        | 'image-too-large'
        | 'target-changed'
        | 'transfer-failed'
    }

interface ImagePasteTarget {
  readonly instanceId: string
  readonly terminalId: string
  readonly owner: RendererOwner
  readonly host: ProjectHost
  readonly workspaceRoot: HostPath
  readonly providerId: string
  readonly capabilityRevision: number
  readonly contract: HarnessRemoteImagePasteContract
}

interface ImagePasteState {
  readonly id: string
  readonly target: ImagePasteTarget
  readonly controller: AbortController
  readonly byteLength: number
  resource?: RendererResourceLease
  stageTask?: Promise<HostPath>
  cleanupTask?: Promise<void>
  path?: HostPath
  timer?: ReturnType<typeof setTimeout>
  retired: boolean
  retained: boolean
}

/**
 * Owns explicit local-clipboard to SSH-composer image paste. It never watches
 * the clipboard, parses terminal output, or submits the provider composer.
 */
export class RemoteImagePasteCoordinator {
  private readonly storage: RemoteImagePasteStoragePort
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly states = new Set<ImagePasteState>()
  private readonly activeTerminals = new Set<string>()
  private readonly pendingCleanup = new Map<ProjectHost, Set<HostPath>>()
  private readonly hostDisposers = new Map<ProjectHost, () => void | Promise<void>>()
  private readonly disposePtyExit: () => void | Promise<void>
  private disposed = false

  constructor(private readonly options: RemoteImagePasteCoordinatorOptions) {
    this.storage = options.storage ?? new RemoteImagePasteStorage()
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.disposePtyExit = options.ptys.onExit((info) => this.retireTerminal(info.id))
  }

  async paste(
    terminalId: string,
    owner: RendererOwner,
  ): Promise<RemoteImagePasteOutcome> {
    if (this.disposed || !isTerminalId(terminalId)) {
      return { outcome: 'failed', reason: 'target-changed' }
    }
    const target = this.resolveTarget(terminalId, owner)
    if (target === 'forward-key') return { outcome: 'forward-key' }
    if (!target) return { outcome: 'failed', reason: 'target-changed' }
    if (
      this.activeTerminals.has(terminalId) ||
      this.activeTerminals.size >= REMOTE_IMAGE_PASTE_MAX_CONCURRENT
    ) {
      return { outcome: 'failed', reason: 'busy' }
    }

    let image: ClipboardPng | 'too-large' | undefined
    try {
      image = this.options.clipboard.read()
    } catch {
      return { outcome: 'failed', reason: 'transfer-failed' }
    }
    if (!image) return { outcome: 'forward-key' }
    if (image === 'too-large') return { outcome: 'failed', reason: 'image-too-large' }
    if (!boundedImage(image)) return { outcome: 'failed', reason: 'image-too-large' }
    if (!this.hasHostCapacity(target.host, image.bytes.byteLength)) {
      return { outcome: 'failed', reason: 'busy' }
    }

    const state: ImagePasteState = {
      id: randomUUID(),
      target,
      controller: new AbortController(),
      byteLength: image.bytes.byteLength,
      retired: false,
      retained: false,
    }
    try {
      state.resource = this.options.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'image-paste',
          root: target.workspaceRoot,
          id: state.id,
        },
        () => this.retire(state),
      )
    } catch {
      return { outcome: 'failed', reason: 'target-changed' }
    }
    this.states.add(state)
    this.activeTerminals.add(terminalId)

    try {
      void this.drainPendingCleanup(target.host)
      state.stageTask = this.storage
        .stage(target.host, image.bytes, state.controller.signal)
        .then((path) => {
          state.path = path
          return path
        })
      const path = await withTimeout(
        state.stageTask,
        REMOTE_IMAGE_PASTE_TRANSFER_TIMEOUT_MS,
        () => state.controller.abort(),
        this.setTimer,
        this.clearTimer,
      )
      if (!this.isCurrent(state)) {
        return { outcome: 'failed', reason: 'target-changed' }
      }
      const input = target.contract.terminalInput(path)
      this.options.ptys.write(terminalId, owner.id, input, owner.generation)
      state.retained = true
      state.timer = this.setTimer(() => {
        void state.resource?.dispose()
      }, REMOTE_IMAGE_PASTE_TTL_MS)
      return { outcome: 'path-inserted' }
    } catch {
      return {
        outcome: 'failed',
        reason: this.isCurrent(state) ? 'transfer-failed' : 'target-changed',
      }
    } finally {
      this.activeTerminals.delete(terminalId)
      if (!state.retained) await this.retire(state)
    }
  }

  async pasteOrForward(
    terminalId: string,
    owner: RendererOwner,
    fallbackData: string,
  ): Promise<void> {
    if (fallbackData !== '\x16' && fallbackData !== '\x1b\x16') return
    try {
      const result = await this.paste(terminalId, owner)
      if (
        result.outcome === 'forward-key' &&
        this.options.ptys.isOwnedBy(terminalId, owner.id, owner.generation)
      ) {
        this.options.ptys.write(terminalId, owner.id, fallbackData, owner.generation)
      }
    } catch {
      // A failed image path never degrades into unrelated prompt input.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    void this.disposePtyExit()
    await withTimeout(
      Promise.all([...this.states].map((state) => this.retire(state, true))),
      REMOTE_IMAGE_PASTE_SHUTDOWN_TIMEOUT_MS,
      () => undefined,
      this.setTimer,
      this.clearTimer,
    ).catch(() => undefined)
    for (const dispose of this.hostDisposers.values()) void dispose()
    this.hostDisposers.clear()
    this.pendingCleanup.clear()
  }

  private resolveTarget(
    terminalId: string,
    owner: RendererOwner,
  ): ImagePasteTarget | 'forward-key' | undefined {
    if (!this.options.ptys.isOwnedBy(terminalId, owner.id, owner.generation)) {
      return undefined
    }
    const terminal = this.options.ptys.get(terminalId)
    if (!terminal) return undefined
    if (terminal.hostId === LOCAL_HOST_ID) return 'forward-key'
    const provider = harnessProvider(terminal.providerId)
    if (!provider.remoteImagePaste) return 'forward-key'
    const host = this.options.getHost(terminal.hostId)
    if (!host || host.connectionState !== 'connected') return undefined
    return {
      instanceId: terminal.instanceId,
      terminalId,
      owner,
      host,
      workspaceRoot: terminal.workspaceRoot,
      providerId: terminal.providerId,
      capabilityRevision: provider.remoteImagePaste.revision,
      contract: provider.remoteImagePaste,
    }
  }

  private isCurrent(state: ImagePasteState): boolean {
    if (
      this.disposed ||
      state.retired ||
      state.target.host.connectionState !== 'connected'
    ) {
      return false
    }
    try {
      this.options.resources.assertCurrent(state.target.owner)
    } catch {
      return false
    }
    const current = this.options.ptys.get(state.target.terminalId)
    if (!current || !sameTarget(current, state.target)) return false
    try {
      const provider = harnessProvider(current.providerId)
      return (
        provider.remoteImagePaste?.revision === state.target.capabilityRevision &&
        this.options.ptys.isOwnedBy(
          current.id,
          state.target.owner.id,
          state.target.owner.generation,
        )
      )
    } catch {
      return false
    }
  }

  private retireTerminal(terminalId: string): void {
    for (const state of this.states) {
      if (state.target.terminalId === terminalId) void state.resource?.dispose()
    }
  }

  private hasHostCapacity(host: ProjectHost, byteLength: number): boolean {
    const material = [...this.states].filter(
      (state) => !state.retired && state.target.host.hostId === host.hostId,
    )
    return (
      material.length < REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS &&
      material.reduce((total, state) => total + state.byteLength, byteLength) <=
        REMOTE_IMAGE_PASTE_MAX_HOST_BYTES
    )
  }

  private retire(state: ImagePasteState, awaitPending = false): Promise<void> {
    if (state.retired) {
      return awaitPending && state.cleanupTask
        ? state.cleanupTask
        : Promise.resolve()
    }
    state.retired = true
    state.controller.abort()
    if (state.timer) this.clearTimer(state.timer)
    state.resource?.release()
    const cleanupTask = state.path
      ? this.cleanupPath(state.target.host, state.path)
      : state.stageTask?.then(
          (path) => this.cleanupPath(state.target.host, path),
          () => undefined,
        )
    if (!cleanupTask) {
      this.states.delete(state)
      return Promise.resolve()
    }
    state.cleanupTask = cleanupTask.finally(() => this.states.delete(state))
    return awaitPending || state.path ? state.cleanupTask : Promise.resolve()
  }

  private async cleanupPath(host: ProjectHost, path: HostPath): Promise<void> {
    try {
      await this.storage.remove(host, path)
    } catch {
      if (this.disposed) return
      let paths = this.pendingCleanup.get(host)
      if (!paths) {
        paths = new Set()
        this.pendingCleanup.set(host, paths)
      }
      paths.add(path)
      this.observeHost(host)
    }
  }

  private observeHost(host: ProjectHost): void {
    if (this.disposed || this.hostDisposers.has(host)) return
    this.hostDisposers.set(
      host,
      host.onConnectionState((state) => {
        if (state === 'connected') void this.drainPendingCleanup(host)
      }),
    )
  }

  private async drainPendingCleanup(host: ProjectHost): Promise<void> {
    const paths = this.pendingCleanup.get(host)
    if (!paths || host.connectionState !== 'connected') return
    for (const path of [...paths]) {
      try {
        await this.storage.remove(host, path)
        paths.delete(path)
      } catch {
        break
      }
    }
    if (paths.size === 0) {
      this.pendingCleanup.delete(host)
      const dispose = this.hostDisposers.get(host)
      this.hostDisposers.delete(host)
      try {
        await dispose?.()
      } catch {
        // Removing an idle observer is best effort.
      }
    }
  }
}

function boundedImage(image: ClipboardPng): boolean {
  return (
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.width <= REMOTE_IMAGE_PASTE_MAX_DIMENSION &&
    image.height <= REMOTE_IMAGE_PASTE_MAX_DIMENSION &&
    image.width * image.height <= REMOTE_IMAGE_PASTE_MAX_PIXELS &&
    image.bytes.byteLength > 0 &&
    image.bytes.byteLength <= REMOTE_IMAGE_PASTE_MAX_BYTES
  )
}

function sameTarget(current: ManagedPty | undefined, target: ImagePasteTarget): boolean {
  return Boolean(
    current &&
    current.instanceId === target.instanceId &&
    current.id === target.terminalId &&
    current.ownerId === target.owner.id &&
    current.ownerGeneration === target.owner.generation &&
    current.hostId === target.host.hostId &&
    current.providerId === target.providerId &&
    hostPathEquals(current.workspaceRoot, target.workspaceRoot),
  )
}

function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  schedule: typeof setTimeout,
  cancel: typeof clearTimeout,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    task,
    new Promise<T>((_resolve, reject) => {
      timer = schedule(() => {
        onTimeout()
        reject(new Error('Remote image transfer timed out'))
      }, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) cancel(timer)
  })
}
