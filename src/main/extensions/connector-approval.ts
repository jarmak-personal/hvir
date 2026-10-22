import { randomUUID } from 'node:crypto'
import { hostPath } from '../../shared/host-path'
import {
  extensionId,
  extensionObject,
  extensionText,
} from '../../shared/extensions/validation'
import {
  CONNECTOR_LIMITS,
  connectorConfiguration,
  validateConnectorDeclarations,
  type ExtensionConnectorApproval,
  type ExtensionConnectorDeclaration,
  type ExtensionConnectorSelection,
  type ExtensionConnectorStatus,
  type ExtensionConnectorSetting,
} from '../../shared/extensions/connectors'
import type { ProjectHost } from '../project-host/project-host'
import type { ProjectHostOption } from '../../shared'
import type { ExtensionActivationOwner, ExtensionActivation } from './activation'

export type ConnectorHostPort = Pick<
  ProjectHost,
  'hostId' | 'connectionState' | 'realpath' | 'stat' | 'finiteExec' | 'connect'
> & {
  readonly streamLocal?: Pick<
    NonNullable<ProjectHost['streamLocal']>,
    'generation' | 'signal' | 'assertCurrent'
  >
}

export interface ConnectorHostCatalog {
  readonly local: Pick<ProjectHost, 'hostId'>
  listHosts(): readonly ProjectHostOption[]
  hostById(id: string): ConnectorHostPort | undefined
  materializeHost(id: string): Promise<ConnectorHostPort>
  onHostStateChange(listener: () => void): () => void
}
interface PreparedApproval {
  readonly approval: ExtensionConnectorApproval
  readonly activation: ExtensionActivation
  readonly trustUpdates: boolean
  readonly hostCurrent: () => boolean
  readonly expires: number
  readonly current: () => void
  readonly decision: ApprovalDecision
  readonly prior: { readonly approval: ExtensionConnectorApproval | undefined }
}
interface ApprovalDecision {
  readonly installationId: string
  readonly connector: string
  readonly host: string
  readonly controller: AbortController
}

interface SessionTrust {
  readonly approval: ExtensionConnectorApproval
  readonly current: () => boolean
  readonly stop: () => void
}
export type ConnectorExecutableResolution =
  | { readonly executable: string; readonly current: () => boolean }
  | {
      readonly reason:
        | 'executable-changed'
        | 'disconnected'
        | 'unavailable'
        | 'context-ended'
        | 'capacity'
      readonly observed?: string
      readonly absent?: boolean
    }

/** Durable native trust, separate from package/UI enablement and transport mechanics. */
export class ExtensionConnectorApprovalOwner {
  private approvals: ExtensionConnectorApproval[] = []
  private readonly prepared = new Map<string, PreparedApproval>()
  private readonly decisions = new Set<ApprovalDecision>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure?: string
  private disposed = false
  private readonly sessions = new Map<string, SessionTrust>()
  private readonly inspections = new Set<{ readonly installation: string }>()
  private readonly resolutions = new Set<{ readonly installation: string }>()
  private readonly stopHosts: () => void
  constructor(
    readonly hosts: ConnectorHostCatalog,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable' | 'readConnectorApprovals' | 'saveConnectorApprovals'
    >,
    private readonly revoked: (
      installation: string,
      connector?: string,
      host?: string,
    ) => void,
  ) {
    this.stopHosts = hosts.onHostStateChange(() => {
      for (const session of this.sessions.values())
        if (!session.current()) this.endSession(session.approval)
    })
  }

  async start(): Promise<void> {
    try {
      const value = await this.activations.readConnectorApprovals()
      if (!Array.isArray(value) || value.length > CONNECTOR_LIMITS.approvals)
        throw new Error('Invalid connector approval state')
      const approvals = value.map((entry: unknown): ExtensionConnectorApproval => {
        const object = extensionObject(entry)
        const declaration = validateConnectorDeclarations(
          [object['declaration']],
          () => undefined,
        )[0]!
        return {
          installationId: extensionText(
            object['installationId'],
            'installation identity',
            80,
          ),
          connector: extensionId(object['connector']),
          host: extensionText(object['host'], 'host', 128),
          executable: executablePath(object['executable']),
          canonicalExecutable: executablePath(object['canonicalExecutable']),
          configuration: connectorConfiguration(object['configuration'], declaration),
          declaration,
        }
      })
      if (
        new Set(approvals.map((entry) => key(entry))).size !== approvals.length ||
        approvals.some(
          (entry) =>
            entry.connector !== entry.declaration.id ||
            (entry.declaration.context === 'application' &&
              entry.host !== this.hosts.local.hostId),
        )
      )
        throw new Error('Invalid connector approval identity')
      if (!this.disposed) this.approvals = approvals
    } catch {
      this.failure =
        'Saved native approvals cannot be read safely. Repair extension-state/connectors.json before approving tools; isolated views remain available.'
    }
  }

