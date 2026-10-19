import { hostPathEquals, hostPath } from '../../shared/host-path'
import type { ExtensionSetupProposal } from '../../shared/extensions/setup-proposal'
import type { ExtensionSetupRow } from '../../shared/extensions/setup-review'
import type { ExtensionActivationOwner } from './activation'
import type {
  ExtensionConnectorApprovalOwner,
  ConnectorHostCatalog,
} from './connector-approval'
import type { ExtensionSourceApprovalOwner } from './source-approval'
import type { ExtensionContextOwner } from './context-owner'

export interface SetupBinding {
  readonly row: ExtensionSetupRow
  /** Compare prior binding without starting any filesystem work. */
  readonly current: () => void
  /** Fresh metadata for a reused binding, without rewriting its saved approval. */
  readonly recheck: () => Promise<void>
  /** Re-read the existing owner's saved binding after independent writes settle. */
  readonly saved: () => boolean
  readonly apply: (submitted: () => void) => Promise<void>
}
export interface SetupBindingPorts {
  readonly programs: Pick<
    ExtensionConnectorApprovalOwner,
    | 'prepare'
    | 'approve'
    | 'cancelPrepared'
    | 'capturePrior'
    | 'project'
    | 'preparedHostCurrent'
  >
  readonly sources: Pick<
    ExtensionSourceApprovalOwner,
    | 'prepare'
    | 'approve'
    | 'cancelPrepared'
    | 'capturePrior'
    | 'project'
    | 'assertDistinct'
  >
  readonly activations: Pick<
    ExtensionActivationOwner,
    'captureAgentAccess' | 'configureAgentAccess'
  >
  readonly hosts: ConnectorHostCatalog
  readonly contexts: Pick<ExtensionContextOwner, 'workspaces'>
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Captures the existing host object's connection lifetime, never a new generation registry. */
function pinHost(hosts: ConnectorHostCatalog, id: string): () => void {
  const host = hosts.hostById(id),
    lifetime = host?.streamLocal
  if (!host || host.connectionState !== 'connected')
    throw new Error('Setup host is disconnected')
  return () => {
    lifetime?.assertCurrent()
    if (
      hosts.hostById(id) !== host ||
      host.connectionState !== 'connected' ||
      lifetime?.signal.aborted
    )
      throw new Error('Setup host changed; review setup again')
  }
}
function configured(hosts: ConnectorHostCatalog, id: string): void {
  if (!hosts.listHosts().some((entry) => entry.hostId === id))
    throw new Error('Choose an existing configured host in the setup file')
}

export async function prepareSetupProgram(
  ports: SetupBindingPorts,
  installation: string,
  entry: ExtensionSetupProposal['connectors'][number],
  id: string,
  current: () => void,
): Promise<SetupBinding> {
  configured(ports.hosts, entry.executable.hostId)
  const selection = {
    installationId: installation,
    connector: entry.connector,
    host: entry.executable.hostId,
    executable: entry.executable.path,
    configuration: entry.configuration,
  }
  const owner = ports.programs,
    prior = owner.capturePrior(selection)
  const prepared = await owner.prepare(selection, current, prior)
  let hostCurrent: () => boolean
  try {
    current()
    hostCurrent = owner.preparedHostCurrent(prepared.token)
  } finally {
    owner.cancelPrepared(prepared.token)
  }
  const approval = prepared.approval
  const check = () => {
    current()
    if (!hostCurrent()) throw new Error('Setup host changed; review setup again')
    if (owner.capturePrior(selection).approval !== prior.approval)
      throw new Error('Saved program access changed; review setup again')
  }
  check()
  const unchanged = same(prior.approval, approval)
  const prepareReviewed = async () => {
    check()
    const fresh = await owner.prepare(
      selection,
      () => {
        current()
        if (!hostCurrent()) throw new Error('Setup host changed; review setup again')
      },
      prior,
    )
    try {
      check()
      if (!same(fresh.approval, approval))
        throw new Error('Program target changed; review setup again')
      return fresh.token
    } catch (reason) {
      owner.cancelPrepared(fresh.token)
      throw reason
    }
  }
  return {
    row: {
      id,
      title: `Run ${approval.connector}`,
      kind: 'program',
      state: unchanged ? 'unchanged' : 'ready',
      selected: !unchanged,
      location: hostPath(entry.executable.hostId, approval.canonicalExecutable),
      program: approval,
      ...(prior.approval && !unchanged ? { previousPrograms: [prior.approval] } : {}),
    },
    current: check,
    recheck: async () => owner.cancelPrepared(await prepareReviewed()),
    saved: () => same(owner.capturePrior(selection).approval, approval),
    apply: async (submitted) => {
      const token = await prepareReviewed()
      try {
        submitted()
        await owner.approve(token)
      } finally {
        owner.cancelPrepared(token)
      }
    },
  }
}

export async function prepareSetupSource(
  ports: SetupBindingPorts,
  installation: string,
  entry: ExtensionSetupProposal['sources'][number],
  id: string,
  current: () => void,
): Promise<SetupBinding> {
  configured(ports.hosts, entry.location.hostId)
  const workspaces = entry.workspace
    ? ports.contexts
        .workspaces()
        .filter(
          (workspace) => workspace.root && hostPathEquals(workspace.root, entry.location),
        )
    : []
  if (entry.workspace && workspaces.length !== 1)
    throw new Error('Use the exact path of one available registered workspace')
  const workspace = workspaces[0]
  const selection = {
    installationId: installation,
    source: entry.source,
    ...(workspace ? { workspaceId: workspace.id } : { root: entry.location }),
  }
  const hostCurrent = pinHost(ports.hosts, entry.location.hostId)
  const scopeCurrent = () => {
    current()
    hostCurrent()
    if (
      workspace &&
      !ports.contexts
        .workspaces()
        .some(
          (entry) =>
            entry.id === workspace.id &&
            entry.root &&
            hostPathEquals(entry.root, workspace.root!),
        )
    )
      throw new Error('Registered workspace changed; review setup again')
  }
  const owner = ports.sources,
    prior = owner.capturePrior(selection)
  const prepared = await owner.prepare(selection, scopeCurrent, prior)
  try {
    scopeCurrent()
  } finally {
    owner.cancelPrepared(prepared.token)
  }
  const grant = prepared.grant
  const check = () => {
    scopeCurrent()
    const now = owner.capturePrior(selection).grants
    if (
      now.length !== prior.grants.length ||
      now.some((value, index) => value !== prior.grants[index])
    )
      throw new Error('Saved file access changed; review setup again')
  }
  check()
  const unchanged = prior.grants.length === 1 && same(prior.grants[0], grant)
  const prepareReviewed = async () => {
    check()
    const fresh = await owner.prepare(selection, scopeCurrent, prior)
    try {
      check()
      if (!same(fresh.grant, grant))
        throw new Error('File scope changed; review setup again')
      return fresh.token
    } catch (reason) {
      owner.cancelPrepared(fresh.token)
      throw reason
    }
  }
  const verb =
    grant.declaration.mode === 'read-only'
      ? 'Read'
      : grant.declaration.mode === 'delivery-source'
        ? 'Capture exports from'
        : 'Deliver files to'
  return {
    row: {
      id,
      title: `${verb} ${workspace?.name ?? grant.declaration.description}`,
      kind: 'source',
      state: unchanged ? 'unchanged' : 'ready',
      selected: !unchanged,
      location: grant.root,
      source: grant,
      ...(!unchanged && prior.grants.length ? { previousSources: prior.grants } : {}),
    },
    current: check,
    recheck: async () => owner.cancelPrepared(await prepareReviewed()),
    saved: () => owner.capturePrior(selection).grants.some((entry) => same(entry, grant)),
    apply: async (submitted) => {
      const token = await prepareReviewed()
      try {
        submitted()
        await owner.approve(token)
      } finally {
        owner.cancelPrepared(token)
      }
    },
  }
}

export function prepareSetupAgent(
  ports: Pick<SetupBindingPorts, 'activations'>,
  installation: string,
  enabled: boolean,
  current: () => void,
): SetupBinding {
  const owner = ports.activations,
    prior = owner.captureAgentAccess(installation)
  const check = () => {
    current()
    const now = owner.captureAgentAccess(installation)
    if (
      now.activation !== prior.activation ||
      now.enabled !== prior.enabled ||
      now.effective !== prior.effective ||
      now.intent !== prior.intent
    )
      throw new Error('Extension agent setting changed; review setup again')
  }
  const unchanged = prior.enabled === enabled && prior.effective === enabled
  return {
    row: {
      id: 'agent',
      kind: 'agent',
      title: enabled
        ? 'Allow agents to use this extension'
        : 'Turn off agents for this extension',
      state: unchanged ? 'unchanged' : 'ready',
      selected: !unchanged,
      agentAccess: enabled,
    },
    current: check,
    recheck: () => {
      check()
      return Promise.resolve()
    },
    saved: () => {
      const now = owner.captureAgentAccess(installation)
      return now.activation === prior.activation && now.enabled === enabled
    },
    apply: async (submitted) => {
      check()
      submitted()
      await owner.configureAgentAccess(installation, enabled, prior, current)
    },
  }
}
