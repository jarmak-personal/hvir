import {
  DELIVERY_LIMITS,
  type DeliveryTreeEntry,
  type ExtensionDeliveryRecord,
  type DeliveryRecoveryEntry,
} from '../../shared/extensions/managed-delivery'
import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import { readSourcePath } from './source-approval'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import { deliveryFingerprint, compareDeliveryPaths } from './delivery-tree'

export interface DeliveryOperation {
  readonly id: string
  readonly installation: string
  readonly caller: string
  readonly workspace: string
  readonly root: HostPath
  readonly target: HostPath
  readonly stage: HostPath
  readonly preserve: HostPath
  readonly sourceVersion: string
  readonly parents: { readonly path: HostPath; identity?: string }[]
  readonly kind: 'add' | 'update' | 'remove'
  readonly created: number
  readonly payload: readonly DeliveryTreeEntry[]
  readonly previous?: ExtensionDeliveryRecord
  readonly previousTree?: readonly DeliveryTreeEntry[]
  phase:
    | 'intent'
    | 'staged'
    | 'displacing'
    | 'displaced'
    | 'publishing'
    | 'completed'
    | 'conflicted'
  stageIdentity?: string
  preserveIdentity?: string
}
export interface DeliveryJournal {
  records: { record: ExtensionDeliveryRecord; tree: readonly DeliveryTreeEntry[] }[]
  operations: DeliveryOperation[]
}
export function deliveryRecoveryEntry(entry: DeliveryOperation): DeliveryRecoveryEntry {
  return {
    id: entry.id,
    workspace: entry.workspace,
    root: entry.root,
    installation: entry.installation,
    phase: entry.phase,
    sourceVersion: entry.sourceVersion,
    ...(entry.previous ? { previousOperation: entry.previous.operation } : {}),
    target: entry.target,
    staging: entry.stage,
    preserved: entry.preserve,
    outcome:
      entry.phase === 'completed'
        ? 'completed-with-retained-objects'
        : entry.phase === 'conflicted'
          ? 'conflicted-with-retained-objects'
          : 'completion-unproven',
  }
}
export function deliveryRecordFor(operation: DeliveryOperation): ExtensionDeliveryRecord {
  return {
    id: operation.previous?.id ?? operation.id,
    operation: operation.id,
    installation: operation.installation,
    workspace: operation.workspace,
    root: operation.root,
    target: operation.target,
    sourceVersion: operation.sourceVersion,
    identity: operation.stageIdentity!,
    fingerprint: deliveryFingerprint(operation.payload),
    files: operation.payload.filter((entry) => entry.type === 'file').length,
    bytes: operation.payload.reduce((n, entry) => n + entry.size, 0),
  }
}
/** Only possibly retained stage/preservation bytes consume the retention budget. */
export function retainedDeliveryBytes(operation: DeliveryOperation): number {
  const entries =
    operation.phase === 'completed'
      ? (operation.previousTree ?? [])
      : [...operation.payload, ...(operation.previousTree ?? [])]
  return entries.reduce((total, entry) => total + entry.size, 0)
}
export function proveDeliveryJournalCapacity(
  state: DeliveryJournal,
  operation: DeliveryOperation,
): void {
  const operations = [
    ...state.operations.filter((entry) => entry.id !== operation.id),
    operation,
  ].map((entry) => ({
    ...entry,
    stageIdentity: 'x'.repeat(256),
    preserveIdentity: 'x'.repeat(256),
    parents: entry.parents.map((parent) => ({ ...parent, identity: 'x'.repeat(256) })),
  }))
  const records = [
    ...state.records,
    ...operations
      .filter(
        (entry) =>
          entry.kind !== 'remove' && !['completed', 'conflicted'].includes(entry.phase),
      )
      .map((entry) => ({ record: deliveryRecordFor(entry), tree: entry.payload })),
  ]
  if (
    state.records.length +
      operations.filter(
        (entry) =>
          entry.kind === 'add' && !['completed', 'conflicted'].includes(entry.phase),
      ).length >
    DELIVERY_LIMITS.records
  )
    throw new Error('Delivery record capacity is full')
  if (
    Buffer.byteLength(JSON.stringify({ records, operations })) >
    DELIVERY_LIMITS.stateBytes
  )
    throw new Error('Delivery journal byte capacity is full')
}
export function completedDeliveryJournal(
  state: DeliveryJournal,
  operation: DeliveryOperation,
  installationExists: boolean,
): DeliveryJournal {
  const next = resolvedDeliveryJournal(state, operation, true)
  if (operation.kind !== 'remove' && installationExists)
    next.records.push({ record: deliveryRecordFor(operation), tree: operation.payload })
  if (operation.previous)
    next.operations.push(structuredClone({ ...operation, phase: 'completed' as const }))
  return next
}
/** Keep-files drops only this operation's authority; cleanup retains current authority. */
export function resolvedDeliveryJournal(
  state: DeliveryJournal,
  operation: DeliveryOperation,
  forgetAuthority: boolean,
): DeliveryJournal {
  return {
    records: forgetAuthority
      ? state.records.filter(
          (entry) =>
            entry.record.installation !== operation.installation ||
            (entry.record.operation !== operation.id &&
              !(
                operation.phase !== 'completed' &&
                operation.previous &&
                entry.record.id === operation.previous.id &&
                entry.record.operation === operation.previous.operation
              )),
        )
      : [...state.records],
    operations: state.operations.filter((entry) => entry.id !== operation.id),
  }
}
export function readDeliveryEntries(value: unknown): DeliveryTreeEntry[] {
  if (!Array.isArray(value) || value.length > DELIVERY_LIMITS.files)
    throw new Error('Invalid delivery manifest')
  const result = value
    .map((value: unknown): DeliveryTreeEntry => {
      const item = extensionObject(value),
        path =
          item['path'] === ''
            ? ''
            : extensionText(item['path'], 'delivery relative path', 4096)
      if (
        (path &&
          path
            .split('/')
            .some(
              (name) => !name || name === '.' || name === '..' || name.includes('\\'),
            )) ||
        path.startsWith('/') ||
        path.split('/').length > DELIVERY_LIMITS.depth + 1
      )
        throw new Error('Invalid delivery manifest path')
      if (
        !['file', 'dir'].includes(item['type'] as string) ||
        !Number.isSafeInteger(item['mode']) ||
        (item['mode'] as number) < 0 ||
        (item['mode'] as number) > 0o777 ||
        !Number.isSafeInteger(item['size']) ||
        (item['size'] as number) < 0 ||
        (item['size'] as number) > DELIVERY_LIMITS.fileBytes
      )
        throw new Error('Invalid delivery manifest metadata')
      const type = item['type'] as 'file' | 'dir'
      if (type === 'file' && !/^[a-f0-9]{64}$/u.test(item['sha256'] as string))
        throw new Error('Invalid delivery file fingerprint')
      if (type === 'dir' && item['size'] !== 0)
        throw new Error('Invalid delivery directory metadata')
      return {
        path,
        type,
        mode: item['mode'] as number,
        size: item['size'] as number,
        ...(type === 'file' ? { sha256: item['sha256'] as string } : {}),
      }
    })
    .sort((a, b) => compareDeliveryPaths(a.path, b.path))
  if (
    new Set(result.map((entry) => entry.path)).size !== result.length ||
    result.reduce((total, entry) => total + entry.size, 0) >
      DELIVERY_LIMITS.payloadBytes ||
    (result.length && !result.some((entry) => entry.path === '' && entry.type === 'dir'))
  )
    throw new Error('Invalid complete delivery manifest')
  const directories = new Set(
    result.filter((entry) => entry.type === 'dir').map((entry) => entry.path),
  )
  if (
    result.some(
      (entry) =>
        entry.path &&
        !directories.has(
          entry.path.includes('/')
            ? entry.path.slice(0, entry.path.lastIndexOf('/'))
            : '',
        ),
    )
  )
    throw new Error('Delivery manifest parent is missing')
  return result
}
function record(
  value: unknown,
  tree: readonly DeliveryTreeEntry[],
): ExtensionDeliveryRecord {
  const item = extensionObject(value)
  const root = readSourcePath(item['root']),
    target = readSourcePath(item['target'])
  if (
    root.hostId !== target.hostId ||
    hostPathEquals(root, target) ||
    !containsHostPath(root, target)
  )
    throw new Error('Invalid delivery target authority')
  const result: ExtensionDeliveryRecord = {
    id: extensionText(item['id'], 'delivery id', 80),
    operation: extensionText(item['operation'], 'operation id', 80),
    installation: extensionText(item['installation'], 'installation id', 80),
    workspace: extensionText(item['workspace'], 'workspace', 256),
    root,
    target,
    sourceVersion: extensionText(item['sourceVersion'], 'source version', 256),
    identity: extensionText(item['identity'], 'object identity', 256),
    fingerprint: extensionText(item['fingerprint'], 'fingerprint', 64),
    files: tree.filter((entry) => entry.type === 'file').length,
    bytes: tree.reduce((total, entry) => total + entry.size, 0),
  }
  if (result.fingerprint !== deliveryFingerprint(tree))
    throw new Error('Invalid persisted delivery fingerprint')
  return result
}
export function readDeliveryJournal(value: unknown): DeliveryJournal {
  const input = extensionObject(value)
  if (
    !Array.isArray(input['records']) ||
    input['records'].length > DELIVERY_LIMITS.records ||
    !Array.isArray(input['operations']) ||
    input['operations'].length > DELIVERY_LIMITS.operations
  )
    throw new Error('Invalid delivery journal capacity')
  const records = input['records'].map((value: unknown) => {
    const item = extensionObject(value),
      tree = readDeliveryEntries(item['tree'])
    return { record: record(item['record'], tree), tree }
  })
  const operations = input['operations'].map((value: unknown): DeliveryOperation => {
    const item = extensionObject(value),
      root = readSourcePath(item['root'])
    const id = extensionText(item['id'], 'operation id', 80)
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
      throw new Error('Invalid operation identity')
    const paths = ['target', 'stage', 'preserve'].map((key) => readSourcePath(item[key]))
    if (
      paths.some(
        (path) =>
          path.hostId !== root.hostId ||
          hostPathEquals(root, path) ||
          !containsHostPath(root, path),
      ) ||
      new Set(paths.map((path) => path.path)).size !== paths.length
    )
      throw new Error('Invalid delivery operation paths')
    if (
      !hostPathEquals(
        paths[1]!,
        joinHostPath(root, '.hvir-delivery-retained', `${id}-stage`),
      ) ||
      !hostPathEquals(
        paths[2]!,
        joinHostPath(root, '.hvir-delivery-retained', `${id}-preserved`),
      )
    )
      throw new Error('Invalid exact operation custody paths')
    if (
      !['add', 'update', 'remove'].includes(item['kind'] as string) ||
      ![
        'intent',
        'staged',
        'displacing',
        'displaced',
        'publishing',
        'completed',
        'conflicted',
      ].includes(item['phase'] as string) ||
      !Number.isSafeInteger(item['created']) ||
      (item['created'] as number) < 0
    )
      throw new Error('Invalid delivery operation state')
    if (!Array.isArray(item['parents']) || item['parents'].length > DELIVERY_LIMITS.depth)
      throw new Error('Invalid delivery parent effects')
    const parents = item['parents'].map((value: unknown) => {
      const parent = extensionObject(value),
        path = readSourcePath(parent['path'])
      if (
        path.hostId !== root.hostId ||
        hostPathEquals(root, path) ||
        !containsHostPath(root, path) ||
        !paths[0]!.path.startsWith(`${path.path}/`)
      )
        throw new Error('Invalid supporting delivery parent')
      return {
        path,
        ...(parent['identity'] === undefined
          ? {}
          : { identity: extensionText(parent['identity'], 'parent identity', 256) }),
      }
    })
    const payload = readDeliveryEntries(item['payload']),
      previousTree =
        item['previousTree'] === undefined
          ? undefined
          : readDeliveryEntries(item['previousTree'])
    return {
      id,
      installation: extensionText(item['installation'], 'installation id', 80),
      caller: extensionText(item['caller'], 'caller', 256),
      workspace: extensionText(item['workspace'], 'workspace', 256),
      root,
      target: paths[0]!,
      stage: paths[1]!,
      preserve: paths[2]!,
      kind: item['kind'] as DeliveryOperation['kind'],
      sourceVersion: extensionText(item['sourceVersion'], 'source version', 256),
      created: item['created'] as number,
      payload,
      parents,
      phase: item['phase'] as DeliveryOperation['phase'],
      ...(previousTree
        ? { previousTree, previous: record(item['previous'], previousTree) }
        : {}),
      ...(item['stageIdentity'] === undefined
        ? {}
        : { stageIdentity: extensionText(item['stageIdentity'], 'stage identity', 256) }),
      ...(item['preserveIdentity'] === undefined
        ? {}
        : {
            preserveIdentity: extensionText(
              item['preserveIdentity'],
              'preservation identity',
              256,
            ),
          }),
    }
  })
  if (
    new Set(records.map((entry) => entry.record.id)).size !== records.length ||
    new Set(operations.map((entry) => entry.id)).size !== operations.length
  )
    throw new Error('Duplicated delivery identities')
  return { records, operations }
}