  async prepare(
    selection: ExtensionConnectorSelection,
    current: () => void,
    prior?: { readonly approval: ExtensionConnectorApproval | undefined },
    trustUpdates = false,
  ): Promise<{
    token: string
    approval: ExtensionConnectorApproval
    trustUpdates: boolean
    preservesBaseline: boolean
  }> {
    if (typeof trustUpdates !== 'boolean')
      throw new Error('Choose session update trust explicitly')
    this.prune()
    const expected = prior ?? {
      approval: this.approvals.find((entry) => key(entry) === key(selection)),
    }
    const assertCurrent = (): void => {
      current()
      if (
        this.approvals.find((entry) => key(entry) === key(selection)) !==
        expected.approval
      )
        throw new Error(
          'Saved connector access changed; connect again to review its replacement',
        )
    }
    if (this.decisions.size >= 4)
      throw new Error('Too many pending native approval decisions')
    const decision: ApprovalDecision = {
      installationId: selection.installationId,
      connector: selection.connector,
      host: selection.host,
      controller: new AbortController(),
    }
    this.decisions.add(decision)
    let retained = false
    try {
      await this.assertWritable()
      decision.controller.signal.throwIfAborted()
      assertCurrent()
      const activation = this.activations.active.get(selection.installationId)
      const declaration = activation?.revision.manifest.connectors?.find(
        (entry) => entry.id === selection.connector,
      )
      if (!activation || !declaration)
        throw new Error('Enable the declared extension before configuring its connector')
      if (!this.hosts.listHosts().some((entry) => entry.hostId === selection.host))
        throw new Error('Select a configured host')
      if (
        declaration.context === 'application' &&
        selection.host !== this.hosts.local.hostId
      )
        throw new Error('Application connectors run on the local host')
      const executable = executablePath(selection.executable)
      const configuration = connectorConfiguration(selection.configuration, declaration)
      const host = await this.hosts.materializeHost(selection.host)
      await host.connect()
      const hostCurrent = this.hostLifetime(host)
      if (trustUpdates && host.hostId !== this.hosts.local.hostId && !host.streamLocal)
        throw new Error('This host has no current connection lifetime')
      const canonicalExecutable = await canonicalExecutablePath(host, executable)
      if (!hostCurrent()) throw new Error('Native setup host changed')
      await this.assertWritable()
      decision.controller.signal.throwIfAborted()
      if (this.activations.active.get(selection.installationId) !== activation)
        throw new Error('Extension activation changed during native setup')
      const approval: ExtensionConnectorApproval = {
        installationId: activation.installationId,
        connector: declaration.id,
        host: host.hostId,
        executable,
        canonicalExecutable,
        configuration,
        declaration,
      }
      assertCurrent()
      const token = randomUUID()
      this.prepared.set(token, {
        approval,
        activation,
        trustUpdates,
        hostCurrent,
        expires: Date.now() + 60_000,
        current,
        decision,
        prior: expected,
      })
      retained = true
      return {
        token,
        approval,
        trustUpdates,
        preservesBaseline:
          trustUpdates &&
          !!expected.approval &&
          sameLauncherBinding(expected.approval, approval),
      }
    } finally {
      if (!retained) this.decisions.delete(decision)
    }
  }

  /** Exact saved binding, including an obsolete declaration; never a grant of access. */
  capturePrior(
    selection: Pick<ExtensionConnectorSelection, 'installationId' | 'connector' | 'host'>,
  ) {
    return { approval: this.approvals.find((entry) => key(entry) === key(selection)) }
  }

  /** Retain only the checked host lifetime, not this decision's approval authority. */
  preparedHostCurrent(token: string): () => boolean {
    const prepared = this.prepared.get(token)
    if (!prepared) throw new Error('Inspect native access again before reviewing setup')
    return prepared.hostCurrent
  }

