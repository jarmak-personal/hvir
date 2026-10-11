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
  type ExtensionConnectorSelection,
  type ExtensionConnectorStatus,
} from '../../shared/extensions/connectors'
import type { ProjectHost } from '../project-host/project-host'
import type { ProjectHostOption } from '../../shared'
import type { ExtensionActivationOwner, ExtensionActivation } from './activation'

export type ConnectorHostPort = Pick<
  ProjectHost,
  'hostId' | 'connectionState' | 'realpath' | 'stat' | 'finiteExec' | 'connect'
>

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
  readonly expires: number
  readonly current: () => void
  readonly decision: ApprovalDecision
}
interface ApprovalDecision {
  readonly installationId: string
  readonly connector: string
  readonly controller: AbortController
}

/** Durable native trust, separate from package/UI enablement and transport mechanics. */
export class ExtensionConnectorApprovalOwner {
  private approvals: ExtensionConnectorApproval[] = []
  private readonly prepared = new Map<string, PreparedApproval>()
  private readonly decisions = new Set<ApprovalDecision>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure?: string
  private disposed = false
  constructor(
    readonly hosts: ConnectorHostCatalog,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable' | 'readConnectorApprovals' | 'saveConnectorApprovals'
    >,
    private readonly revoked: (installation: string, connector?: string) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const value = await this.activations.readConnectorApprovals()
      if (!Array.isArray(value) || value.length > 32 * CONNECTOR_LIMITS.declarations)
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
        approvals.some((entry) => entry.connector !== entry.declaration.id)
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
  ): Promise<{ token: string; approval: ExtensionConnectorApproval }> {
    this.prune()
    if (this.decisions.size >= 4)
      throw new Error('Too many pending native approval decisions')
    const decision: ApprovalDecision = {
      installationId: selection.installationId,
      connector: selection.connector,
      controller: new AbortController(),
    }
    this.decisions.add(decision)
    let retained = false
    try {
      await this.assertWritable()
      decision.controller.signal.throwIfAborted()
      current()
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
      const canonicalExecutable = await canonicalExecutablePath(host, executable)
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
      current()
      const token = randomUUID()
      this.prepared.set(token, {
        approval,
        activation,
        expires: Date.now() + 60_000,
        current,
        decision,
      })
      retained = true
      return { token, approval }
    } finally {
      if (!retained) this.decisions.delete(decision)
    }
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
        const current = () => {
          prepared.decision.controller.signal.throwIfAborted()
          prepared.current()
          if (
            this.disposed ||
            this.activations.active.get(activation.installationId) !== activation
          )
            throw new Error('Native approval context ended')
        }
        current()
        this.revoked(approval.installationId, approval.connector)
        this.approvals = this.approvals.filter((entry) => key(entry) !== key(approval))
        const next = [
          ...this.approvals.filter((entry) => key(entry) !== key(approval)),
          approval,
        ]
        await this.activations.saveConnectorApprovals(next, current)
        current()
        // Apply only this decision's delta; other synchronous revocations win over a saved snapshot.
        this.approvals = [
          ...this.approvals.filter((entry) => key(entry) !== key(approval)),
          approval,
        ]
      } finally {
        this.prepared.delete(token)
        this.decisions.delete(prepared.decision)
      }
    })
  }

  revoke(installation: string, connector?: string): Promise<void> {
    this.revoked(installation, connector)
    this.discardPrepared(installation, connector)
    this.approvals = this.approvals.filter(
      (entry) =>
        entry.installationId !== installation ||
        (!!connector && entry.connector !== connector),
    )
    if (this.failure) return Promise.resolve()
    return this.serialize(async () => {
      await this.assertWritable()
      const next = this.approvals.filter(
        (entry) =>
          entry.installationId !== installation ||
          (!!connector && entry.connector !== connector),
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

  discardPrepared(installation: string, connector?: string): void {
    for (const decision of this.decisions)
      if (
        decision.installationId === installation &&
        (!connector || decision.connector === connector)
      )
        decision.controller.abort()
    for (const [token, entry] of this.prepared)
      if (
        entry.approval.installationId === installation &&
        (!connector || entry.approval.connector === connector)
      ) {
        this.prepared.delete(token)
        this.decisions.delete(entry.decision)
      }
  }

  forget(installation: string): readonly ExtensionConnectorApproval[] | undefined {
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
        JSON.stringify(entry.declaration) === JSON.stringify(declaration),
    )
  }
  current(
    activation: ExtensionActivation,
    approval: ExtensionConnectorApproval,
  ): boolean {
    return (
      this.get(activation, approval.connector) === approval &&
      this.hosts.hostById(approval.host)?.connectionState === 'connected'
    )
  }
  status(activation: ExtensionActivation): readonly ExtensionConnectorStatus[] {
    return (activation.revision.manifest.connectors ?? []).map((declaration) => {
      const approval = this.get(activation, declaration.id)
      return {
        connector: declaration.id,
        availability: !approval
          ? 'unavailable'
          : this.hosts.hostById(approval.host)?.connectionState === 'connected'
            ? 'supported'
            : 'disconnected',
        ...(approval
          ? { host: approval.host, executable: approval.canonicalExecutable }
          : {
              explanation:
                this.failure ?? 'Approve this installed tool in Settings → Extensions',
            }),
      }
    })
  }
  dispose(): void {
    this.disposed = true
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
function key(approval: ExtensionConnectorApproval): string {
  return JSON.stringify([approval.installationId, approval.connector])
}
