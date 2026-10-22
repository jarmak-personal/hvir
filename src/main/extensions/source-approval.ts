import { randomUUID } from 'node:crypto'
import {
  asHostId,
  containsHostPath,
  hostPath,
  hostPathEquals,
  type HostPath,
} from '../../shared/host-path'
import {
  SOURCE_LIMITS,
  sameSourceBinding,
  type ExtensionSourceBinding,
  validateSourceDeclarations,
  type ExtensionSourceGrant,
  type ExtensionSourceSelection,
  type ExtensionSourceStatus,
} from '../../shared/extensions/source-access'
import type { AdmittedExtensionContext, ExtensionContextOwner } from './context-owner'
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
interface SourceIntent {
  readonly selection: ExtensionSourceSelection
  readonly binding?: ExtensionSourceBinding
  revoked: boolean
}
interface PreparedSource {
  readonly lifetime: SourceIntent
  readonly grant: ExtensionSourceGrant
  readonly activation: ExtensionActivation
  readonly current: () => void
  readonly expires: number
  approving?: boolean
  readonly prior?: SourceApprovalPrior
}
export interface SourceApprovalPrior {
  readonly grants: readonly ExtensionSourceGrant[]
}
/** Trusted root decisions; native executable admission and reported paths confer no scope. */
export class ExtensionSourceApprovalOwner {
  private grants: ExtensionSourceGrant[] = []
  private readonly prepared = new Map<string, PreparedSource>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure?: string
  private disposed = false
  private pruning = false
  private readonly decisions = new Set<SourceIntent>()
  constructor(
    readonly hosts: SourceHostCatalog,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable' | 'readSourceGrants' | 'saveSourceGrants'
    >,
    private readonly revoked: (
      installation: string,
      source?: string,
      binding?: ExtensionSourceBinding,
      cancelRequests?: boolean,
    ) => void,
    private readonly contexts?: Pick<ExtensionContextOwner, 'workspaces'>,
  ) {}
  async start(): Promise<void> {
    try {
      const value = await this.activations.readSourceGrants()
      if (!Array.isArray(value) || value.length > SOURCE_LIMITS.grants)
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
    prior?: SourceApprovalPrior,
  ): Promise<{ token: string; grant: ExtensionSourceGrant }> {
    this.prune()
    const registered = this.contexts
      ?.workspaces()
      .find((entry) => entry.id === selection.workspaceId)
    const lifetime: SourceIntent = {
      selection,
      revoked: false,
      ...(registered?.root
        ? { binding: { workspaceId: registered.id, root: registered.root } }
        : {}),
    }
    const assertIntent = () => {
      current()
      if (this.disposed || lifetime.revoked)
        throw new Error('Source decision was revoked')
    }
    if (this.decisions.size >= SOURCE_LIMITS.decisions)
      throw new Error('Too many pending source decisions')
    this.decisions.add(lifetime)
    let retained = false
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
        const workspace = registered
        if (!workspace?.root) throw new Error('Choose an available registered workspace')
        root = readSourcePath(workspace.root)
        if (
          declaration.mode === 'managed-delivery' &&
          root.hostId === this.hosts.local.hostId
        )
          throw new Error(
            'Managed delivery requires an explicitly selected SSH workspace',
          )
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
      if (prior) this.assertPrior(grant, prior)
      const token = randomUUID()
      this.prepared.set(token, {
        lifetime,
        grant,
        activation,
        current: assertIntent,
        expires: Date.now() + SOURCE_LIMITS.decisionMs,
        prior,
      })
      retained = true
      return { token, grant }
    } finally {
      if (!retained) this.decisions.delete(lifetime)
    }
  }
  /** Capture only the bindings this selection replaces, including old declarations. */
  capturePrior(selection: ExtensionSourceSelection): SourceApprovalPrior {
    const declaration = this.activations.active
      .get(selection.installationId)
      ?.revision.manifest.access.find((entry) => entry.id === selection.source)
    if (!declaration) throw new Error('Source declaration is unavailable')
    const root =
      declaration.context === 'workspace'
        ? this.contexts?.workspaces().find((entry) => entry.id === selection.workspaceId)
            ?.root
        : selection.root
    const grant = {
      installationId: selection.installationId,
      declaration,
      root,
      ...(declaration.context === 'workspace'
        ? { workspaceId: selection.workspaceId }
        : {}),
    }
    return { grants: this.grants.filter((entry) => replacedBy(entry, grant)) }
  }
  private assertPrior(grant: ExtensionSourceGrant, prior: SourceApprovalPrior): void {
    const current = this.grants.filter((entry) => replacedBy(entry, grant))
    if (
      current.length !== prior.grants.length ||
      current.some((entry, index) => entry !== prior.grants[index])
    )
      throw new Error('Saved file access changed; review setup again')
  }
  /** Reuse replacement identity across a complete proposal, including unselected bindings. */
  assertDistinct(grants: readonly ExtensionSourceGrant[]): void {
    if (
      grants.some((grant, index) =>
        grants
          .slice(0, index)
          .some((previous) => replacedBy(previous, grant) || replacedBy(grant, previous)),
      )
    )
      throw new Error('Duplicate source setup binding')
  }
  /** Same full-store replacement/count/serialization policy used by approve. */
  project(grants: readonly ExtensionSourceGrant[]): { records: number; bytes: number } {
    if (this.disposed || this.failure)
      throw new Error(this.failure ?? 'Source grants ended')
    this.assertDistinct(grants)
    const next = grants.reduce<ExtensionSourceGrant[]>(
      (state, grant) => [...state.filter((entry) => !replacedBy(entry, grant)), grant],
      this.grants,
    )
    return sourceCapacity(next)
  }
  /** Permission coverage only; selected-current reads still canonicalize and confine files. */
  async canReuseGrant(
    activation: ExtensionActivation,
    source: string,
    root: HostPath,
    current: () => void,
    context?: AdmittedExtensionContext,
  ): Promise<boolean> {
    await this.assertWritable()
    current()
    const existing = this.get(activation, source, context)
    return (
      !!existing?.root &&
      (existing.declaration.context === 'workspace'
        ? hostPathEquals(existing.root, root)
        : containsHostPath(existing.root, root))
    )
  }
  /**
   * Trusted coordinators prepare source consent; only this owner persists it.
   * Keep the handle live through every independent writer. Always call cancel() in
   * finally after success, reuse or failure; it retires the handle, never the grant.
   */
  async prepareWorkspaceRead(
    activation: ExtensionActivation,
    source: string,
    context: AdmittedExtensionContext,
    current: () => void,
    signal: AbortSignal,
  ): Promise<{
    grant: ExtensionSourceGrant
    reused: boolean
    current: () => void
    approve: () => Promise<void>
    cancel: () => void
  }> {
    const declaration = activation.revision.manifest.access.find(
      (entry) => entry.id === source,
    )
    if (
      declaration?.context !== 'workspace' ||
      declaration.mode !== 'read-only' ||
      !context.root ||
      !context.value.workspace
    )
      throw new Error('Choose an exact workspace read-only source')
    const root = context.root,
      workspaceId = context.value.workspace.id
    let ended = false
    const expires = Date.now() + SOURCE_LIMITS.decisionMs
    const live = () => {
      signal.throwIfAborted()
      current()
      if (
        ended ||
        Date.now() >= expires ||
        !context.current() ||
        this.activations.active.get(activation.installationId) !== activation
      )
        throw new Error('Workspace read decision ended')
    }
    live()
    await this.assertWritable()
    live()
    let grant = this.get(activation, source, context)
    const reused = !!grant
    const prepared = grant
      ? undefined
      : await this.prepare(
          { installationId: activation.installationId, source, workspaceId },
          live,
        )
    grant ??= prepared!.grant
    if (!sameSourceBinding(grant, { workspaceId, root })) {
      if (prepared) this.cancelPrepared(prepared.token)
      throw new Error('Workspace read scope changed')
    }
    let approved = reused
    const cancel = () => {
      ended = true
      if (prepared) this.cancelPrepared(prepared.token)
      signal.removeEventListener('abort', cancel)
    }
    signal.addEventListener('abort', cancel, { once: true })
    const check = () => {
      live()
      if (!this.scopeCurrent(grant)) throw new Error('Workspace read scope changed')
      if (
        approved
          ? this.get(activation, source, context) !== grant
          : !this.hasPrepared(prepared!.token)
      )
        throw new Error('Workspace read decision changed')
    }
    try {
      check()
    } catch (reason) {
      cancel()
      throw reason
    }
    return {
      grant,
      reused,
      current: check,
      cancel,
      approve: async () => {
        check()
        if (!approved) {
          await this.approve(prepared!.token)
          approved = true
        }
        check()
      },
    }
  }
  approve(token: string): Promise<void> {
    return this.serialize(async () => {
      this.prune()
      const decision = this.prepared.get(token)
      if (!decision) throw new Error('Inspect source access again before granting it')
      decision.approving = true
      const { grant, activation } = decision
      try {
        const current = () => {
          decision.current()
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
        if (decision.prior) this.assertPrior(grant, decision.prior)
        const remaining = this.grants.filter((entry) => !replacedBy(entry, grant))
        const next = [...remaining, grant]
        sourceCapacity(next)
        this.revoked(
          grant.installationId,
          grant.declaration.id,
          retainsWorkspaceBindings(grant) ? bindingOf(grant) : undefined,
        )
        this.grants = remaining
        await this.activations.saveSourceGrants(next, current)
        current()
        this.grants = [...this.grants.filter((entry) => !replacedBy(entry, grant)), grant]
      } finally {
        this.prepared.delete(token)
        this.decisions.delete(decision.lifetime)
      }
    })
  }
  cancelPrepared(token: string): void {
    const decision = this.prepared.get(token)
    if (decision) {
      decision.lifetime.revoked = true
      // Cancellation fences the result; physical approval still owns its admission slot.
      if (!decision.approving) this.decisions.delete(decision.lifetime)
    }
    this.prepared.delete(token)
  }
  hasPrepared(token: string): boolean {
    this.prune()
    return this.prepared.has(token)
  }
  revoke(
    installation: string,
    source?: string,
    value?: ExtensionSourceBinding,
  ): Promise<void> {
    const binding = value
      ? {
          workspaceId: extensionText(value.workspaceId, 'registered workspace', 256),
          root: readSourcePath(value.root),
        }
      : undefined
    this.discardPrepared(installation, source, binding)
    this.grants = this.grants.filter(
      (entry) =>
        entry.installationId !== installation ||
        (!!source && entry.declaration.id !== source) ||
        (!!binding && !sameSourceBinding(entry, binding)),
    )
    this.revoked(installation, source, binding, true)
    if (this.failure) return Promise.resolve()
    return this.serialize(async () => {
      await this.assertWritable()
      await this.activations.saveSourceGrants([...this.grants], () => {
        if (this.disposed) throw new Error('Source grants ended')
      })
    })
  }
  discardPrepared(
    installation: string,
    source?: string,
    binding?: ExtensionSourceBinding,
  ): void {
    for (const decision of this.decisions)
      if (
        decision.selection.installationId === installation &&
        (!source || decision.selection.source === source) &&
        (!binding || (decision.binding && sameSourceBinding(decision.binding, binding)))
      )
        decision.revoked = true
    for (const [token, entry] of this.prepared)
      if (entry.lifetime.revoked) this.cancelPrepared(token)
  }
  forget(installation: string): readonly ExtensionSourceGrant[] | undefined {
    this.discardPrepared(installation)
    if (!this.failure)
      this.grants = this.grants.filter((entry) => entry.installationId !== installation)
    this.revoked(installation, undefined, undefined, true)
    if (this.failure) return undefined
    return [...this.grants]
  }
  get(
    activation: ExtensionActivation,
    source: string,
    context?: AdmittedExtensionContext,
  ): ExtensionSourceGrant | undefined {
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
        this.scopeCurrent(entry) &&
        (entry.declaration.context === 'application' ||
          (!!context?.root &&
            context.current() &&
            sameSourceBinding(entry, {
              workspaceId: context.value.workspace?.id ?? '',
              root: context.root,
            }))),
    )
  }
  status(
    activation: ExtensionActivation,
    context?: AdmittedExtensionContext,
  ): readonly ExtensionSourceStatus[] {
    return activation.revision.manifest.access.map((entry) => {
      const grant = this.get(activation, entry.id, context)
      return {
        source: entry.id,
        granted: !!grant,
        ...(grant?.root ? { root: grant.root } : {}),
        ...(grant?.workspaceId ? { workspaceId: grant.workspaceId } : {}),
        ...(!grant
          ? {
              explanation:
                this.failure ??
                (entry.mode === 'read-only'
                  ? 'Allow read access when opening a file.'
                  : 'Grant delivery scope in Settings → Extensions.'),
            }
          : {}),
      }
    })
  }
  /** Trusted Settings can inspect retained bindings; guest status remains context-local. */
  settings(activation: ExtensionActivation): readonly ExtensionSourceStatus[] {
    return activation.revision.manifest.access.flatMap<ExtensionSourceStatus>(
      (declaration) => {
        const retained = this.grants.filter(
          (entry) =>
            entry.installationId === activation.installationId &&
            entry.declaration.id === declaration.id,
        )
        return retained.length
          ? retained.map((grant) => ({
              source: declaration.id,
              root: grant.root,
              workspaceId: grant.workspaceId,
              granted:
                !this.disposed &&
                !this.failure &&
                this.activations.active.get(activation.installationId) === activation &&
                JSON.stringify(grant.declaration) === JSON.stringify(declaration) &&
                this.scopeCurrent(grant),
            }))
          : [
              {
                source: declaration.id,
                granted: false,
                ...(this.failure ? { explanation: this.failure } : {}),
              },
            ]
      },
    )
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
    this.prepared.clear()
    this.decisions.clear()
    this.grants = []
  }
  private async assertWritable(): Promise<void> {
    if (this.disposed || this.failure)
      throw new Error(this.failure ?? 'Source grants ended')
    await this.activations.assertWritable()
  }
  private prune(): void {
    // Contextual current checks may ask hasPrepared about this same token.
    if (this.pruning) return
    this.pruning = true
    try {
      for (const [token, entry] of this.prepared) {
        try {
          entry.current()
          if (entry.expires > Date.now()) continue
        } catch {
          // Renderer teardown can invalidate a token without running React cleanup.
        }
        this.cancelPrepared(token)
      }
    } finally {
      this.pruning = false
    }
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
  return JSON.stringify([
    grant.installationId,
    grant.declaration.id,
    ...(retainsWorkspaceBindings(grant)
      ? [grant.workspaceId, grant.root?.hostId, grant.root?.path]
      : []),
  ])
}

function bindingOf(grant: ExtensionSourceGrant): ExtensionSourceBinding | undefined {
  return grant.workspaceId && grant.root
    ? { workspaceId: grant.workspaceId, root: grant.root }
    : undefined
}

function retainsWorkspaceBindings(grant: ExtensionSourceGrant): boolean {
  return (
    grant.declaration.context === 'workspace' && grant.declaration.mode === 'read-only'
  )
}

/** Only workspace read grants retain independent bindings across approvals. */
function replacedBy(previous: ExtensionSourceGrant, next: ExtensionSourceGrant): boolean {
  return (
    previous.installationId === next.installationId &&
    previous.declaration.id === next.declaration.id &&
    (!retainsWorkspaceBindings(next) ||
      !retainsWorkspaceBindings(previous) ||
      key(previous) === key(next))
  )
}
function sourceCapacity(state: readonly ExtensionSourceGrant[]): {
  records: number
  bytes: number
} {
  const bytes = Buffer.byteLength(JSON.stringify(state))
  if (state.length > SOURCE_LIMITS.grants || bytes > SOURCE_LIMITS.stateBytes)
    throw new Error('Source grant capacity reached; revoke an unused binding in Settings')
  return { records: state.length, bytes }
}