  /** Project the whole store using the same replacements and byte accounting as a save. */
  project(approvals: readonly ExtensionConnectorApproval[]): {
    records: number
    bytes: number
  } {
    if (this.disposed || this.failure)
      throw new Error(this.failure ?? 'Native approvals ended')
    if (new Set(approvals.map(key)).size !== approvals.length)
      throw new Error('Duplicate native setup binding')
    const next = approvals.reduce(
      (state, approval) => replaceApproval(state, approval),
      this.approvals,
    )
    return approvalCapacity(next)
  }

  approve(token: string): Promise<void> {
    return this.serialize(async () => {
      this.prune()
      const prepared = this.prepared.get(token)
      if (!prepared) throw new Error('Inspect native access again before approving')
      try {
        await this.assertWritable()
        const { approval, activation } = prepared
        const host = this.hosts.hostById(approval.host)
        if (
          !host ||
          host.connectionState !== 'connected' ||
          (await canonicalExecutablePath(host, approval.executable)) !==
            approval.canonicalExecutable
        )
          throw new Error('Executable target changed; inspect it again')
        await this.assertWritable()
        const current = () => {
          prepared.decision.controller.signal.throwIfAborted()
          prepared.current()
          if (
            this.disposed ||
            !prepared.hostCurrent() ||
            this.activations.active.get(activation.installationId) !== activation
          )
            throw new Error('Native approval context ended')
        }
        current()
        if (
          this.approvals.find((entry) => key(entry) === key(approval)) !==
          prepared.prior.approval
        )
          throw new Error(
            'Saved connector access changed; connect again to review its replacement',
          )
        const prior = prepared.prior.approval
        if (prepared.trustUpdates && prior && sameLauncherBinding(prior, approval)) {
          this.dropSession(prior)
          this.revoked(prior.installationId, prior.connector, prior.host)
          this.trustSession(prior, prepared.hostCurrent)
          return
        }
        const next = replaceApproval(this.approvals, approval)
        approvalCapacity(next)
        this.dropSession(approval)
        this.revoked(approval.installationId, approval.connector, approval.host)
        this.approvals = this.approvals.filter((entry) => key(entry) !== key(approval))
        await this.activations.saveConnectorApprovals(next, current)
        current()
        // Apply only this decision's delta; other synchronous revocations win over a saved snapshot.
        this.approvals = [
          ...this.approvals.filter((entry) => key(entry) !== key(approval)),
          approval,
        ]
        if (prepared.trustUpdates) this.trustSession(approval, prepared.hostCurrent)
      } finally {
        this.prepared.delete(token)
        this.decisions.delete(prepared.decision)
      }
    })
  }

  revoke(installation: string, connector?: string, host?: string): Promise<void> {
    this.clearSessions(installation, connector, host)
    this.revoked(installation, connector, host)
    this.discardPrepared(installation, connector, host)
    this.approvals = this.approvals.filter(
      (entry) =>
        entry.installationId !== installation ||
        (!!connector && entry.connector !== connector) ||
        (!!host && entry.host !== host),
    )
    if (this.failure) return Promise.resolve()
    return this.serialize(async () => {
      await this.assertWritable()
      const next = this.approvals.filter(
        (entry) =>
          entry.installationId !== installation ||
          (!!connector && entry.connector !== connector) ||
          (!!host && entry.host !== host),
      )
      this.approvals = next
      await this.activations.saveConnectorApprovals(next, () => {
        if (this.disposed) throw new Error('Native approvals ended')
      })
    })
  }

  preparedSignal(token: string): AbortSignal {
    const prepared = this.prepared.get(token)
    if (!prepared) throw new Error('Native approval decision ended')
    return prepared.decision.controller.signal
  }

  cancelPrepared(token: string): void {
    const prepared = this.prepared.get(token)
    if (!prepared) return
    prepared.decision.controller.abort()
    this.prepared.delete(token)
    this.decisions.delete(prepared.decision)
  }

  discardPrepared(installation: string, connector?: string, host?: string): void {
    for (const decision of this.decisions)
      if (
        decision.installationId === installation &&
        (!connector || decision.connector === connector) &&
        (!host || decision.host === host)
      )
        decision.controller.abort()
    for (const [token, entry] of this.prepared)
      if (
        entry.approval.installationId === installation &&
        (!connector || entry.approval.connector === connector) &&
        (!host || entry.approval.host === host)
      ) {
        this.prepared.delete(token)
        this.decisions.delete(entry.decision)
      }
  }

