import { randomUUID } from 'node:crypto'

import {
  hostPathEquals,
  parseLoopbackHttpTarget,
  type HostPath,
  type LoopbackHttpTarget,
  type WebPaneDiagnosticEvent,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { LoopbackHttpProxy, type ProxyCredentials } from './loopback-http-proxy'

export const MAX_OPEN_WEB_PANES = 16
export const MAX_OPEN_WEB_PANES_PER_HOST = 8
export const WEB_PANE_PARTITION_PREFIX = 'hvir-web-pane-'

export interface PrepareWebPaneSessionRequest {
  readonly partition: string
  readonly proxyPort: number
  readonly primaryUrl: string
}

export interface WebPaneRouteRegistryOptions {
  readonly prepareSession: (
    request: PrepareWebPaneSessionRequest,
  ) => Promise<() => Promise<void>>
  readonly destroyGuest: (guestId: number) => void
  readonly emitDiagnostic?: (
    ownerId: number,
    ownerGeneration: number,
    paneId: string,
    event: WebPaneDiagnosticEvent,
  ) => void
}

export interface OpenWebPaneRouteRequest {
  readonly ownerId: number
  readonly ownerGeneration?: number
  readonly sourceTerminalId: string
  readonly workspaceRoot: HostPath
  readonly host: ProjectHost
  readonly url: string
}

export interface OpenWebPaneRoute {
  readonly paneId: string
  readonly partition: string
  readonly url: string
  readonly origin: string
}

export type WebPaneNavigationDecision =
  | { readonly kind: 'allow'; readonly url: string }
  | { readonly kind: 'loopback'; readonly url: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'block' }

interface WebPaneRouteEntry extends OpenWebPaneRoute {
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly sourceTerminalId: string
  readonly workspaceRoot: HostPath
  readonly hostId: string
  readonly target: LoopbackHttpTarget
  readonly proxy: LoopbackHttpProxy
  readonly disposeSession: () => Promise<void>
  guestId?: number
  attachmentClaimed: boolean
  attachmentUrl: string
}

/** Main-owned capability registry for the complete web-pane lifecycle. */
export class WebPaneRouteRegistry {
  private readonly entries = new Map<string, WebPaneRouteEntry>()
  private readonly pending = new Map<string, Promise<WebPaneRouteEntry>>()
  private readonly pendingHostCounts = new Map<string, number>()
  private readonly ownerAllGenerations = new Map<number, number>()
  private readonly ownerGenerations = new Map<string, number>()
  private readonly workspaceGenerations = new Map<string, number>()
  private globalGeneration = 0

  constructor(private readonly options: WebPaneRouteRegistryOptions) {}

  async open(request: OpenWebPaneRouteRequest): Promise<OpenWebPaneRoute> {
    const target = parseLoopbackHttpTarget(request.url)
    if (!target) throw new Error('Invalid loopback HTTP URL')
    if (request.host.hostId !== request.workspaceRoot.hostId) {
      throw new Error('Web pane host does not own its workspace')
    }
    const ownerGeneration = request.ownerGeneration ?? 0
    const key = routeKey(
      request.ownerId,
      ownerGeneration,
      request.workspaceRoot,
      target.origin,
    )
    const existing = this.entryByKey(key)
    if (existing) {
      if (!existing.attachmentClaimed) existing.attachmentUrl = target.url
      return publicRoute(existing, target.url)
    }
    const pending = this.pending.get(key)
    if (pending) {
      const entry = await pending
      if (!entry.attachmentClaimed) entry.attachmentUrl = target.url
      return publicRoute(entry, target.url)
    }
    if (this.entries.size + this.pending.size >= MAX_OPEN_WEB_PANES) {
      throw new Error(`Too many live web panes (limit ${MAX_OPEN_WEB_PANES})`)
    }
    const pendingHostCount = this.pendingHostCounts.get(request.host.hostId) ?? 0
    const hostCount =
      [...this.entries.values()].filter((entry) => entry.hostId === request.host.hostId)
        .length + pendingHostCount
    if (hostCount >= MAX_OPEN_WEB_PANES_PER_HOST) {
      throw new Error(
        `Too many live web panes for this host (limit ${MAX_OPEN_WEB_PANES_PER_HOST})`,
      )
    }

    const ownerRevocationGeneration = this.ownerGeneration(
      request.ownerId,
      ownerGeneration,
    )
    const ownerAllGeneration = this.ownerAllGeneration(request.ownerId)
    const workspaceKey = hostPathKey(request.workspaceRoot)
    const workspaceGeneration = this.workspaceGeneration(workspaceKey)
    const globalGeneration = this.globalGeneration
    const create = this.createEntry(request, target).then(async (entry) => {
      if (
        globalGeneration !== this.globalGeneration ||
        ownerRevocationGeneration !==
          this.ownerGeneration(request.ownerId, ownerGeneration) ||
        ownerAllGeneration !== this.ownerAllGeneration(request.ownerId) ||
        workspaceGeneration !== this.workspaceGeneration(workspaceKey)
      ) {
        await disposeEntry(entry, this.options.destroyGuest)
        throw new Error('Web pane was revoked while opening')
      }
      this.entries.set(entry.paneId, entry)
      return entry
    })
    this.pending.set(key, create)
    this.pendingHostCounts.set(request.host.hostId, pendingHostCount + 1)
    try {
      return publicRoute(await create, target.url)
    } finally {
      this.pending.delete(key)
      const remaining = (this.pendingHostCounts.get(request.host.hostId) ?? 1) - 1
      if (remaining > 0) this.pendingHostCounts.set(request.host.hostId, remaining)
      else this.pendingHostCounts.delete(request.host.hostId)
    }
  }

  claimAttachment(request: {
    readonly ownerId: number
    readonly ownerGeneration?: number
    readonly paneId: string
    readonly partition: string
    readonly initialUrl: string
  }): OpenWebPaneRoute | undefined {
    const entry = this.entries.get(request.paneId)
    const target = parseLoopbackHttpTarget(request.initialUrl)
    if (
      !entry ||
      entry.ownerId !== request.ownerId ||
      (request.ownerGeneration !== undefined &&
        entry.ownerGeneration !== request.ownerGeneration) ||
      entry.partition !== request.partition ||
      entry.attachmentClaimed ||
      !target ||
      target.url !== entry.attachmentUrl
    ) {
      return undefined
    }
    entry.attachmentClaimed = true
    return publicRoute(entry, entry.attachmentUrl)
  }

  bindGuestForPartition(
    ownerId: number,
    partition: string,
    guestId: number,
    ownerGeneration?: number,
  ): string | undefined {
    const entry = [...this.entries.values()].find(
      (candidate) =>
        candidate.ownerId === ownerId &&
        (ownerGeneration === undefined ||
          candidate.ownerGeneration === ownerGeneration) &&
        candidate.partition === partition,
    )
    if (!entry || !entry.attachmentClaimed || entry.guestId !== undefined) {
      return undefined
    }
    entry.guestId = guestId
    return entry.paneId
  }

  proxyCredentials(
    guestId: number,
    challenge: {
      readonly isProxy: boolean
      readonly host: string
      readonly port: number
      readonly realm: string
    },
  ): ProxyCredentials | undefined {
    const entry = this.entryByGuest(guestId)
    if (
      !entry ||
      !challenge.isProxy ||
      challenge.host !== '127.0.0.1' ||
      challenge.port !== entry.proxy.port ||
      challenge.realm !== entry.proxy.credentials.realm
    ) {
      return undefined
    }
    return entry.proxy.credentials
  }

  navigation(guestId: number, rawUrl: string): WebPaneNavigationDecision {
    const entry = this.entryByGuest(guestId)
    return entry ? navigationDecision(entry, rawUrl) : { kind: 'block' }
  }

  navigationForPane(
    paneId: string,
    ownerId: number,
    rawUrl: string,
    ownerGeneration?: number,
  ): WebPaneNavigationDecision {
    const entry = this.entries.get(paneId)
    return entry &&
      entry.ownerId === ownerId &&
      (ownerGeneration === undefined || entry.ownerGeneration === ownerGeneration)
      ? navigationDecision(entry, rawUrl)
      : { kind: 'block' }
  }

  paneIdForGuest(guestId: number): string | undefined {
    return this.entryByGuest(guestId)?.paneId
  }

  source(
    paneId: string,
    ownerId: number,
    ownerGeneration?: number,
  ):
    | {
        readonly terminalId: string
        readonly workspaceRoot: HostPath
        readonly hostId: string
      }
    | undefined {
    const entry = this.entries.get(paneId)
    if (
      !entry ||
      entry.ownerId !== ownerId ||
      (ownerGeneration !== undefined && entry.ownerGeneration !== ownerGeneration)
    ) {
      return undefined
    }
    return {
      terminalId: entry.sourceTerminalId,
      workspaceRoot: entry.workspaceRoot,
      hostId: entry.hostId,
    }
  }

  async close(paneId: string, ownerId: number, ownerGeneration?: number): Promise<void> {
    const entry = this.entries.get(paneId)
    if (
      !entry ||
      entry.ownerId !== ownerId ||
      (ownerGeneration !== undefined && entry.ownerGeneration !== ownerGeneration)
    ) {
      return
    }
    this.entries.delete(paneId)
    await disposeEntry(entry, this.options.destroyGuest)
  }

  async closeOwner(ownerId: number, ownerGeneration?: number): Promise<void> {
    if (ownerGeneration === undefined) {
      this.ownerAllGenerations.set(ownerId, this.ownerAllGeneration(ownerId) + 1)
    } else {
      const key = ownerKey(ownerId, ownerGeneration)
      this.ownerGenerations.set(key, this.ownerGeneration(ownerId, ownerGeneration) + 1)
    }
    await this.closeWhere(
      (entry) =>
        entry.ownerId === ownerId &&
        (ownerGeneration === undefined || entry.ownerGeneration === ownerGeneration),
    )
  }

  async closeWorkspace(root: HostPath): Promise<void> {
    const key = hostPathKey(root)
    this.workspaceGenerations.set(key, this.workspaceGeneration(key) + 1)
    await this.closeWhere((entry) => hostPathEquals(entry.workspaceRoot, root))
  }

  async closeAll(): Promise<void> {
    this.globalGeneration++
    await Promise.allSettled([...this.pending.values()])
    await this.closeWhere(() => true)
  }

  has(paneId: string, ownerId: number, ownerGeneration?: number): boolean {
    const entry = this.entries.get(paneId)
    return (
      entry?.ownerId === ownerId &&
      (ownerGeneration === undefined || entry.ownerGeneration === ownerGeneration)
    )
  }

  private async createEntry(
    request: OpenWebPaneRouteRequest,
    target: LoopbackHttpTarget,
  ): Promise<WebPaneRouteEntry> {
    const paneId = randomUUID()
    const partition = `${WEB_PANE_PARTITION_PREFIX}${paneId}`
    const proxy = new LoopbackHttpProxy({
      host: request.host,
      endpoint: target.endpoint,
      onDiagnostic: (event) =>
        this.options.emitDiagnostic?.(
          request.ownerId,
          request.ownerGeneration ?? 0,
          paneId,
          event,
        ),
    })
    await proxy.open()
    let disposeSession: (() => Promise<void>) | undefined
    try {
      disposeSession = await this.options.prepareSession({
        partition,
        proxyPort: proxy.port,
        primaryUrl: target.url,
      })
      return {
        paneId,
        partition,
        url: target.url,
        origin: target.origin,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration ?? 0,
        sourceTerminalId: request.sourceTerminalId,
        workspaceRoot: request.workspaceRoot,
        hostId: request.host.hostId,
        target,
        proxy,
        disposeSession,
        attachmentClaimed: false,
        attachmentUrl: target.url,
      }
    } catch (error) {
      await proxy.close()
      if (disposeSession) await disposeSession().catch(() => undefined)
      throw error
    }
  }

  private entryByKey(key: string): WebPaneRouteEntry | undefined {
    return [...this.entries.values()].find(
      (entry) =>
        routeKey(
          entry.ownerId,
          entry.ownerGeneration,
          entry.workspaceRoot,
          entry.origin,
        ) === key,
    )
  }

  private entryByGuest(guestId: number): WebPaneRouteEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.guestId === guestId)
  }

  private ownerGeneration(ownerId: number, generation: number): number {
    return this.ownerGenerations.get(ownerKey(ownerId, generation)) ?? 0
  }

  private ownerAllGeneration(ownerId: number): number {
    return this.ownerAllGenerations.get(ownerId) ?? 0
  }

  private workspaceGeneration(key: string): number {
    return this.workspaceGenerations.get(key) ?? 0
  }

  private async closeWhere(
    predicate: (entry: WebPaneRouteEntry) => boolean,
  ): Promise<void> {
    const entries = [...this.entries.values()].filter(predicate)
    for (const entry of entries) this.entries.delete(entry.paneId)
    await Promise.all(
      entries.map((entry) => disposeEntry(entry, this.options.destroyGuest)),
    )
  }
}

