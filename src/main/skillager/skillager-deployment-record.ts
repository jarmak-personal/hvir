import { createHash } from 'node:crypto'
import { hostPath, type HostPath } from '../../shared/host-path'
import {
  SKILLAGER_AGENTS,
  type SkillagerAgent,
  type SkillagerLibrary,
} from '../../shared/skillager'
import type { SkillagerDestination } from '../../shared/skillager-exposure'
import type {
  ManagedDirectoryReceipt,
  ManagedDirectoryTree,
  ManagedDirectoryLocation,
} from '../project-host/managed-directory'
import {
  parseManagedReceipt,
  parseManagedLocation,
  inspectionLocation,
  relativeEntry,
  validateManagedTree,
} from '../project-host/managed-directory-contract'
import { safeExposureId } from './skillager-exposure-selection'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'

export const SKILLAGER_DEPLOYMENT_RECORD = '.hvir-skillager.json'
export const SKILLAGER_MAX_DEPLOYMENTS = 128
export interface SkillagerDeployment {
  readonly id: string
  readonly library: SkillagerLibrary
  readonly skillId: string
  readonly sourceHash: string
  readonly agent: SkillagerAgent
  readonly destination: SkillagerDestination
  readonly targetEntry: string
  readonly exposureId: string
  readonly payload: ManagedDirectoryTree
}
export interface SkillagerDeploymentIntent {
  readonly id: string
  readonly action: 'add' | 'update' | 'remove'
  readonly state:
    'prepared' | 'staging' | 'staged' | 'submitted' | 'completed' | 'uncertain'
  readonly stageEntry: string
  readonly quarantineEntry: string
  readonly location: ManagedDirectoryLocation
  readonly incoming?: SkillagerDeployment
  /** Removed source identity is observation evidence, never an installed receipt. */
  readonly removedDeployment?: SkillagerDeployment
  readonly candidate?: ManagedDirectoryReceipt
  readonly before?: ManagedDirectoryReceipt
  readonly cleanup?: ManagedDirectoryReceipt
}
export interface SkillagerStoredTarget {
  readonly revision: number
  readonly identity: Pick<
    SkillagerDeployment,
    'agent' | 'destination' | 'targetEntry' | 'exposureId'
  >
  readonly installed?: {
    readonly deployment: SkillagerDeployment
    readonly receipt: ManagedDirectoryReceipt
  }
  readonly intent?: SkillagerDeploymentIntent
}

/** The disclosed record describes delivery. Only the matching local intent grants authority. */
export function deploymentRecordBytes(deployment: SkillagerDeployment): Uint8Array {
  const at = (path: HostPath) => ({ hostId: path.hostId, path: path.path })
  return Buffer.from(
    JSON.stringify({
      schema: 'hvir.skillager-deployment.v1',
      id: deployment.id,
      library: {
        id: deployment.library.id,
        root: at(deployment.library.root),
        skillsRoot: at(deployment.library.skillsRoot),
      },
      skillId: deployment.skillId,
      sourceHash: deployment.sourceHash,
      agent: deployment.agent,
      destination: {
        projectId: deployment.destination.projectId,
        workspaceId: deployment.destination.workspaceId,
        root: at(deployment.destination.root),
      },
      targetEntry: deployment.targetEntry,
      exposureId: deployment.exposureId,
      payload: { files: deploymentFiles(deployment) },
    }) + '\n',
  )
}
function deploymentFiles(deployment: SkillagerDeployment) {
  return [...deployment.payload.files]
    .sort((left, right) =>
      left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0,
    )
    .map(({ entry, mode, size, sha256 }) => ({ entry, mode, size, sha256 }))
}
export function deploymentTree(deployment: SkillagerDeployment): ManagedDirectoryTree {
  const record = deploymentRecordBytes(deployment)
  return {
    files: [
      ...deploymentFiles(deployment),
      {
        entry: SKILLAGER_DEPLOYMENT_RECORD,
        mode: 0o644,
        size: record.byteLength,
        sha256: createHash('sha256').update(record).digest('hex'),
      },
    ],
  }
}
export function deploymentKey(identity: SkillagerStoredTarget['identity']): string {
  return JSON.stringify([
    identity.destination.projectId,
    identity.destination.workspaceId,
    identity.destination.root.hostId,
    identity.destination.root.path,
    identity.agent,
    identity.targetEntry,
  ])
}
export function deploymentTargetFingerprint(receipt: ManagedDirectoryReceipt): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
}