  forget(installation: string): readonly ExtensionConnectorApproval[] | undefined {
    this.clearSessions(installation)
    this.revoked(installation)
    this.discardPrepared(installation)
    if (this.failure) return undefined
    this.approvals = this.approvals.filter(
      (entry) => entry.installationId !== installation,
    )
    return [...this.approvals]
  }

  get(
    activation: ExtensionActivation,
    connector: string,
    host: string,
  ): ExtensionConnectorApproval | undefined {
    if (
      this.disposed ||
      this.failure ||
      this.activations.active.get(activation.installationId) !== activation
    )
      return undefined
    const declaration = activation.revision.manifest.connectors?.find(
      (entry) => entry.id === connector,
    )
    return this.approvals.find(
      (entry) =>
        entry.installationId === activation.installationId &&
        entry.connector === connector &&
        entry.host === host &&
        JSON.stringify(entry.declaration) === JSON.stringify(declaration),
    )
  }
  current(
    activation: ExtensionActivation,
    approval: ExtensionConnectorApproval,
  ): boolean {
    return (
      this.get(activation, approval.connector, approval.host) === approval &&
      this.hosts.hostById(approval.host)?.connectionState === 'connected'
    )
  }
  /** Resolve only through an already connected host; the returned target is immutable. */
  resolve(
    activation: ExtensionActivation,
    approval: ExtensionConnectorApproval,
  ): Promise<ConnectorExecutableResolution> {
    return this.resolveExecutable(activation, approval, this.resolutions)
  }
  private async resolveExecutable(
    activation: ExtensionActivation,
    approval: ExtensionConnectorApproval,
    pending: Set<{ readonly installation: string }>,
  ): Promise<ConnectorExecutableResolution> {
    const host = this.hosts.hostById(approval.host)
    if (!host || host.connectionState !== 'connected') return { reason: 'disconnected' }
    const hostCurrent = this.hostLifetime(host)
    const session = this.session(approval)
    const current = (): boolean =>
      this.current(activation, approval) &&
      hostCurrent() &&
      this.session(approval) === session
    if (!current()) return { reason: 'context-ended' }
    if (
      pending.size >= CONNECTOR_LIMITS.concurrent ||
      [...pending].filter((entry) => entry.installation === approval.installationId)
        .length >= CONNECTOR_LIMITS.perExtension
    )
      return { reason: 'capacity' }
    const inspection = { installation: approval.installationId }
    pending.add(inspection)
    try {
      const executable = await canonicalExecutablePath(host, approval.executable)
      if (!current()) return { reason: 'context-ended' }
      if (!session && executable !== approval.canonicalExecutable)
        return { reason: 'executable-changed', observed: executable }
      return { executable, current }
    } catch (reason) {
      return current()
        ? { reason: 'unavailable', absent: absentExecutableMetadata(reason) }
        : { reason: 'context-ended' }
    } finally {
      pending.delete(inspection)
    }
  }

  async inspectStatus(
    activation: ExtensionActivation,
    workspaceHost?: string,
  ): Promise<readonly ExtensionConnectorStatus[]> {
    const entries = this.status(activation, workspaceHost).map((entry) => ({
      entry,
      approval: entry.host && this.get(activation, entry.connector, entry.host),
    }))
    const statuses: (() => ExtensionConnectorStatus)[] = []
    for (const { entry, approval } of entries) {
      const publish = approval ? await this.inspect(activation, approval) : undefined
      statuses.push(() => ({ ...entry, ...publish?.() }))
    }
    // Revalidate every captured row after the final metadata await in the batch.
    return statuses.map((publish) => publish())
  }

  async inspectSettings(
    activation: ExtensionActivation,
    connector: string,
    host: string,
  ) {
    const approval = this.get(activation, connector, host)
    const publish = approval ? await this.inspect(activation, approval) : undefined
    const snapshot = this.settings(activation)
    return {
      ...snapshot,
      connectors: snapshot.connectors.map((entry) =>
        publish && entry.connector === connector && entry.host === host
          ? { ...entry, ...publish() }
          : entry,
      ),
    }
  }

