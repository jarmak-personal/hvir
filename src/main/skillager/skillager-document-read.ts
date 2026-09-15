import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import type { SkillagerContentSelection } from '../../shared/skillager-content'
import { SKILLAGER_AGENTS } from '../../shared/skillager'
import { SKILLAGER_REVIEW_FILE_BYTES } from '../../shared/skillager-review'
import type { ProjectHost, ProjectFileTransferPort } from '../project-host/project-host'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'

export interface SkillagerDocumentAccess {
  readonly host: Pick<ProjectHost, 'hostId' | 'stat' | 'realpath'> & {
    readonly fileTransfer?: Pick<
      ProjectFileTransferPort,
      'readFileChunks' | 'readFileChunksNoFollow'
    >
  }
  readonly root: HostPath
  readonly assertCurrent: () => void
}
export type SkillagerProjectDocumentAccess = (
  path: HostPath,
) => Promise<SkillagerDocumentAccess>
export interface SkillagerDocumentCliPort {
  documentAccess(
    selection: SkillagerCliSelection,
    source: SkillagerContentSelection,
    signal: AbortSignal,
  ): Promise<SkillagerDocumentAccess>
  validateDocument(
    selection: SkillagerCliSelection,
    source: SkillagerContentSelection,
    workspace: HostPath,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>
}

export function validateSkillagerDocumentSelection(
  selection: SkillagerCliSelection,
  source: SkillagerContentSelection,
  workspace: HostPath,
): void {
  if (
    !['library', 'project-original', 'full', 'stub', 'router'].includes(source.kind) ||
    typeof source.skillId !== 'string' ||
    !source.skillId ||
    (source.agent !== undefined &&
      !SKILLAGER_AGENTS.some((agent) => agent.id === source.agent)) ||
    source.skillId.length > 1024 ||
    source.skillId.includes('\0') ||
    !hostPathEquals(source.path, joinHostPath(source.root, 'SKILL.md')) ||
    (source.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(source.expectedHash)) ||
    (source.expectedHash && !['library', 'project-original'].includes(source.kind))
  )
    throw new SkillagerError('invalid-request', 'The selected skill document is invalid.')
  if (source.kind === 'library') {
    if (
      !selection.library ||
      source.libraryId !== selection.library.id ||
      !hostPathEquals(
        source.root,
        skillagerLibrarySkillRoot(selection.library, source.skillId),
      )
    )
      throw new SkillagerError(
        'library-changed',
        'Reconnect the selected personal library.',
      )
  } else if (
    !containsHostPath(workspace, source.root) ||
    hostPathEquals(workspace, source.root)
  ) {
    throw new SkillagerError(
      'invalid-request',
      'The skill document is outside this project.',
    )
  }
}

/** Bounded ordinary file mechanics; no tree hash, trust, preview or mutation authority. */
export async function readSkillagerDocument(
  access: SkillagerDocumentAccess,
  sourceRoot: HostPath,
  path: HostPath,
  signal: AbortSignal,
  noFollow: boolean,
): Promise<Uint8Array> {
  const { host } = access
  const current = () => {
    signal.throwIfAborted()
    access.assertCurrent()
  }
  current()
  if (host.hostId !== path.hostId || !containsHostPath(sourceRoot, path))
    throw new SkillagerError('invalid-request', 'The file is outside the selected skill.')
  const canonicalRoot = await host.realpath(sourceRoot)
  const canonical = await host.realpath(path)
  if (
    !containsHostPath(access.root, canonicalRoot) ||
    !containsHostPath(canonicalRoot, canonical) ||
    (noFollow &&
      (!hostPathEquals(sourceRoot, canonicalRoot) || !hostPathEquals(path, canonical)))
  )
    throw new SkillagerError(
      'invalid-request',
      'The skill file escapes its reading scope.',
    )
  const transfer = host.fileTransfer
  if (!transfer || (noFollow && !transfer.readFileChunksNoFollow))
    throw new SkillagerError(
      'unavailable',
      'Bounded skill document access is unavailable.',
    )
  const before = await host.stat(canonical)
  if (before.type !== 'file' || before.size > SKILLAGER_REVIEW_FILE_BYTES)
    throw new SkillagerError(
      'output-limit',
      'Skill documents must be regular files of at most 8 MiB.',
    )
  const chunks: Uint8Array[] = []
  let size = 0
  const stream = noFollow
    ? transfer.readFileChunksNoFollow!(canonical, { signal })
    : transfer.readFileChunks(canonical, { signal })
  for await (const chunk of stream) {
    current()
    size += chunk.byteLength
    if (size > SKILLAGER_REVIEW_FILE_BYTES || size > before.size)
      throw new SkillagerError(
        'output-limit',
        'The skill document changed or exceeds 8 MiB.',
      )
    chunks.push(Uint8Array.from(chunk))
  }
  const after = await host.stat(canonical)
  current()
  if (
    !hostPathEquals(await host.realpath(path), canonical) ||
    after.type !== 'file' ||
    size !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.mode !== before.mode
  )
    throw new SkillagerError(
      'stale-review',
      'The current skill file changed while it was read. Open it again.',
    )
  current()
  return Buffer.concat(chunks)
}

/** Automatic images remain descendants of the actual source document, including aliases. */
export async function validateSkillagerDocumentAsset(
  access: SkillagerDocumentAccess,
  document: HostPath,
  asset: HostPath,
  signal: AbortSignal,
): Promise<void> {
  const parent = dirnameHostPath(await access.host.realpath(document))
  const target = await access.host.realpath(asset)
  signal.throwIfAborted()
  access.assertCurrent()
  if (!containsHostPath(parent, target))
    throw new SkillagerError('invalid-request', 'Image escapes its document directory.')
}