/** Closed persisted schema. No remote JSON is parsed into this authority store. */
export function parseDeploymentFile(value: unknown): readonly SkillagerStoredTarget[] {
  const file = record(value)
  if (
    file.version !== 1 ||
    !Array.isArray(file.targets) ||
    file.targets.length > SKILLAGER_MAX_DEPLOYMENTS
  )
    throw Error('Unsupported deployment store')
  const targets = file.targets.map(parseStoredTarget)
  if (
    new Set(targets.map((target) => deploymentKey(target.identity))).size !==
    targets.length
  )
    throw Error('Duplicate deployment target')
  return targets
}
export function parseStoredTarget(value: unknown): SkillagerStoredTarget {
  const row = record(value),
    identity = parseIdentity(row.identity)
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1)
    throw Error('Invalid deployment revision')
  let installed: SkillagerStoredTarget['installed']
  if (row.installed !== undefined) {
    const item = record(row.installed),
      deployment = parseDeployment(item.deployment, identity)
    installed = {
      deployment,
      receipt: parseManagedReceipt(
        item.receipt,
        identity.destination.root,
        identity.targetEntry,
        deploymentTree(deployment),
      ),
    }
  }
  let intent: SkillagerDeploymentIntent | undefined
  if (row.intent !== undefined) {
    const item = record(row.intent)
    const action = text(item.action, 16),
      state = text(item.state, 16)
    if (
      !['add', 'update', 'remove'].includes(action) ||
      !['prepared', 'staging', 'staged', 'submitted', 'completed', 'uncertain'].includes(
        state,
      )
    )
      throw Error('Invalid deployment intent')
    const intentId = uuid(item.id)
    const stageEntry = text(item.stageEntry, 16384),
      quarantineEntry = text(item.quarantineEntry, 16384)
    const parent = identity.targetEntry.split('/').slice(0, -1).join('/')
    if (
      stageEntry !== `${parent}/.hvir-skillager-stage-${intentId}` ||
      quarantineEntry !== `${parent}/.hvir-skillager-removed-${intentId}`
    )
      throw Error('Invalid allocation identity')
    for (const entry of [stageEntry, quarantineEntry])
      if (
        !relativeEntry(entry) ||
        entry === identity.targetEntry ||
        entry.split('/').slice(0, -1).join('/') !==
          identity.targetEntry.split('/').slice(0, -1).join('/')
      )
        throw Error('Invalid staging identity')
    const incoming =
      item.incoming === undefined ? undefined : parseDeployment(item.incoming, identity)
    if ((action !== 'remove') !== Boolean(incoming))
      throw Error('Missing incoming deployment')
    if (incoming && incoming.id !== intentId) throw Error('Mismatched delivery identity')
    const location = parseManagedLocation(
      item.location,
      identity.destination.root,
      identity.targetEntry,
    )
    const candidate =
      item.candidate === undefined
        ? undefined
        : parseManagedReceipt(
            item.candidate,
            identity.destination.root,
            stageEntry,
            deploymentTree(incoming!),
          )
    const before =
      item.before === undefined
        ? undefined
        : parseManagedReceipt(
            item.before,
            identity.destination.root,
            identity.targetEntry,
            record(item.before).tree as ManagedDirectoryTree,
          )
    if (before) validateManagedTree(before.tree)
    if (action !== 'add' && !before) throw Error('Missing prior target authority')
    const removedDeployment =
      item.removedDeployment === undefined
        ? undefined
        : parseDeployment(item.removedDeployment, identity)
    if (
      action === 'remove'
        ? !removedDeployment ||
          JSON.stringify(deploymentTree(removedDeployment)) !==
            JSON.stringify(before?.tree)
        : removedDeployment
    )
      throw Error('Invalid removed deployment evidence')
    const cleanup =
      item.cleanup === undefined
        ? undefined
        : parseManagedReceipt(
            item.cleanup,
            identity.destination.root,
            text(record(item.cleanup).entry, 16384),
            record(item.cleanup).tree as ManagedDirectoryTree,
          )
    if (cleanup) {
      validateManagedTree(cleanup.tree)
      if (cleanup.entry !== stageEntry && cleanup.entry !== quarantineEntry)
        throw Error('Invalid cleanup identity')
    }
    intent = {
      id: intentId,
      action: action as SkillagerDeploymentIntent['action'],
      state: state as SkillagerDeploymentIntent['state'],
      stageEntry,
      quarantineEntry,
      location,
      incoming,
      removedDeployment,
      candidate,
      before,
      cleanup,
    }
    if (
      action !== 'remove' &&
      ['staged', 'submitted', 'completed'].includes(state) &&
      !candidate
    )
      throw Error('Missing staged receipt')
    if (
      candidate &&
      JSON.stringify(inspectionLocation({ status: 'exact', receipt: candidate })) !==
        JSON.stringify(location)
    )
      throw Error('Unbound staged location')
    if (
      state !== 'completed' &&
      action !== 'add' &&
      (!installed || JSON.stringify(before) !== JSON.stringify(installed.receipt))
    )
      throw Error('Unbound prior deployment')
    if (state !== 'completed' && action === 'add' && (installed || before))
      throw Error('Add has prior deployment authority')
  }
  if (!installed && !intent) throw Error('Empty target record')
  return { revision: Number(row.revision), identity, installed, intent }
}
function parseDeployment(
  value: unknown,
  identity: SkillagerStoredTarget['identity'],
): SkillagerDeployment {
  const row = record(value),
    selected = parseIdentity(row)
  if (
    deploymentKey(selected) !== deploymentKey(identity) ||
    selected.exposureId !== identity.exposureId
  )
    throw Error('Mismatched deployment destination')
  const lib = record(row.library)
  const library = {
    id: uuid(lib.id),
    root: path(lib.root),
    skillsRoot: path(lib.skillsRoot),
  }
  if (
    library.root.hostId !== 'local' ||
    library.skillsRoot.hostId !== 'local' ||
    library.skillsRoot.path !== library.root.path + '/skills'
  )
    throw Error('Invalid deployment source')
  const skillId = text(row.skillId, 68)
  skillagerLibrarySkillRoot(library, skillId)
  const raw = record(row.payload)
  if (!Array.isArray(raw.files)) throw Error('Missing deployment manifest')
  const payload: ManagedDirectoryTree = {
    files: raw.files.map((value) => {
      const item = record(value)
      if (typeof item.mode !== 'number' || typeof item.size !== 'number')
        throw Error('Invalid file metadata')
      return {
        entry: text(item.entry, 16384),
        mode: Number(item.mode) as 0o644 | 0o755,
        size: Number(item.size),
        sha256: hash(item.sha256),
      }
    }),
  }
  validateManagedTree(payload)
  if (
    payload.files.some(
      (file) =>
        file.entry === SKILLAGER_DEPLOYMENT_RECORD ||
        file.entry === 'skillager.materialized.yaml',
    ) ||
    !payload.files.some((file) => file.entry === 'SKILL.md')
  )
    throw Error('Invalid native payload')
  return {
    id: uuid(row.id),
    library,
    skillId,
    sourceHash: hash(row.sourceHash),
    ...selected,
    payload,
  }
}
function parseIdentity(value: unknown): SkillagerStoredTarget['identity'] {
  const row = record(value),
    destination = record(row.destination)
  const root = path(destination.root),
    agent = text(row.agent, 16)
  const targetEntry = text(row.targetEntry, 16384),
    exposureId = text(row.exposureId, 512)
  if (
    root.hostId === 'local' ||
    !SKILLAGER_AGENTS.some((candidate) => candidate.id === agent) ||
    !relativeEntry(targetEntry) ||
    !safeExposureId(exposureId) ||
    targetEntry.split('/').at(-1) !== exposureId
  )
    throw Error('Invalid remote destination')
  return {
    agent: agent as SkillagerAgent,
    destination: {
      projectId: text(destination.projectId, 512),
      workspaceId: text(destination.workspaceId, 512),
      root,
    },
    targetEntry,
    exposureId,
  }
}
function path(value: unknown): HostPath {
  const row = record(value),
    hostId = text(row.hostId, 256),
    name = text(row.path, 16384)
  const result = hostPath(hostId as HostPath['hostId'], name)
  if (!name.startsWith('/') || result.path !== name) throw Error('Invalid stored path')
  return result
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid record')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    value.includes('\0')
  )
    throw Error('Invalid record text')
  return value
}
function uuid(value: unknown): string {
  const result = text(value, 36)
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result))
    throw Error('Invalid record identity')
  return result
}
function hash(value: unknown): string {
  const result = text(value, 64)
  if (!/^[a-f0-9]{64}$/.test(result)) throw Error('Invalid record fingerprint')
  return result
}