  private async inspect(
    activation: ExtensionActivation,
    approval: ExtensionConnectorApproval,
  ) {
    const session = this.session(approval)
    const host = this.hosts.hostById(approval.host)
    const hostCurrent =
      host?.connectionState === 'connected' ? this.hostLifetime(host) : () => true
    const current = (): boolean =>
      this.get(activation, approval.connector, approval.host) === approval &&
      this.session(approval) === session &&
      hostCurrent()
    const result = await this.resolveExecutable(activation, approval, this.inspections)
    const reason =
      'reason' in result
        ? result.reason === 'context-ended' || result.reason === 'capacity'
          ? 'unavailable'
          : result.reason
        : undefined
    const observed =
      'executable' in result
        ? { availability: 'supported' as const, currentExecutable: result.executable }
        : {
            availability:
              reason === 'disconnected'
                ? ('disconnected' as const)
                : ('unavailable' as const),
            reason,
            ...(result.observed ? { currentExecutable: result.observed } : {}),
            explanation:
              reason === 'executable-changed'
                ? 'Program target changed. Review its update in Settings → Extensions.'
                : reason === 'disconnected'
                  ? 'Host disconnected'
                  : 'Program metadata is unavailable',
          }
    return () =>
      current()
        ? observed
        : {
            availability: 'unavailable' as const,
            reason: 'unavailable' as const,
            explanation: 'Program access changed; check again',
          }
  }

  /** Reload preserves only the exact unchanged declaration; all old work is still revoked. */
  activationEnded(
    installation: string,
    reloading?: readonly ExtensionConnectorDeclaration[],
  ): void {
    this.discardPrepared(installation)
    for (const session of this.sessions.values())
      if (
        session.approval.installationId === installation &&
        !reloading?.some(
          (entry) =>
            JSON.stringify(entry) === JSON.stringify(session.approval.declaration),
        )
      )
        this.endSession(session.approval)
  }

  endSession(
    selection: Pick<ExtensionConnectorSelection, 'installationId' | 'connector' | 'host'>,
  ): void {
    this.discardPrepared(selection.installationId, selection.connector, selection.host)
    this.dropSession(selection)
  }
  private dropSession(
    selection: Pick<ExtensionConnectorSelection, 'installationId' | 'connector' | 'host'>,
  ): void {
    const session = this.sessions.get(key(selection))
    if (!session) return
    this.sessions.delete(key(selection))
    session.stop()
    this.revoked(selection.installationId, selection.connector, selection.host)
  }

  private clearSessions(installation: string, connector?: string, host?: string): void {
    for (const session of this.sessions.values())
      if (
        session.approval.installationId === installation &&
        (!connector || session.approval.connector === connector) &&
        (!host || session.approval.host === host)
      )
        this.endSession(session.approval)
  }
  private session(approval: ExtensionConnectorApproval): SessionTrust | undefined {
    const session = this.sessions.get(key(approval))
    if (session && (session.approval !== approval || !session.current())) {
      this.endSession(approval)
      return undefined
    }
    return session
  }
  private trustSession(
    approval: ExtensionConnectorApproval,
    current: () => boolean,
  ): void {
    const signal = this.hosts.hostById(approval.host)?.streamLocal?.signal
    const abort = (): void => this.endSession(approval)
    const session = {
      approval,
      current,
      stop: () => signal?.removeEventListener('abort', abort),
    }
    if (!current()) throw new Error('Session connection ended')
    this.sessions.set(key(approval), session)
    signal?.addEventListener('abort', abort, { once: true })
  }
  private hostLifetime(host: ConnectorHostPort): () => boolean {
    const binding = host.streamLocal
    return () => {
      try {
        binding?.assertCurrent()
        return (
          !this.disposed &&
          this.hosts.hostById(host.hostId) === host &&
          host.connectionState === 'connected' &&
          (!binding || !binding.signal.aborted)
        )
      } catch {
        return false
      }
    }
  }

