import { randomUUID, createHash } from 'node:crypto'
import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import { repositoryImageMimeType } from '../../shared/rendered-link'
import {
  SOURCE_LIMITS,
  type ExtensionSourceGrant,
} from '../../shared/extensions/source-access'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import type { ExtensionActivation } from './activation'
import type { AdmittedExtensionContext } from './context-owner'
import {
  ExtensionSourceApprovalOwner,
  readSourcePath,
  type SourceHostPort,
} from './source-approval'
import type { DocumentMarkdownOwner } from '../viewer/document-markdown-owner'
import { authorizeAgentDocument } from '../viewer/document-read-authority'

export interface SourceCaller {
  readonly activation: ExtensionActivation
  readonly view: string
  readonly allowed: boolean
  readonly signal: AbortSignal
  current(): void
  context(): AdmittedExtensionContext | undefined
}
interface SelectedSource {
  readonly caller: SourceCaller
  readonly grant: ExtensionSourceGrant
  readonly host: SourceHostPort
  readonly root: HostPath
  readonly path: HostPath
  canonical?: HostPath
  readonly context?: AdmittedExtensionContext
  readonly controller: AbortController
  readonly expires: number
  readonly encoding: 'utf8' | 'base64'
  readonly resource: 'document' | 'asset' | 'rendered'
  readonly parent?: SelectedSource
  timer?: ReturnType<typeof setTimeout>
  data?: Buffer
}
/** Selection and finite body retention; no tool domain, path-derived grants or agent text. */
export class ExtensionSourceReadingOwner {
  private readonly selected = new Map<string, SelectedSource>()
  private disposed = false
  private readonly stopHosts: () => void
  private readonly reading = new Set<SelectedSource>()
  constructor(
    readonly approvals: ExtensionSourceApprovalOwner,
    private readonly markdown?: DocumentMarkdownOwner,
  ) {
    this.stopHosts = approvals.hosts.onHostStateChange?.(() => this.prune()) ?? (() => {})
  }
  async select(caller: SourceCaller, value: unknown): Promise<unknown> {
    this.prune()
    this.assertCaller(caller)
    const input = extensionObject(value)
    const source = extensionText(input['source'], 'source identity', 80)
    const grant = this.approvals.get(caller.activation, source)
    if (!grant)
      throw new Error('Grant this source in Settings → Extensions before reading')
    const path = readSourcePath(input['path'])
    const context =
      grant.declaration.context === 'workspace' ? caller.context() : undefined
    const root = grant.root
    if (
      !root ||
      (grant.declaration.context === 'workspace' &&
        (!context?.root ||
          context.value.workspace?.id !== grant.workspaceId ||
          !hostPathEquals(context.root, root) ||
          (input['workspaceId'] !== undefined &&
            input['workspaceId'] !== grant.workspaceId)))
    )
      throw new Error('This source needs its exact registered workspace')
    const host = this.approvals.hosts.hostById(root.hostId)
    if (!host || host.connectionState !== 'connected')
      throw new Error('Source host is disconnected')
    // Replacing a selection revokes it before any asynchronous read or capacity admission.
    this.closeView(caller.view)
    const selected: SelectedSource = {
      caller,
      grant,
      host,
      root,
      path,
      ...(context ? { context } : {}),
      controller: new AbortController(),
      expires: Date.now() + SOURCE_LIMITS.receiptMs,
      encoding: 'utf8',
      resource: 'document',
    }
    const token = this.reserve(selected)
    try {
      if (grant.root && !hostPathEquals(await host.realpath(root), root))
        throw new Error('Granted source root changed')
      this.current(selected)
      const canonical = await authorizeAgentDocument(host, root, path, () =>
        this.current(selected),
      )
      const workload = await host.readTextFilePrefix(canonical, SOURCE_LIMITS.textBytes, {
        pollingInterest: false,
      })
      this.current(selected)
      if (!workload.complete || workload.validUtf8 === false)
        throw new Error('Selected document exceeds the UTF-8 text limit')
      const rechecked = await authorizeAgentDocument(host, root, path, () =>
        this.current(selected),
      )
      if (
        (grant.root && !hostPathEquals(await host.realpath(root), root)) ||
        !hostPathEquals(rechecked, canonical)
      )
        throw new Error('Selected source changed during its read')
      this.current(selected)
      selected.canonical = canonical
      selected.data = Buffer.from(workload.content, 'utf8')
      return {
        receipt: token,
        path: canonical,
        bytes: selected.data.length,
        sha256: createHash('sha256').update(selected.data).digest('hex'),
        readAt: Date.now(),
        currentFile: true,
      }
    } catch (reason) {
      this.remove(token)
      throw reason
    } finally {
      this.reading.delete(selected)
    }
  }
  async asset(caller: SourceCaller, value: unknown): Promise<unknown> {
    this.prune()
    this.assertCaller(caller)
    const input = extensionObject(value)
    const parent = this.receipt(caller, input['receipt'])
    if (parent.resource !== 'document')
      throw new Error('Image requests require the selected document')
    const relative = extensionText(input['path'], 'relative image', 4096)
    if (
      relative.startsWith('/') ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      /[?#:]/u.test(relative)
    )
      throw new Error('Only relative document images are supported')
    const path = joinHostPath(dirnameHostPath(parent.canonical ?? parent.path), relative)
    const mime = repositoryImageMimeType(path.path)
    if (
      !mime ||
      !containsHostPath(dirnameHostPath(parent.canonical ?? parent.path), path)
    )
      throw new Error('Image escapes the selected document directory')
    const selected: SelectedSource = {
      ...parent,
      parent,
      path,
      data: undefined,
      timer: undefined,
      canonical: undefined,
      controller: new AbortController(),
      encoding: 'base64',
      resource: 'asset',
    }
    const token = this.reserve(selected)
    try {
      const canonical = await authorizeAgentDocument(parent.host, parent.root, path, () =>
        this.current(selected),
      )
      const document = await parent.host.realpath(parent.path)
      this.current(selected)
      if (!parent.canonical || !hostPathEquals(document, parent.canonical))
        throw new Error('Selected document path changed')
      if (!containsHostPath(dirnameHostPath(document), canonical))
        throw new Error('Image escapes the selected document directory through a symlink')
      if ((await parent.host.stat(canonical)).size > SOURCE_LIMITS.assetBytes)
        throw new Error('Selected image exceeds its byte limit')
      this.current(selected)
      const transfer = parent.host.fileTransfer
      if (!transfer) throw new Error('Bounded image reading is unavailable on this host')
      const chunks: Buffer[] = []
      let bytes = 0
      const signal = AbortSignal.any([
        caller.signal,
        selected.controller.signal,
        parent.controller.signal,
      ])
      for await (const chunk of transfer.readFileChunks(canonical, { signal })) {
        this.current(selected)
        bytes += chunk.byteLength
        if (bytes > SOURCE_LIMITS.assetBytes)
          throw new Error('Selected image exceeds its byte limit')
        chunks.push(Buffer.from(chunk))
      }
      this.current(selected)
      const rechecked = await authorizeAgentDocument(parent.host, parent.root, path, () =>
        this.current(selected),
      )
      if (
        (parent.grant.root &&
          !hostPathEquals(await parent.host.realpath(parent.root), parent.root)) ||
        !hostPathEquals(rechecked, canonical) ||
        !hostPathEquals(await parent.host.realpath(parent.path), document)
      )
        throw new Error('Selected image changed during its read')
      this.current(selected)
      const data = Buffer.concat(chunks, bytes)
      selected.data = Buffer.from(data.toString('base64'), 'ascii')
      return { receipt: token, mime, bytes: data.length }
    } catch (reason) {
      this.remove(token)
      throw reason
    } finally {
      this.reading.delete(selected)
    }
  }
  async render(caller: SourceCaller, value: unknown): Promise<unknown> {
    this.prune()
    this.assertCaller(caller)
    if (!this.markdown) throw new Error('Document rendering is unavailable')
    const parent = this.receipt(caller, extensionObject(value)['receipt'])
    if (parent.resource !== 'document' || !parent.data)
      throw new Error('Select complete current UTF-8 instructions before rendering')
    const selected: SelectedSource = {
      ...parent,
      parent,
      data: undefined,
      timer: undefined,
      resource: 'rendered',
      controller: new AbortController(),
    }
    const token = this.reserve(selected)
    try {
      const html = await this.markdown.render(parent.data.toString('utf8'))
      this.current(selected)
      if (html === null) {
        this.remove(token)
        return { receipt: null, sourceFallback: true }
      }
      selected.data = Buffer.from(html, 'utf8')
      return { receipt: token, bytes: selected.data.length, sourceFallback: false }
    } catch (error) {
      this.remove(token)
      throw error
    } finally {
      this.reading.delete(selected)
    }
  }
  read(caller: SourceCaller, value: unknown): unknown {
    this.prune()
    this.assertCaller(caller)
    const input = extensionObject(value)
    const token = extensionText(input['receipt'], 'selection receipt', 80)
    const selected = this.receipt(caller, token)
    if (input['release'] === true) {
      this.remove(token)
      return null
    }
    const data = selected.data
    if (!data) throw new Error('Selected source is still opening')
    const offset = input['offset'] ?? 0
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      (offset as number) > data.length ||
      ((offset as number) < data.length && (data[offset as number]! & 0xc0) === 0x80)
    )
      throw new Error('Invalid source page offset')
    // Worst-case JSON escaping costs six bytes per ASCII byte; 2048 bytes also
    // leave room for the complete result envelope and bounded warning list.
    let end = Math.min(data.length, (offset as number) + SOURCE_LIMITS.pageBytes)
    while (end > (offset as number) && end < data.length && (data[end]! & 0xc0) === 0x80)
      end--
    return {
      data: data.subarray(offset as number, end).toString('utf8'),
      nextOffset: end < data.length ? end : null,
      encoding: selected.encoding,
    }
  }
  revalidate(): void {
    this.prune()
  }
  revoke(installation: string, source?: string): void {
    for (const [token, selected] of this.selected)
      if (
        selected.caller.activation.installationId === installation &&
        (!source || selected.grant.declaration.id === source)
      )
        this.remove(token)
  }
  closeView(view: string): void {
    for (const [token, selected] of this.selected)
      if (selected.caller.view === view) this.remove(token)
  }
  dispose(): void {
    this.disposed = true
    this.stopHosts()
    this.markdown?.dispose()
    for (const token of this.selected.keys()) this.remove(token)
  }
  private reserve(selected: SelectedSource): string {
    this.prune()
    const reservations = new Set([...this.selected.values(), ...this.reading])
    const reserved = [...reservations].reduce(
      (sum, entry) =>
        sum +
        (entry.encoding === 'utf8'
          ? SOURCE_LIMITS.textBytes
          : Math.ceil((SOURCE_LIMITS.assetBytes * 4) / 3)),
      0,
    )
    const bytes =
      selected.encoding === 'utf8'
        ? SOURCE_LIMITS.textBytes
        : Math.ceil((SOURCE_LIMITS.assetBytes * 4) / 3)
    if (
      reservations.size >= SOURCE_LIMITS.receipts ||
      reserved + bytes > SOURCE_LIMITS.receiptBytes
    )
      throw new Error('Selected source capacity is full; close unused details')
    const token = randomUUID()
    this.selected.set(token, selected)
    this.reading.add(selected)
    selected.timer = setTimeout(
      () => this.remove(token),
      Math.max(0, selected.expires - Date.now()),
    )
    selected.timer.unref()
    return token
  }
  private receipt(caller: SourceCaller, value: unknown): SelectedSource {
    const selected = this.selected.get(extensionText(value, 'selection receipt', 80))
    if (
      !selected ||
      selected.caller.view !== caller.view ||
      selected.caller.activation !== caller.activation
    )
      throw new Error('Selection receipt is stale or belongs to another view')
    this.current(selected)
    return selected
  }
  private assertCaller(caller: SourceCaller): void {
    if (this.disposed || !caller.allowed)
      throw new Error(
        'Instruction bodies are available only to ordinary human-selected views, never actions, agents or updaters',
      )
    caller.signal.throwIfAborted()
    caller.current()
  }
  private current(selected: SelectedSource): void {
    this.assertCaller(selected.caller)
    selected.controller.signal.throwIfAborted()
    if (
      selected.expires <= Date.now() ||
      this.approvals.get(selected.caller.activation, selected.grant.declaration.id) !==
        selected.grant ||
      this.approvals.hosts.hostById(selected.root.hostId) !== selected.host ||
      selected.host.connectionState !== 'connected' ||
      selected.context?.current() === false ||
      (selected.grant.workspaceId !== undefined &&
        (selected.caller.context()?.value.workspace?.id !== selected.grant.workspaceId ||
          !selected.caller.context()?.root ||
          !hostPathEquals(selected.caller.context()!.root!, selected.root)))
    )
      throw new Error('Selected source access ended')
    if (selected.parent) this.current(selected.parent)
  }
  private remove(token: string): void {
    const selected = this.selected.get(token)
    selected?.controller.abort()
    if (selected?.timer) clearTimeout(selected.timer)
    this.selected.delete(token)
  }
  private prune(): void {
    for (const [token, selected] of this.selected) {
      try {
        this.current(selected)
      } catch {
        this.remove(token)
      }
    }
  }
}
