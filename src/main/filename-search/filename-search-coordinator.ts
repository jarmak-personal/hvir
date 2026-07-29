import type { FilenameSearchResponse, HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import {
  enumerateFilenames,
  type FilenameEnumeration,
  type FilenameEnumerationLimits,
  type GitIgnorePort,
} from './filename-enumerator'
import { rankFilenameMatches } from './filename-search-policy'

const CACHE_LIFETIME_MS = 10_000

export interface FilenameSearchInput {
  readonly owner: RendererOwner
  readonly host: ProjectHost
  readonly root: HostPath
  readonly canonicalRoot: HostPath | Promise<HostPath>
  readonly query: string
  readonly includeIgnored: boolean
  readonly gitIgnoreAvailable: boolean
  readonly refreshVersion: number
  readonly requestId: number
}

type ResolvedFilenameSearchInput = Omit<FilenameSearchInput, 'canonicalRoot'> & {
  readonly canonicalRoot: HostPath
}

interface CachedIndex extends FilenameEnumeration {
  readonly key: string
  readonly expiresAt: number
}

interface ActiveIndex {
  readonly key: string
  readonly controller: AbortController
  readonly promise: Promise<FilenameEnumeration>
}

interface OwnerState {
  sequence: number
  latestRequestId: number
  cache?: CachedIndex
  active?: ActiveIndex
}

export class FilenameSearchCoordinator {
  private readonly owners = new Map<string, OwnerState>()

  constructor(
    private readonly gitIgnore: GitIgnorePort,
    private readonly limits?: Partial<FilenameEnumerationLimits>,
  ) {}

  async search(input: FilenameSearchInput): Promise<FilenameSearchResponse> {
    validateInput(input)
    if (input.host.connectionState !== 'connected') {
      throw new Error('Reconnect to search this host.')
    }
    const ownerKey = keyOwner(input.owner)
    const state = this.owners.get(ownerKey) ?? { sequence: 0, latestRequestId: 0 }
    this.owners.set(ownerKey, state)
    if (input.requestId <= state.latestRequestId) {
      throw new Error('Filename search request was superseded')
    }
    state.latestRequestId = input.requestId
    const sequence = ++state.sequence
    const canonicalRoot = await input.canonicalRoot
    if (state.sequence !== sequence || this.owners.get(ownerKey) !== state) {
      throw new Error('Filename search request was superseded')
    }
    if (canonicalRoot.hostId !== input.host.hostId) {
      throw new Error('Invalid filename search request')
    }
    const resolved = { ...input, canonicalRoot }
    const key = indexKey(resolved)
    const index = await this.index(state, key, resolved)
    if (state.sequence !== sequence || this.owners.get(ownerKey) !== state) {
      throw new Error('Filename search request was superseded')
    }
    if (input.host.connectionState !== 'connected') {
      throw new Error('Reconnect to search this host.')
    }
    const ranked = rankFilenameMatches(index.files, input.query)
    return {
      results: ranked.results,
      filesScanned: index.files.length,
      traversalTruncated: index.truncated,
      resultsTruncated: ranked.truncated,
    }
  }

  cancel(owner: RendererOwner, requestId: number): void {
    if (!Number.isSafeInteger(requestId) || requestId < 1) return
    const ownerKey = keyOwner(owner)
    const state = this.owners.get(ownerKey) ?? {
      sequence: 0,
      latestRequestId: 0,
    }
    this.owners.set(ownerKey, state)
    state.latestRequestId = Math.max(state.latestRequestId, requestId)
    state.sequence++
    state.active?.controller.abort(new Error('Filename search workspace changed'))
    state.active = undefined
    state.cache = undefined
  }

  revoke(owner: RendererOwner): void {
    const state = this.owners.get(keyOwner(owner))
    if (!state) return
    state.sequence++
    state.active?.controller.abort(new Error('Filename search owner was revoked'))
    this.owners.delete(keyOwner(owner))
  }

  dispose(): void {
    for (const state of this.owners.values()) {
      state.active?.controller.abort(new Error('Filename search was disposed'))
    }
    this.owners.clear()
  }

  private async index(
    state: OwnerState,
    key: string,
    input: ResolvedFilenameSearchInput,
  ): Promise<FilenameEnumeration> {
    const now = Date.now()
    if (state.cache?.key === key && state.cache.expiresAt > now) return state.cache
    if (state.active?.key === key) return state.active.promise
    state.active?.controller.abort(new Error('Filename search workspace changed'))
    state.active = undefined
    state.cache = undefined
    const controller = new AbortController()
    const stopConnection = input.host.onConnectionState((connection) => {
      if (connection !== 'connected') {
        controller.abort(new Error('Reconnect to search this host.'))
      }
    })
    const promise = enumerateFilenames({
      host: input.host,
      root: input.root,
      canonicalRoot: input.canonicalRoot,
      includeIgnored: input.includeIgnored,
      gitIgnore: input.gitIgnoreAvailable ? this.gitIgnore : undefined,
      signal: controller.signal,
      limits: this.limits,
    }).finally(stopConnection)
    const active = { key, controller, promise }
    state.active = active
    try {
      const result = await promise
      if (state.active !== active || controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Filename search was cancelled')
      }
      state.cache = { ...result, key, expiresAt: Date.now() + CACHE_LIFETIME_MS }
      return result
    } finally {
      if (state.active === active) state.active = undefined
    }
  }
}

function validateInput(input: FilenameSearchInput): void {
  if (
    input.query.length > 1_024 ||
    !Number.isSafeInteger(input.refreshVersion) ||
    input.refreshVersion < 0 ||
    !Number.isSafeInteger(input.requestId) ||
    input.requestId < 1 ||
    input.root.hostId !== input.host.hostId
  ) {
    throw new Error('Invalid filename search request')
  }
}

function indexKey(input: ResolvedFilenameSearchInput): string {
  return [
    input.root.hostId,
    input.root.path,
    input.canonicalRoot.path,
    input.includeIgnored ? 'ignored' : 'default',
    input.gitIgnoreAvailable ? 'git' : 'plain',
    input.refreshVersion,
  ].join('\0')
}

function keyOwner(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