function navigationDecision(
  entry: WebPaneRouteEntry,
  rawUrl: string,
): WebPaneNavigationDecision {
  const loopback = parseLoopbackHttpTarget(rawUrl)
  if (loopback) {
    return loopback.origin === entry.origin
      ? { kind: 'allow', url: loopback.url }
      : { kind: 'loopback', url: loopback.url }
  }
  try {
    const target = new URL(rawUrl)
    if (
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      target.username.length === 0 &&
      target.password.length === 0
    ) {
      return { kind: 'external', url: target.href }
    }
  } catch {
    // Invalid URLs are always blocked.
  }
  return { kind: 'block' }
}

function publicRoute(entry: WebPaneRouteEntry, url = entry.url): OpenWebPaneRoute {
  return { paneId: entry.paneId, partition: entry.partition, url, origin: entry.origin }
}

async function disposeEntry(
  entry: WebPaneRouteEntry,
  destroyGuest: (guestId: number) => void,
): Promise<void> {
  if (entry.guestId !== undefined) destroyGuest(entry.guestId)
  await entry.proxy.close().catch(() => undefined)
  await entry.disposeSession().catch(() => undefined)
}

function routeKey(
  ownerId: number,
  ownerGeneration: number,
  root: HostPath,
  origin: string,
): string {
  return `${ownerId}:${ownerGeneration}:${hostPathKey(root)}:${origin}`
}

function ownerKey(ownerId: number, ownerGeneration: number): string {
  return `${ownerId}:${ownerGeneration}`
}

function hostPathKey(root: HostPath): string {
  return `${root.hostId}:${root.path}`
}