  status(
    activation: ExtensionActivation,
    workspaceHost?: string,
  ): readonly ExtensionConnectorStatus[] {
    return (activation.revision.manifest.connectors ?? []).map((declaration) => {
      const host =
        declaration.context === 'application' ? this.hosts.local.hostId : workspaceHost
      const approval = host ? this.get(activation, declaration.id, host) : undefined
      return {
        connector: declaration.id,
        ...this.availability(approval),
        ...(host ? { host } : {}),
        ...(approval
          ? { executable: approval.canonicalExecutable }
          : {
              reason:
                host &&
                !this.disposed &&
                !this.failure &&
                this.activations.active.get(activation.installationId) === activation
                  ? ('unapproved' as const)
                  : ('unavailable' as const),
              explanation:
                this.failure ??
                (host
                  ? `Approve this installed tool for ${host} in Settings → Extensions`
                  : 'Select an admitted workspace to check this project connector'),
            }),
      }
    })
  }
  settings(activation: ExtensionActivation): {
    readonly connectors: readonly ExtensionConnectorSetting[]
    readonly explanation?: string
  } {
    return {
      ...(this.failure ? { explanation: this.failure } : {}),
      connectors: this.approvals
        .filter((entry) => entry.installationId === activation.installationId)
        .map((entry) => ({
          connector: entry.connector,
          host: entry.host,
          executable: entry.canonicalExecutable,
          selectedExecutable: entry.executable,
          configuration: entry.configuration,
          trustUpdates: !!this.session(entry),
          ...this.availability(this.get(activation, entry.connector, entry.host)),
        })),
    }
  }
  private availability(
    approval: ExtensionConnectorApproval | undefined,
  ): Pick<ExtensionConnectorStatus, 'availability'> {
    return {
      availability: !approval
        ? 'unavailable'
        : this.hosts.hostById(approval.host)?.connectionState === 'connected'
          ? 'supported'
          : 'disconnected',
    }
  }
  dispose(): void {
    this.disposed = true
    this.stopHosts()
    for (const session of this.sessions.values()) this.endSession(session.approval)
    for (const decision of this.decisions) decision.controller.abort()
    this.prepared.clear()
    this.approvals = []
  }
  private async assertWritable(): Promise<void> {
    if (this.disposed || this.failure)
      throw new Error(this.failure ?? 'Native approvals ended')
    await this.activations.assertWritable()
  }
  private prune(): void {
    for (const [id, entry] of this.prepared)
      if (entry.expires <= Date.now()) {
        entry.decision.controller.abort()
        this.decisions.delete(entry.decision)
        this.prepared.delete(id)
      }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation)
    this.pending = task.catch(() => undefined)
    return task
  }
}
export function executablePath(value: unknown): string {
  const path = extensionText(value, 'absolute executable path', 4096)
  if (!path.startsWith('/') || path.includes('\0'))
    throw new Error('Select an absolute installed executable path')
  return path
}
export async function canonicalExecutablePath(
  host: Pick<ProjectHost, 'hostId' | 'realpath' | 'stat'>,
  selected: string,
): Promise<string> {
  const canonical = await host.realpath(hostPath(host.hostId, selected))
  const stat = await host.stat(canonical)
  if (
    canonical.hostId !== host.hostId ||
    stat.type !== 'file' ||
    (stat.mode & 0o111) === 0
  )
    throw Object.assign(new Error('Select an executable file on this host'), {
      code: 'NOT_EXECUTABLE',
    })
  return executablePath(canonical.path)
}
function key(
  approval: Pick<ExtensionConnectorSelection, 'installationId' | 'connector' | 'host'>,
): string {
  return JSON.stringify([approval.installationId, approval.connector, approval.host])
}

function replaceApproval(
  state: readonly ExtensionConnectorApproval[],
  approval: ExtensionConnectorApproval,
): ExtensionConnectorApproval[] {
  return [...state.filter((entry) => key(entry) !== key(approval)), approval]
}
function approvalCapacity(state: readonly ExtensionConnectorApproval[]): {
  records: number
  bytes: number
} {
  const bytes = Buffer.byteLength(JSON.stringify(state))
  if (state.length > CONNECTOR_LIMITS.approvals || bytes > CONNECTOR_LIMITS.stateBytes)
    throw new Error(
      'Connector approval state exceeds its bound; revoke unused host bindings first',
    )
  return { records: state.length, bytes }
}

function sameLauncherBinding(
  a: ExtensionConnectorApproval,
  b: ExtensionConnectorApproval,
): boolean {
  return (
    a.installationId === b.installationId &&
    a.connector === b.connector &&
    a.host === b.host &&
    a.executable === b.executable &&
    JSON.stringify(a.declaration) === JSON.stringify(b.declaration) &&
    JSON.stringify(a.configuration) === JSON.stringify(b.configuration)
  )
}

/** Only specific absence is known; unreadable or unresolved metadata remains incomplete. */
export function absentExecutableMetadata(reason: unknown): boolean {
  return (
    !!reason &&
    typeof reason === 'object' &&
    'code' in reason &&
    ['ENOENT', 'ENOTDIR', 'NOT_EXECUTABLE'].includes(String(reason.code))
  )
}
