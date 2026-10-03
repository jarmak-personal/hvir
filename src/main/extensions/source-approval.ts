import { randomUUID } from 'node:crypto'
import { asHostId, hostPath, hostPathEquals, type HostPath } from '../../shared/host-path'
import {
  SOURCE_LIMITS,
  validateSourceDeclarations,
  type ExtensionSourceGrant,
  type ExtensionSourceSelection,
  type ExtensionSourceStatus,
} from '../../shared/extensions/source-access'
import type { ExtensionContextOwner } from './context-owner'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import { assertNormalizedAbsoluteProjectPath } from '../project-file-operations/project-file-confinement'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionActivation, ExtensionActivationOwner } from './activation'

export type SourceHostPort = Pick<
  ProjectHost,
  'hostId' | 'connectionState' | 'realpath' | 'stat' | 'readTextFilePrefix'
> & {
  readonly fileTransfer?: Pick<NonNullable<ProjectHost['fileTransfer']>, 'readFileChunks'>
}
export interface SourceHostCatalog {
  readonly local: Pick<ProjectHost, 'hostId'>
  hostById(id: string): SourceHostPort | undefined
  onHostStateChange?(listener: () => void): () => void
}
interface PreparedSource {
  readonly grant: ExtensionSourceGrant
  readonly activation: ExtensionActivation
  readonly current: () => void
  readonly expires: number
  readonly intent: number
}
/** Trusted root decisions; native executable admission and reported paths confer no scope. */
export class ExtensionSourceApprovalOwner {
  private grants: ExtensionSourceGrant[] = []
  private readonly prepared = new Map<string, PreparedSource>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure?: string
  private disposed = false
  private intent = 0
  private preparing = 0
  constructor(
    readonly hosts: SourceHostCatalog,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable' | 'readSourceGrants' | 'saveSourceGrants'
    >,
    private readonly revoked: (installation: string, source?: string) => void,
    private readonly contexts?: Pick<ExtensionContextOwner, 'workspaces'>,
  ) {}
  async start(): Promise<void> {
    try {
      const value = await this.activations.readSourceGrants()
      if (!Array.isArray(value) || value.length > 32 * SOURCE_LIMITS.declarations)
        throw new Error('Invalid source grants')
      const grants = value.map((entry: unknown): ExtensionSourceGrant => {
        const item = extensionObject(entry)
        const declaration = validateSourceDeclarations([item['declaration']])[0]!
        const root = readSourcePath(item['root'])
        const workspaceId =
          declaration.context === 'workspace'
            ? extensionText(item['workspaceId'], 'registered workspace', 256)
            : undefined
        if (
          declaration.context === 'application' &&
          root.hostId !== this.hosts.local.hostId
        )
          throw new Error('Application sources require the local host')
        return {
          installationId: extensionText(item['installationId'], 'installation', 80),
          declaration,
          root,
          ...(workspaceId ? { workspaceId } : {}),
        }
      })
      if (new Set(grants.map(key)).size !== grants.length)
        throw new Error('Duplicate source grants')
      if (!this.disposed) this.grants = grants
    } catch {
      this.failure =
        'Saved read grants cannot be read safely. Repair extension-state/sources.json; independent isolated views remain available.'
    }
  }
  async prepare(
    selection: ExtensionSourceSelection,
    current: () => void,
  ): Promise<{ token: string; grant: ExtensionSourceGrant }> {
    this.prune()
    const intent = this.intent
    const assertIntent = () => {
      current()
      if (this.intent !== intent) throw new Error('Source decision was revoked')
    }
    if (this.prepared.size + this.preparing >= 4)
      throw new Error('Too many pending source decisions')
    this.preparing++
    try {
      await this.assertWritable()
      assertIntent()
      const activation = this.activations.active.get(selection.installationId)
      const declaration = activation?.revision.manifest.access.find(
        (entry) => entry.id === selection.source,
      )
      if (!activation || !declaration)
        throw new Error('Enable the declared extension before granting source access')
      let root: HostPath
      let workspaceId: string | undefined
      if (declaration.context === 'workspace') {
        if (selection.root !== undefined)
          throw new Error('Workspace roots come only from registered project context')
        workspaceId = extensionText(selection.workspaceId, 'registered workspace', 256)
        const workspace = this.contexts
          ?.workspaces()
          .find((entry) => entry.id === workspaceId)
        if (!workspace?.root) throw new Error('Choose an available registered workspace')
        root = readSourcePath(workspace.root)
      } else {
        if (selection.workspaceId !== undefined)
          throw new Error('Application source has no workspace')
        const selected = readSourcePath(selection.root)
        if (selected.hostId !== this.hosts.local.hostId)
          throw new Error('Application source roots are local')
        const host = this.hosts.hostById(selected.hostId)
        if (!host || host.connectionState !== 'connected')
          throw new Error('Source host is disconnected')
        root = await host.realpath(selected)
        assertNormalizedAbsoluteProjectPath(root)
        if (root.hostId !== selected.hostId || (await host.stat(root)).type !== 'dir')
          throw new Error('Choose an accessible source directory')
      }
      await this.assertWritable()
      assertIntent()
      if (this.activations.active.get(selection.installationId) !== activation)
        throw new Error('Source decision activation changed')
      const grant: ExtensionSourceGrant = {
        installationId: selection.installationId,
        declaration,
        root,
        ...(workspaceId ? { workspaceId } : {}),
      }
      const host = this.hosts.hostById(root.hostId)
      if (
        !host ||
        host.connectionState !== 'connected' ||
        !hostPathEquals(await host.realpath(root), root) ||
        (await host.stat(root)).type !== 'dir'
      )
        throw new Error('Source root changed; inspect it again')
      assertIntent()
      if (!this.scopeCurrent(grant)) throw new Error('Registered workspace changed')
      const token = randomUUID()
      this.prepared.set(token, {
        grant,
        activation,
        current: assertIntent,
        intent,
        expires: Date.now() + 60_000,
      })
      return { token, grant }
    } finally {
      this.preparing--
    }
  }
  approve(token: string): Promise<void> {
    return this.serialize(async () => {
      this.prune()
      const decision = this.prepared.get(token)
      this.prepared.delete(token)
      if (!decision) throw new Error('Inspect source access again before granting it')
      const { grant, activation } = decision
      const current = () => {
        decision.current()
        if (this.intent !== decision.intent)
          throw new Error('Source decision was revoked')
        if (
          this.disposed ||
          this.activations.active.get(grant.installationId) !== activation ||
          !this.scopeCurrent(grant)
        )
          throw new Error('Source decision ended')
      }
      await this.assertWritable()
      current()
      if (grant.root) {
        const host = this.hosts.hostById(grant.root.hostId)
        if (
          !host ||
          host.connectionState !== 'connected' ||
          !hostPathEquals(await host.realpath(grant.root), grant.root) ||
          (await host.stat(grant.root)).type !== 'dir'
        )
          throw new Error('Source root changed; inspect it again')
      }
      current()
      this.revoked(grant.installationId, grant.declaration.id)
      this.grants = this.grants.filter((entry) => key(entry) !== key(grant))
      await this.activations.saveSourceGrants([...this.grants, grant], current)
      current()
      this.grants = [...this.grants.filter((entry) => key(entry) !== key(grant)), grant]
    })
  }
  revoke(installation: string, source?: string): Promise<void> {
    this.revoked(installation, source)
    this.discardPrepared(installation, source)
    this.grants = this.grants.filter(
      (entry) =>
        entry.installationId !== installation ||
        (!!source && entry.declaration.id !== source),
    )
    if (this.failure) return Promise.resolve()
    return this.serialize(async () => {
      await this.assertWritable()
      await this.activations.saveSourceGrants([...this.grants], () => {
        if (this.disposed) throw new Error('Source grants ended')
      })
    })
  }
  discardPrepared(installation: string, source?: string): void {
    this.intent++
    for (const [token, entry] of this.prepared)
      if (
        entry.grant.installationId === installation &&
        (!source || entry.grant.declaration.id === source)
      )
        this.prepared.delete(token)
  }
  forget(installation: string): readonly ExtensionSourceGrant[] | undefined {
    this.revoked(installation)
    this.discardPrepared(installation)
    if (this.failure) return undefined
    this.grants = this.grants.filter((entry) => entry.installationId !== installation)
    return [...this.grants]
  }
  get(activation: ExtensionActivation, source: string): ExtensionSourceGrant | undefined {
    if (
      this.disposed ||
      this.failure ||
      this.activations.active.get(activation.installationId) !== activation
    )
      return undefined
    const declaration = activation.revision.manifest.access.find(
      (entry) => entry.id === source,
    )
    return this.grants.find(
      (entry) =>
        entry.installationId === activation.installationId &&
        entry.declaration.id === source &&
        JSON.stringify(entry.declaration) === JSON.stringify(declaration) &&
        this.scopeCurrent(entry),
    )
  }
  status(activation: ExtensionActivation): readonly ExtensionSourceStatus[] {
    return activation.revision.manifest.access.map((entry) => {
      const grant = this.get(activation, entry.id)
      return {
        source: entry.id,
        granted: !!grant,
        ...(grant?.root ? { root: grant.root } : {}),
        ...(grant?.workspaceId ? { workspaceId: grant.workspaceId } : {}),
        ...(!grant
          ? {
              explanation:
                this.failure ?? 'Grant read-only source access in Settings → Extensions',
            }
          : {}),
      }
    })
  }
  private scopeCurrent(grant: ExtensionSourceGrant): boolean {
    if (!grant.root) return false
    const host = this.hosts.hostById(grant.root.hostId)
    if (!host || host.connectionState !== 'connected') return false
    if (grant.declaration.context === 'application')
      return grant.root.hostId === this.hosts.local.hostId
    const workspace = this.contexts
      ?.workspaces()
      .find((entry) => entry.id === grant.workspaceId)
    return !!workspace?.root && hostPathEquals(workspace.root, grant.root)
  }
  dispose(): void {
    this.disposed = true
    this.intent++
    this.prepared.clear()
    this.grants = []
  }
  private async assertWritable(): Promise<void> {
    if (this.disposed || this.failure)
      throw new Error(this.failure ?? 'Source grants ended')
    await this.activations.assertWritable()
  }
  private prune(): void {
    for (const [token, entry] of this.prepared)
      if (entry.expires <= Date.now()) this.prepared.delete(token)
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation)
    this.pending = task.catch(() => undefined)
    return task
  }
}
export function readSourcePath(value: unknown): HostPath {
  const item = extensionObject(value)
  const result = hostPath(
    asHostId(extensionText(item['hostId'], 'source host', 128)),
    extensionText(item['path'], 'source path', 4096),
  )
  if (Buffer.byteLength(result.path) > 4096)
    throw new Error('Source path exceeds 4096 bytes')
  assertNormalizedAbsoluteProjectPath(result)
  return result
}
function key(grant: ExtensionSourceGrant): string {
  return JSON.stringify([grant.installationId, grant.declaration.id])
}
