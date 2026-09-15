import { hostPathEquals, type HostPath } from '../../shared/host-path'
import type {
  ManagedDirectoryReceipt,
  ManagedDirectoryTree,
  ManagedDirectoryLocation,
  ManagedDirectoryInspection,
  ManagedDirectoryFile,
} from './managed-directory'

export function inspectionLocation(
  inspection: Exclude<ManagedDirectoryInspection, { status: 'different' }>,
): ManagedDirectoryLocation {
  if (inspection.status === 'absent') return inspection.location
  const { root, rootDevice, rootInode, ancestors } = inspection.receipt
  return { root, rootDevice, rootInode, ancestors, missingParents: [] }
}

export function parseManagedLocation(
  value: unknown,
  root: HostPath,
  entry: string,
): ManagedDirectoryLocation {
  const row = value as ManagedDirectoryLocation | undefined
  if (
    !row ||
    !row.root ||
    !hostPathEquals(row.root, root) ||
    !identityNumber(row.rootDevice) ||
    !identityNumber(row.rootInode) ||
    !Array.isArray(row.ancestors) ||
    !Array.isArray(row.missingParents)
  )
    throw uncertain()
  const parents = entry
    .split('/')
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join('/'))
  if (
    row.ancestors.length + row.missingParents.length !== parents.length ||
    (row.ancestors as ManagedDirectoryReceipt['ancestors']).some(
      (part, i) =>
        !part ||
        part.entry !== parents[i] ||
        !identityNumber(part.device) ||
        !identityNumber(part.inode),
    ) ||
    row.missingParents.some((part, i) => part !== parents[row.ancestors.length + i])
  )
    throw uncertain()
  return {
    root,
    rootDevice: row.rootDevice,
    rootInode: row.rootInode,
    ancestors: (row.ancestors as ManagedDirectoryReceipt['ancestors']).map(
      ({ entry, device, inode }) => ({
        entry,
        device,
        inode,
      }),
    ),
    missingParents: [...(row.missingParents as readonly string[])],
  }
}

export class ManagedDirectoryError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'refused' | 'uncertain',
    message: string,
  ) {
    super(message)
  }
}

export function validateManagedTree(tree: ManagedDirectoryTree): void {
  if (!Array.isArray(tree.files) || tree.files.length < 1 || tree.files.length > 513)
    throw refused()
  const names = new Set<string>()
  let size = 0
  for (const row of tree.files as readonly ManagedDirectoryFile[]) {
    if (
      !row ||
      !relativeEntry(row.entry) ||
      names.has(row.entry) ||
      ![0o644, 0o755].includes(row.mode) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > 8 * 1024 * 1024 ||
      typeof row.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw refused()
    names.add(row.entry)
    size += row.size
  }
  if (
    size > 33 * 1024 * 1024 ||
    [...names].some((name) =>
      name
        .split('/')
        .slice(0, -1)
        .some((_, i, parts) => names.has(parts.slice(0, i + 1).join('/'))),
    )
  )
    throw refused()
}

export function relativeEntry(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16384 &&
    !value.includes('\0') &&
    value.split('/').length <= 32 &&
    value
      .split('/')
      .every(
        (name) => name.length > 0 && name.length <= 255 && name !== '.' && name !== '..',
      )
  )
}

export function parseManagedReceipt(
  value: unknown,
  root: HostPath,
  entry: string,
  tree: ManagedDirectoryTree,
  previous?: ManagedDirectoryReceipt,
): ManagedDirectoryReceipt {
  const row = value as ManagedDirectoryReceipt | undefined
  if (
    !row ||
    !row.root ||
    !hostPathEquals(row.root, root) ||
    row.entry !== entry ||
    !relativeEntry(entry) ||
    (['device', 'inode', 'rootDevice', 'rootInode'] as const).some(
      (key) => !identityNumber(row[key]),
    ) ||
    !Array.isArray(row.ancestors) ||
    row.ancestors.length !== entry.split('/').length - 1 ||
    (row.ancestors as ManagedDirectoryReceipt['ancestors']).some(
      (part, i) =>
        !part ||
        part.entry !==
          entry
            .split('/')
            .slice(0, i + 1)
            .join('/') ||
        !identityNumber(part.device) ||
        !identityNumber(part.inode),
    ) ||
    JSON.stringify(row.tree) !== JSON.stringify(tree)
  )
    throw uncertain()
  if (
    previous &&
    (row.device !== previous.device ||
      row.inode !== previous.inode ||
      row.rootDevice !== previous.rootDevice ||
      row.rootInode !== previous.rootInode ||
      JSON.stringify(row.ancestors) !== JSON.stringify(previous.ancestors))
  )
    throw uncertain()
  return {
    root,
    entry,
    tree,
    device: row.device,
    inode: row.inode,
    rootDevice: row.rootDevice,
    rootInode: row.rootInode,
    ancestors: (row.ancestors as ManagedDirectoryReceipt['ancestors']).map(
      ({ entry, device, inode }) => ({
        entry,
        device,
        inode,
      }),
    ),
  }
}
export function refused(): ManagedDirectoryError {
  return new ManagedDirectoryError(
    'refused',
    'The managed directory does not match the supplied bounded manifest or exact receipt.',
  )
}
export function uncertain(): ManagedDirectoryError {
  return new ManagedDirectoryError(
    'uncertain',
    'The remote directory operation could not be confirmed. Retain its record and reconcile before retrying.',
  )
}

function identityNumber(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,32}$/.test(value)
}
