import type { Stat } from '../../shared'
import type { ProjectFileMode } from '../project-host'

export interface VerifiedProjectEntryMetadata {
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly mode: ProjectFileMode
  readonly mtimeSeconds: number
}

export type VerifiedProjectEntryMetadataNormalization =
  | { readonly ok: true; readonly value: VerifiedProjectEntryMetadata }
  | {
      readonly ok: false
      readonly reason: 'unsupported-entry' | 'unusable-metadata'
    }

/** Normalizes the exact metadata contract shared by copy verification and removal. */
export function normalizeVerifiedProjectEntryMetadata(
  stat: Stat,
): VerifiedProjectEntryMetadataNormalization {
  if (stat.type !== 'file' && stat.type !== 'dir') {
    return { ok: false, reason: 'unsupported-entry' }
  }
  if (
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    !Number.isFinite(stat.mtimeMs)
  ) {
    return { ok: false, reason: 'unusable-metadata' }
  }
  return {
    ok: true,
    value: {
      type: stat.type === 'dir' ? 'directory' : 'file',
      size: stat.type === 'file' ? stat.size : 0,
      mode:
        stat.type === 'file' && (stat.mode & 0o111) !== 0
          ? 0o755
          : stat.type === 'file'
            ? 0o644
            : 0o755,
      mtimeSeconds: Math.floor(stat.mtimeMs / 1_000),
    },
  }
}
